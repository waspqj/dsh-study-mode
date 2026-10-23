// 学习知识库 Web UI · 浏览器半侧自测（node test/client.test.mjs）
//
// 本机 profile 里没有装 react（浏览器端由宿主注入），所以这里写了一个最小的
// React 替身：createElement / useState / useEffect / useRef / useCallback / useMemo，
// 加上「跑一遍渲染 → 执行 effect → 等异步 → 状态变了再渲染」的小循环。
// 目的不是替代真浏览器，而是在不重启 DSH 的前提下验证：
//   1. __ModuleLoader__ 的调用契约（id 必须是包名）
//   2. exports 形状（name / inject / apply）
//   3. apply 注册两处，且 panellist.id === main.key
//   4. 首屏 loading → 拉到数据后渲染出主题栏和条目卡片
//   5. 搜索：输入 → 防抖 → 命中渲染
//   6. 归档按钮把 POST 打到 /kb/api/archive，且带 topic + id
//   7. 删除要点两次（归档免确认、删除要确认）

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log('  ok  ' + label)
  } catch (error) {
    console.error('  FAIL ' + label + ': ' + error.message)
    process.exitCode = 1
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 最小 React
function makeReact() {
  const flatten = (list, out = []) => {
    for (const item of list) {
      if (Array.isArray(item)) flatten(item, out)
      else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
    }
    return out
  }

  // 每个组件实例一个 hook 帧：不能全局共用一个数组 —— 组件挂载/卸载会让
  // 光标错位，A 组件的 useState 会被 B 组件读到（真实 React 里靠 fiber 隔离）。
  const frames = new Map()
  const instanceCounts = new Map()
  let currentFrame = null
  let dirty = false
  let pending = []
  let expanded = null

  function enterFrame(id) {
    let frame = frames.get(id)
    if (!frame) {
      frame = { values: [], deps: [], cleanup: [], cursor: 0 }
      frames.set(id, frame)
    }
    frame.cursor = 0
    const previous = currentFrame
    currentFrame = frame
    return () => {
      currentFrame = previous
    }
  }

  const slot = () => {
    if (!currentFrame) throw new Error('hook 在组件外被调用')
    return currentFrame.cursor++
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flatten(children) }
    },
    useState(initial) {
      const frame = currentFrame
      const index = slot()
      if (!(index in frame.values)) {
        frame.values[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(frame.values[index]) : next
        if (!Object.is(value, frame.values[index])) {
          frame.values[index] = value
          dirty = true
        }
      }
      return [frame.values[index], set]
    },
    useRef(initial) {
      const frame = currentFrame
      const index = slot()
      if (!(index in frame.values)) frame.values[index] = { current: initial }
      return frame.values[index]
    },
    useCallback(fn) {
      slot()
      return fn
    },
    useMemo(factory) {
      slot()
      return factory()
    },
    useEffect(fn, deps) {
      const frame = currentFrame
      const index = slot()
      const previous = frame.deps[index]
      const changed =
        !previous ||
        !deps ||
        previous.length !== deps.length ||
        deps.some((dep, position) => !Object.is(dep, previous[position]))
      if (changed) {
        frame.deps[index] = deps
        pending.push({ frame, index, fn })
      }
    },
  }

  function reset() {
    instanceCounts.clear()
    dirty = false
    pending = []
  }

  function expand(node) {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(expand).filter((item) => item !== null)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anonymous'
      const ordinal = instanceCounts.get(name) || 0
      instanceCounts.set(name, ordinal + 1)
      const props = { ...node.props, children: node.children.length === 1 ? node.children[0] : node.children }
      const restore = enterFrame(name + '#' + ordinal)
      try {
        return expand(node.type(props))
      } finally {
        restore()
      }
    }
    return { tag: node.type, props: node.props, children: expand(node.children) }
  }

  function stringify(node) {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(stringify).join('')
    const attrs = [
      'className',
      'title',
      'placeholder',
      'value',
      'type',
      'id',
      'width',
      'height',
      'viewBox',
      'fill',
      'stroke',
      'disabled',
    ]
      .filter((key) => node.props[key] !== undefined && node.props[key] !== '' && node.props[key] !== false)
      .map((key) => `${key}=${JSON.stringify(node.props[key])}`)
      .join(' ')
    return `<${node.tag}${attrs ? ' ' + attrs : ''}>${stringify(node.children)}</${node.tag}>`
  }

  /** 跑一轮渲染 + effect，状态变了就再来一轮（最多 12 轮） */
  async function run(component, props = {}) {
    for (let pass = 0; pass < 12; pass++) {
      reset()
      expanded = expand(React.createElement(component, props))
      const jobs = pending
      pending = []
      for (const job of jobs) {
        const previous = job.frame.cleanup[job.index]
        if (typeof previous === 'function') previous()
        const cleanup = job.fn()
        job.frame.cleanup[job.index] = typeof cleanup === 'function' ? cleanup : null
      }
      await sleep(8)
      if (!dirty) break
    }
    return { html: stringify(expanded), tree: expanded }
  }

  return {
    React,
    run,
    /** 丢掉所有 hook 帧 = 模拟「重新挂载」，用来测初始化状态 */
    forget() {
      frames.clear()
      reset()
      expanded = null
    },
  }
}

/** 深度优先找第一个满足条件的元素 */
function find(node, predicate) {
  if (!node || typeof node === 'string') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.children, predicate)
}

/** 深度优先找全部满足条件的元素 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

/** 元素内的纯文本（展开后的 children 是数组，要递归拼） */
function textOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** 按文本找按钮 */
function findButton(node, text) {
  return find(node, (item) => item.tag === 'button' && textOf(item).trim() === text)
}

// 按钮文字带条数（「同意，出卡片预览 2 条」）时按前缀找
function findButtonByPrefix(node, prefix) {
  return find(node, (item) => item.tag === 'button' && textOf(item).trim().startsWith(prefix))
}

// ---------------------------------------------------------------- 载入 bundle
const { React, run, forget } = makeReact()
const clientPath = path.resolve(import.meta.dirname, '../client/index.js')
const source = fs.readFileSync(clientPath, 'utf8')

let loaded = null
const calls = []
const fixtures = {
  overview: {
    root: '/tmp/learn',
    defaultTopic: 'mysql-进阶',
    total: 2,
    activeTotal: 1,
    archivedTotal: 1,
    topics: [
      {
        slug: 'mysql-进阶',
        name: 'MySQL 进阶',
        description: 'MVCC / 索引 / 事务',
        keywords: [],
        count: 2,
        activeCount: 1,
        archivedCount: 1,
        updatedAt: '2026-10-22T10:00:00.000Z',
      },
    ],
  },
  entries: {
    topic: 'all',
    status: 'active',
    total: 1,
    brokenLines: 0,
    entries: [
      {
        id: 'k_1',
        topic: 'mysql-进阶',
        topicName: 'MySQL 进阶',
        kind: 'qa',
        status: 'active',
        title: 'ReadView 的四个字段',
        q: 'ReadView 有哪些字段？',
        body: 'm_ids / min_trx_id / max_trx_id / creator_trx_id。',
        tags: ['MVCC', '事务'],
        source: { type: 'user', ref: '手动录入' },
        verified: true,
        appliesTo: null,
        version: 3,
        createdAt: null,
        updatedAt: '2026-10-22T10:00:00.000Z',
        archivedAt: null,
      },
    ],
  },
  search: {
    q: 'ReadView',
    scope: 'all',
    poolSize: 1,
    hits: [
      {
        id: 'k_1',
        topic: 'mysql-进阶',
        topicName: 'MySQL 进阶',
        kind: 'qa',
        title: 'ReadView 的四个字段',
        q: 'ReadView 有哪些字段？',
        body: 'm_ids / min_trx_id / max_trx_id / creator_trx_id。',
        tags: ['MVCC'],
        source: null,
        verified: true,
        appliesTo: null,
        version: 3,
        updatedAt: '2026-10-22T10:00:00.000Z',
        score: 7.25,
        coverage: 1,
        strength: 'strong',
        matched: ['readview'],
      },
    ],
  },
}

const okJson = (data) => ({ ok: true, status: 200, json: async () => data })

/** /entries 返回的列表：用例可以换成「正文被截断」的版本（审计 P1-8） */
let currentEntries = null
/** /entry 返回的正文全文 */
let currentFullBody = '完整正文：' + '细节'.repeat(120)

/** AI 校验返回的问题列表：默认一条，用例可以改。 */
let currentIssues = [{ text: 'TCP 首部长度写反了：固定 20 字节，可变 20~60 字节' }]
let currentAdditions = []
let currentSuggested = ''
let currentParseError = false
/** /card/model 返回的模型名：缓存用例要让「会话模型」和校验结果里的模型一致 */
let currentModel = 'deepseek-flash'
/** /card/versions 返回的「库里现在版本」：用来测过期卡片 */
let currentStoreVersion = 2
/** /ai-model 的设置：模型选择器用例会改它 */
let currentAiModel = { mode: 'session', provider: null, model: null, reasoningEffort: null }
const reviewIssues = () => currentIssues

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(meta) {
        loaded = meta
        loaded.exports = meta.factory((name) => {
          if (name === 'react') return React
          throw new Error('bundle 只应 require react，实际 require 了 ' + name)
        })
      },
    },
  },
  document: undefined,
  fetch: async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined,
    })
    const route = String(url).split('?')[0]
    if (route.endsWith('/overview')) return okJson(fixtures.overview)
    if (route.endsWith('/entries')) return okJson(currentEntries || fixtures.entries)
    // 插件 AI 模型设置 + 可选模型目录（GET 读、POST 存）
    if (route.endsWith('/ai-model')) {
      if (String(options.method || 'GET').toUpperCase() === 'POST') {
        const body = options.body ? JSON.parse(options.body) : {}
        currentAiModel = (body && body.aiModel) || { mode: 'session' }
        return okJson({ ok: true, aiModel: currentAiModel })
      }
      return okJson({
        ok: true,
        aiModel: currentAiModel,
        session: { provider: 'deepseek-official', model: currentModel, reasoningEffort: 'high' },
        active:
          currentAiModel.mode === 'fixed'
            ? { ...currentAiModel, source: 'plugin' }
            : { provider: 'deepseek-official', model: currentModel, reasoningEffort: 'high', source: 'session' },
        catalog: [
          {
            provider: 'deepseek-official',
            providerName: 'DeepSeek 官方',
            id: 'deepseek-flash',
            name: 'deepseek-flash',
            contextWindow: 128000,
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
          {
            provider: 'minimax',
            providerName: 'MiniMax 官方',
            id: 'MiniMax-M3.1-Flash',
            name: 'MiniMax-M3.1-Flash',
            contextWindow: 1000000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      })
    }
    // 单条详情：列表只给摘要，正文全文在这里取（审计 P1-8）
    if (route.endsWith('/entry')) {
      const id = String(new URL(url, 'http://127.0.0.1').searchParams.get('id') || '')
      const base = (currentEntries || fixtures.entries).entries.find(item => item.id === id)
      if (!base) return okJson({ ok: true, entry: null })
      return okJson({
        ok: true,
        entry: { ...base, body: currentFullBody, bodyTruncated: false, bodyLength: currentFullBody.length },
      })
    }
    if (route.endsWith('/search')) return okJson(fixtures.search)
    // 提议「同意」：宿主按 proposalId 生成正文并给出待写入批次
    if (route.endsWith('/propose/accept')) {
      return okJson({ ok: true, batchId: 'b_prop', cards: [{ title: 'RAII 资源管理', body: 'RAII 把资源生命周期绑到对象上。' }] })
    }
    // 打开校验面板时先问「会用哪个模型」，好在标题旁边标出来
    if (route.endsWith('/card/model')) {
      return okJson({ ok: true, provider: 'deepseek-official', model: currentModel, source: 'session' })
    }
    // AI 校验的结果按用例可调：默认报一条问题，用例可以清空来测「无异议」
    if (route.endsWith('/card/review')) {
      return okJson({
        ok: true,
        issues: reviewIssues(),
        additions: currentAdditions,
        suggested: currentSuggested,
        parseError: currentParseError,
        rawPreview: currentParseError ? '这张卡看起来没什么问题，我就不列 JSON 了' : '',
        attempts: currentParseError ? 2 : 1,
        model: 'fake',
        usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
      })
    }
    if (route.endsWith('/card/ask')) {
      return okJson({
        ok: true,
        answer: '这是回答',
        usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
      })
    }
    if (route.endsWith('/card/apply')) {
      return okJson({ ok: true, version: 9, body: '写回后的正文。\n- 新要点', verifyReset: false })
    }
    // 库里现在的版本：用例可调（默认与卡片一致 = 不过期）
    if (route.endsWith('/card/versions')) {
      const ids = String(new URL(url, 'http://127.0.0.1').searchParams.get('ids') || '').split(',').filter(Boolean)
      const versions = {}
      for (const id of ids) versions[id] = { version: currentStoreVersion, updatedAt: null }
      return okJson({ ok: true, versions })
    }
    return okJson({ ok: true, plan: [{ action: 'create' }], similar: [] })
  },
  setTimeout,
  clearTimeout,
  AbortController,
  URLSearchParams,
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
new vm.Script(source, { filename: clientPath }).runInContext(sandbox)

const api = loaded && loaded.exports

console.log('bundle 契约')
await check('通过 __ModuleLoader__.load 注册，id 是包名', async () => {
  assert.ok(loaded, '__ModuleLoader__.load 没被调用')
  assert.equal(loaded.id, 'dsh-study-mode')
  assert.equal(typeof loaded.factory, 'function')
})

await check('exports 形状：name / inject / apply', async () => {
  assert.equal(api.name, 'learning-kb-ui')
  assert.deepEqual([...api.inject], ['slots', 'locale']) // 跨 vm realm，摊平成本 realm 的数组
  assert.equal(typeof api.apply, 'function')
})

// ---------------------------------------------------------------- apply 注册
const dictionaries = new Map()
const registrations = []
const definitions = []
const injected = []
const fakeCtx = {
  effects: [],
  effect(fn, label) {
    const disposer = fn()
    fakeCtx.effects.push({ label, disposer })
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  locale: {
    register(ns, dicts) {
      dictionaries.set(ns, dicts)
      return () => {}
    },
    bind(ns) {
      const dicts = dictionaries.get(ns)
      return (key) => {
        if (!dicts) return key
        const zh = dicts.zh || {}
        return zh[key] !== undefined ? zh[key] : key
      }
    },
  },
  get(name) {
    // 真实时序：apply() 跑的时候 ui-conversation 可能还没 provide 这个服务。
    // Cordis 的 ctx.get 是「不管 inject 直接读服务表」，服务没被 provide 就是
    // undefined —— 旧代码在这里静默跳过注册，卡片永远不出现。这里如实模拟。
    return undefined
  },
  inject(deps, callback) {
    injected.push([...deps])
    callback({
      uiConversation: {
        events: {
          register(definition) {
            definitions.push(definition)
            return () => {}
          },
        },
      },
    })
    return () => {}
  },
  slots: {
    inject(name, callback) {
      registrations.push({ slot: name, registration: callback() })
      return () => {}
    },
    register(options, Component) {
      return { options, Component }
    },
  },
}

await check('apply 注册 main、sidebar.panellist、三个工具卡片视图与回答下方的卡片条', async () => {
  api.apply(fakeCtx)
  assert.equal(registrations.length, 6)
  assert.deepEqual(
    registrations.map((item) => item.slot),
    [
      'main',
      'sidebar.panellist',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'conversation.chat.turnTail',
    ],
  )
  assert.equal(
    registrations.find((item) => item.slot === 'conversation.chat.turnTail').registration.options.id,
    'learning-kb',
    'turnTail 要用自己的 id，复用别人的 id 会占掉别人的格子',
  )
  const toolKeys = registrations
    .filter((item) => item.slot === 'tool.call.toolview')
    .map((item) => item.registration.options.key)
    .sort()
  assert.deepEqual(
    toolKeys,
    ['learn_entries', 'learn_save', 'learn_search'],
    '三个会带卡片的工具都要注册自己的卡片视图',
  )
})

await check('apply 时 uiConversation 还没 provide：改用 ctx.inject 挂起，就绪后再注册定义', async () => {
  assert.ok(injected.length > 0, '没走 ctx.inject：拿不到 uiConversation 时会把注册整个跳过')
  assert.deepEqual(injected.at(-1), ['uiConversation'])
  assert.ok(
    definitions.some((item) => item.kind === 'kb-cards'),
    '服务就绪后没有注册 kb-cards 定义',
  )
})

await check('拿不到 uiConversation 也没有 ctx.inject：不抛错，其余六格照常注册', async () => {
  const only = []
  const bare = {
    effect: () => () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
    slots: {
      inject(name, callback) {
        only.push(name)
        callback()
        return () => {}
      },
      register: () => ({}),
    },
  }
  api.apply(bare)
  assert.equal(only.length, 6, '缺了这个服务只该少一张卡片条，不该让插件加载不出来')
  assert.deepEqual(only, [
    'main',
    'sidebar.panellist',
    'tool.call.toolview',
    'tool.call.toolview',
    'tool.call.toolview',
    'conversation.chat.turnTail',
  ])
})

const mainRegistration = registrations.find((item) => item.slot === 'main').registration
const iconRegistration = registrations.find((item) => item.slot === 'sidebar.panellist').registration

await check('两处用同一个 id：panellist.id === main.key', async () => {
  assert.equal(mainRegistration.options.name, 'main')
  assert.equal(iconRegistration.options.name, 'sidebar.panellist')
  assert.equal(mainRegistration.options.key, iconRegistration.options.id)
  assert.equal(mainRegistration.options.key, 'learning-kb')
})

await check('侧边栏有排位与本地化标题', async () => {
  assert.equal(iconRegistration.options.order, 30)
  assert.equal(typeof iconRegistration.options.label, 'function')
  assert.equal(iconRegistration.options.label(), '学习知识库')
})

await check('词典注册挂在 ctx.effect 上（热重载才收得回去）', async () => {
  const entry = fakeCtx.effects.find((item) => String(item.label || '').includes('dictionaries'))
  assert.ok(entry, '没有走 ctx.effect 注册词典：热重载后第二次 apply 会抛 locale already has zh')
  assert.equal(typeof entry.disposer, 'function', 'effect 回调没有返回回收函数')
})

await check('注册了 zh / en 两套词典', async () => {
  const dicts = dictionaries.get('learning-kb')
  assert.ok(dicts, '没有注册 learning-kb 词典')
  assert.equal(dicts.zh.title, '学习知识库')
  assert.equal(dicts.en.title, 'Knowledge Base')
  for (const value of Object.values(dicts.zh)) {
    assert.equal(typeof value, 'string', '词典值必须是字符串（locale 不支持函数）')
  }
})

await check('侧边栏图标渲染为 svg，尺寸跟随 size', async () => {
  const { html } = await run(iconRegistration.Component, { size: 18, active: false })
  assert.match(html, /^<svg/)
  assert.match(html, /width=18/)
  const { html: large } = await run(iconRegistration.Component, { size: 24 })
  assert.match(large, /width=24/)
})

// ---------------------------------------------------------------- 首屏数据
const Panel = mainRegistration.Component

console.log('首屏与数据')
await check('拉取总览与条目列表', async () => {
  calls.length = 0
  const { html } = await run(Panel, {})
  const urls = calls.map((call) => call.url)
  assert.ok(urls.some((url) => url.includes('/kb/api/overview')), '没有请求 overview')
  assert.ok(urls.some((url) => url.includes('/kb/api/entries')), '没有请求 entries')
  assert.match(html, /学习知识库/)
  assert.match(html, /1 条 · 1 个主题/)
  assert.match(html, /MySQL 进阶/)
  assert.match(html, /全部主题/)
  assert.match(html, /UI \d+\.\d+\.\d+/, '标题栏应渲染 UI 版本标记')
})

await check('渲染出条目卡片：标题 / 类型 / 问题 / 正文 / 标签 / 版本', async () => {
  const { html } = await run(Panel, {})
  assert.match(html, /ReadView 的四个字段/)
  assert.match(html, />问答</)
  assert.match(html, /Q ReadView 有哪些字段？/)
  assert.match(html, /creator_trx_id/)
  assert.match(html, /MVCC/)
  assert.match(html, /v3/)
  assert.ok(!html.includes('未核实'), '这条已核实，不该出现「未核实」角标')
})

await check('未核实条目才出现「未核实」角标', async () => {
  fixtures.entries.entries[0].verified = false
  const { html } = await run(Panel, {})
  assert.match(html, /未核实/)
  fixtures.entries.entries[0].verified = true
  await run(Panel, {})
})

console.log('搜索')
await check('输入关键词 → 防抖 → 打到 /search 并渲染命中分', async () => {
  const first = await run(Panel, {})
  const input = find(
    first.tree,
    (node) => node.tag === 'input' && String(node.props.placeholder || '').includes('搜索关键词'),
  )
  assert.ok(input, '找不到搜索框')
  calls.length = 0
  input.props.onChange({ target: { value: 'ReadView' } })
  await run(Panel, {}) // 先渲染一帧：清掉旧定时器、按新 query 重新计时
  await sleep(320) // 等过 260ms 防抖，debounced 才变成 ReadView
  calls.length = 0
  const second = await run(Panel, {}) // 这一帧才会真的发 /search
  const searchCall = calls.find((call) => call.url.includes('/kb/api/search'))
  assert.ok(searchCall, '没有请求 /search')
  assert.match(searchCall.url, /q=ReadView/)
  assert.match(searchCall.url, /topic=all/)
  assert.match(second.html, /命中 1 条（检索池 1 条活跃知识）/)
  assert.match(second.html, /score 7\.25/)
})

await check('清空关键词回到条目列表', async () => {
  const current = await run(Panel, {})
  const input = find(
    current.tree,
    (node) => node.tag === 'input' && String(node.props.placeholder || '').includes('搜索关键词'),
  )
  calls.length = 0
  input.props.onChange({ target: { value: '' } })
  await run(Panel, {})
  await sleep(320)
  calls.length = 0
  const restored = await run(Panel, {})
  assert.ok(
    calls.some((call) => call.url.includes('/kb/api/entries')),
    '没有回到 /entries',
  )
  assert.match(restored.html, />1 条</)
})

console.log('写操作')
await check('点归档 → POST /archive 带 topic + id，且不弹确认', async () => {
  const view = await run(Panel, {})
  const button = findButton(view.tree, '归档')
  assert.ok(button, '找不到归档按钮')
  calls.length = 0
  await button.props.onClick()
  await sleep(20)
  const call = calls.find((item) => item.url.includes('/kb/api/archive'))
  assert.ok(call, '没有请求 /archive')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, { topic: 'mysql-进阶', id: 'k_1' })
  assert.equal(calls.filter((item) => item.url.includes('/archive')).length, 1, '点一次发了两遍')
})

await check('写入成功后提示并刷新数据', async () => {
  calls.length = 0
  const view = await run(Panel, {})
  const button = findButton(view.tree, '归档')
  await button.props.onClick()
  await sleep(30)
  const refreshed = await run(Panel, {})
  assert.ok(
    calls.filter((item) => item.url.includes('/overview')).length >= 1,
    '写后没有刷新 overview',
  )
  assert.ok(
    calls.filter((item) => item.url.includes('/entries')).length >= 1,
    '写后没有刷新 entries',
  )
  assert.match(refreshed.html, /已/) // 提示语
})

await check('删除要确认：第一次点击只变成「确认删除？」，不发请求', async () => {
  calls.length = 0
  const view = await run(Panel, {})
  const button = findButton(view.tree, '删除')
  assert.ok(button, '找不到删除按钮')
  await button.props.onClick()
  await sleep(20)
  assert.equal(calls.filter((item) => item.url.includes('/delete')).length, 0, '第一次点击就删了')
  const confirming = await run(Panel, {})
  assert.match(confirming.html, /确认删除？/)
})

await check('第二次点击才真的 POST /delete', async () => {
  const view = await run(Panel, {})
  const button = findButton(view.tree, '确认删除？')
  assert.ok(button, '找不到确认删除按钮')
  calls.length = 0
  await button.props.onClick()
  await sleep(20)
  const call = calls.find((item) => item.url.includes('/kb/api/delete'))
  assert.ok(call, '没有请求 /delete')
  assert.deepEqual(call.body, { topic: 'mysql-进阶', id: 'k_1' })
})

await check('核实要确认：第一次点击只变成「确认核实？」，不发请求', async () => {
  // 2026-10-24 用户要求：「核实按钮也要可以单独核实，核实需要确认」
  forget()
  const original = fixtures.entries.entries[0].verified
  fixtures.entries.entries[0].verified = false
  try {
    calls.length = 0
    const view = await run(Panel, {})
    const button = findButton(view.tree, '核实')
    assert.ok(button, '找不到单条核实按钮')
    await button.props.onClick()
    await sleep(20)
    assert.equal(
      calls.filter((item) => item.url.includes('/card/verify')).length,
      0,
      '第一次点击就把这条标成已核实了',
    )
    const confirming = await run(Panel, {})
    assert.match(confirming.html, /确认核实？/)
  } finally {
    fixtures.entries.entries[0].verified = original
  }
})

await check('第二次点击才真的 POST /card/verify（单条）', async () => {
  forget()
  const original = fixtures.entries.entries[0].verified
  fixtures.entries.entries[0].verified = false
  try {
    const view = await run(Panel, {})
    const button = findButton(view.tree, '核实')
    assert.ok(button, '找不到单条核实按钮')
    await button.props.onClick()
    await sleep(20)
    const armed = await run(Panel, {})
    const confirm = findButton(armed.tree, '确认核实？')
    assert.ok(confirm, '找不到确认核实按钮')
    calls.length = 0
    await confirm.props.onClick()
    await sleep(20)
    const call = calls.find((item) => item.url.includes('/kb/api/card/verify'))
    assert.ok(call, '没有请求 /card/verify')
    assert.equal(call.body.id, 'k_1')
    assert.equal(call.body.state, 'verified')
    assert.equal(call.body.by, 'user')
  } finally {
    fixtures.entries.entries[0].verified = original
  }
})

console.log('新增表单')
await check('点新增打开表单，含主题 / 类型 / 标题 / 正文 / 标签', async () => {
  const view = await run(Panel, {})
  const button = findButton(view.tree, '新增')
  assert.ok(button, '找不到新增按钮')
  await button.props.onClick()
  const opened = await run(Panel, {})
  assert.match(opened.html, /新增一条知识/)
  assert.match(opened.html, />主题</)
  assert.match(opened.html, /要点 \/ 正文/)
  assert.match(opened.html, /标签（逗号分隔）/)
  assert.match(opened.html, /新建主题（输入名称）/)
})

await check('空表单保存给出可读提示而不是发请求', async () => {
  const view = await run(Panel, {})
  const button = findButton(view.tree, '保存')
  assert.ok(button, '找不到保存按钮')
  calls.length = 0
  await button.props.onClick()
  await sleep(20)
  assert.equal(calls.filter((item) => item.url.includes('/add')).length, 0)
  const after = await run(Panel, {})
  assert.match(after.html, /标题不能为空/)
})

await check('填完标题与正文 → POST /add 带主题、类型、标签', async () => {
  const view = await run(Panel, {})
  const titleInput = find(view.tree, (node) => node.tag === 'input' && node.props.placeholder === '标题')
  const bodyInput = find(view.tree, (node) => node.tag === 'textarea')
  const tagInput = find(
    view.tree,
    (node) => node.tag === 'input' && node.props.placeholder === '标签（逗号分隔）',
  )
  assert.ok(titleInput && bodyInput && tagInput, '表单控件缺失')
  titleInput.props.onChange({ target: { value: '间隙锁的范围' } })
  bodyInput.props.onChange({ target: { value: '只锁间隙，不锁记录本身。' } })
  tagInput.props.onChange({ target: { value: '锁, InnoDB' } })
  const filled = await run(Panel, {})
  const save = findButton(filled.tree, '保存')
  assert.ok(save, '找不到保存按钮')
  calls.length = 0
  await save.props.onClick()
  await sleep(30)
  const call = calls.find((item) => item.url.includes('/kb/api/add'))
  assert.ok(call, '没有请求 /add')
  assert.equal(call.body.topic, 'mysql-进阶')
  assert.equal(call.body.kind, 'point')
  assert.equal(call.body.title, '间隙锁的范围')
  assert.equal(call.body.body, '只锁间隙，不锁记录本身。')
  assert.equal(call.body.tags, '锁, InnoDB')
})


console.log('列表摘要 → 详情取全文（审计 P1-8）')
await check('正文被截断时，详情另取全文（不会拿摘要当正文编辑）', async () => {
  const base = fixtures.entries.entries[0]
  currentEntries = {
    ...fixtures.entries,
    entries: [{ ...base, body: base.body.slice(0, 20) + '…', bodyTruncated: true, bodyLength: 300 }],
  }
  try {
    const view = await run(Panel, {})
    calls.length = 0
    const card = find(view.tree, (node) => node.tag === 'article')
    assert.ok(card, '找不到卡片')
    await card.props.onClick()
    await sleep(30)
    const detailCalls = calls.filter(item => item.url.includes('/entry'))
    assert.equal(detailCalls.length, 1, '应该去取一次详情')
    const opened = await run(Panel, {})
    assert.match(opened.html, /完整正文/, '详情浮层要显示取回来的全文')
    assert.ok(!opened.html.includes('正在取完整正文'), '取回来之后不该还停在加载态')
  } finally {
    currentEntries = null
    // 把面板里的列表拉回原样：别把截断版留给后面的用例
    const restored = await run(Panel, {})
    const refresh = findButton(restored.tree, '刷新')
    if (refresh) {
      await refresh.props.onClick()
      await sleep(20)
    }
  }
})

console.log('两列网格与详情浮层')
await check('卡片排进两列网格容器', async () => {
  const view = await run(Panel, {})
  const grid = find(view.tree, (node) => node.props && node.props.className === 'kb-grid')
  assert.ok(grid, '找不到 .kb-grid 容器')
  assert.ok(find(grid, (node) => node.tag === 'article'), '网格里没有卡片')
})

await check('点卡片打开详情浮层，正文完整显示', async () => {
  const view = await run(Panel, {})
  const card = find(view.tree, (node) => node.tag === 'article')
  assert.ok(card, '找不到卡片')
  await card.props.onClick()
  const opened = await run(Panel, {})
  const overlay = find(opened.tree, (node) => node.props && node.props.className === 'kb-overlay')
  assert.ok(overlay, '浮层没打开')
  assert.match(opened.html, /kb-modal/)
  assert.match(opened.html, /creator_trx_id/)
  assert.ok(findButton(overlay, '关闭'), '浮层缺关闭按钮')
  assert.ok(findButton(overlay, '归档'), '浮层缺归档按钮')
  assert.ok(findButton(overlay, '删除'), '浮层缺删除按钮')
})

await check('点关闭按钮收起浮层', async () => {
  const view = await run(Panel, {})
  const overlay = find(view.tree, (node) => node.props && node.props.className === 'kb-overlay')
  assert.ok(overlay, '浮层应该还开着')
  await findButton(overlay, '关闭').props.onClick()
  const closed = await run(Panel, {})
  assert.ok(
    !find(closed.tree, (node) => node.props && node.props.className === 'kb-overlay'),
    '点关闭没关掉',
  )
})

// 2026-10-23 用户反馈：版本号就是时间戳，界面上又单独显示一块「更新时间」，
// 同一个时间出现两遍（截图上是「面试 · 2026-10-23 15:57 · 2026-10-23 15:57」）。
await check('版本号是时间戳时，卡片和浮层都不再另外显示一块时间', async () => {
  const stamp = Date.UTC(2026, 9, 23, 7, 57) // 版本号（时间戳）
  const updatedAt = '2026-10-22T10:00:00.000Z' // 故意选一个不同的时间，好分辨是哪一个被显示
  const pad = (n) => String(n).padStart(2, '0')
  const shortStamp = (ms) => {
    const date = new Date(ms)
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }
  const versionText = shortStamp(stamp)
  const updatedText = shortStamp(new Date(updatedAt).getTime())

  const original = currentEntries
  currentEntries = { ...fixtures.entries, entries: [{ ...fixtures.entries.entries[0], version: stamp, updatedAt }] }
  try {
    forget() // 重新挂载：不然 /entries 的 effect 不会重跑，拿到的还是旧数据
    let view = await run(Panel, {})
    const card = find(view.tree, (node) => node.tag === 'article')
    assert.ok(card, '找不到卡片')
    const foot = find(card, (node) => node.props && node.props.className === 'kb-card-foot')
    assert.ok(foot, '找不到卡片脚注')
    assert.ok(textOf(foot).includes(versionText), '卡片脚要显示版本号（时间戳）：' + textOf(foot))
    assert.ok(!textOf(foot).includes(updatedText), '同一个时间不该显示两遍：' + textOf(foot))

    // 浮层底栏同理
    await card.props.onClick()
    view = await run(Panel, {})
    const meta = find(view.tree, (node) => node.props && node.props.className === 'kb-modal-foot')
    assert.ok(meta, '浮层没打开或找不到底栏')
    const metaText = textOf(meta)
    assert.ok(metaText.includes(versionText), '浮层要显示版本号（时间戳）：' + metaText)
    assert.ok(!metaText.includes(updatedText), '浮层里同一个时间不该显示两遍：' + metaText)
  } finally {
    currentEntries = original
  }
})

await check('老数据（版本号还是 v2）仍然补一个更新时间', async () => {
  const original = currentEntries
  currentEntries = {
    ...fixtures.entries,
    entries: [{ ...fixtures.entries.entries[0], version: 2, updatedAt: '2026-10-22T10:00:00.000Z' }],
  }
  try {
    forget() // 同上：要重新挂载才会重新拉 /entries
    const view = await run(Panel, {})
    const foot = find(view.tree, (node) => node.props && node.props.className === 'kb-card-foot')
    const text = textOf(foot)
    assert.match(text, /^v2 · /, '老数据的版本号还是 v2，后面才需要补时间：' + text)
  } finally {
    currentEntries = original
  }
})

await check('卡片上的按钮会 stopPropagation，不会连带打开浮层', async () => {
  const view = await run(Panel, {})
  const card = find(view.tree, (node) => node.tag === 'article')
  const archiveButton = find(card, (node) => node.tag === 'button' && textOf(node).trim() === '归档')
  assert.ok(archiveButton, '卡片上没有归档按钮')
  let stopped = 0
  await archiveButton.props.onClick({
    stopPropagation: () => {
      stopped += 1
    },
  })
  assert.equal(stopped, 1, '没有调用 stopPropagation')
  await sleep(20)
  const after = await run(Panel, {})
  assert.ok(
    !find(after.tree, (node) => node.props && node.props.className === 'kb-overlay'),
    '卡片按钮把浮层打开了',
  )
})


console.log('故障兜底')
await check('主体抛错时不消失：仍占住侧边栏并显示错误原文', async () => {
  const broken = source.replace('const h = React.createElement', 'const h = null.boom')
  assert.notEqual(broken, source, '没能把故障注入源码')
  let faultLoaded = null
  const faultSandbox = {
    window: {
      __ModuleLoader__: {
        load(meta) {
          faultLoaded = meta
          faultLoaded.exports = meta.factory((name) => (name === 'react' ? React : null))
        },
      },
    },
    document: undefined,
    fetch: async () => okJson({}),
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    console: { error: () => {}, warn: () => {}, log: () => {} },
  }
  faultSandbox.globalThis = faultSandbox
  vm.createContext(faultSandbox)
  new vm.Script(broken, { filename: 'client/index.js(broken)' }).runInContext(faultSandbox)

  const faultApi = faultLoaded && faultLoaded.exports
  assert.ok(faultApi, '故障时没有导出任何东西')
  assert.equal(faultApi.name, 'learning-kb-ui')
  assert.deepEqual([...faultApi.inject], ['slots'], '故障面板不该再依赖 locale')

  const registrations2 = []
  faultApi.apply({
    slots: {
      inject(name, callback) {
        registrations2.push({ name, registration: callback() })
        return () => {}
      },
      register(options, Component) {
        return { options, Component }
      },
    },
  })
  const panellist2 = registrations2.find((item) => item.name === 'sidebar.panellist')
  assert.ok(panellist2, '故障时侧边栏也没了')
  assert.equal(panellist2.registration.options.id, 'learning-kb')
  assert.equal(panellist2.registration.options.order, 30)
  assert.equal(panellist2.registration.options.label(), '知识库·异常')

  const main2 = registrations2.find((item) => item.name === 'main')
  assert.ok(main2, '故障时主面板没注册')
  assert.equal(main2.registration.options.key, 'learning-kb')
  const { html } = await run(main2.registration.Component, {})
  assert.match(html, /学习知识库加载失败/)
  assert.match(html, /boom/)
})

console.log('热重载回归')
await check('locale 已存在同一语言时不再拖垮整个插件', async () => {
  const collected = []
  const hotCtx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register() {
        // 宿主热重载后第二次 apply 时真实会抛的错，原样模拟
        throw new Error('locale namespace "learning-kb" already has locale "zh"')
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        collected.push({ name, registration: callback() })
        return () => {}
      },
      register(options, Component) {
        return { options, Component }
      },
    },
  }
  api.apply(hotCtx) // 关键：不能抛
  assert.equal(collected.length, 6, '六处注册都要完成')
  const panellist = collected.find((item) => item.name === 'sidebar.panellist').registration
  assert.equal(panellist.options.id, 'learning-kb')
  assert.equal(panellist.options.label(), '学习知识库', '词典注册失败时要回落到中文兜底')
  assert.ok(collected.find((item) => item.name === 'main'), '主面板也要注册上')
})

await check('版本号在脚注左侧，和右下角的操作按钮不重叠', async () => {
  const view = await run(Panel, {})
  const card = find(view.tree, (node) => node.tag === 'article')
  assert.ok(card, '找不到卡片')
  const foot = find(card, (node) => node.props && node.props.className === 'kb-card-foot')
  assert.ok(foot, '找不到卡片脚注')
  const first = foot.children[0]
  assert.ok(first && first.tag === 'span', '脚注第一个元素应是版本号 span')
  assert.match(textOf(first), /^v\d+/, '版本号必须排在最左边')
  assert.ok(!textOf(foot).includes('归档'), '操作按钮不该混进脚注')
  assert.ok(
    find(card, (node) => node.props && node.props.className === 'kb-card-acts'),
    '操作区应独立存在（绝对定位在右下角）',
  )
})

await check('半透明主题 token 会被压平成不透明实色', async () => {
  const setCalls = []
  const previousDocument = sandbox.document
  const previousComputed = sandbox.getComputedStyle
  sandbox.document = {
    body: { appendChild() {} },
    head: null,
    documentElement: { style: { setProperty: (key, value) => setCalls.push([key, value]) } },
    getElementById: () => null,
    createElement: () => ({ style: {}, id: '', textContent: '', parentNode: null }),
  }
  sandbox.getComputedStyle = () => ({ color: 'rgba(40, 44, 52, 0.6)' })
  try {
    api.apply({
      effect(fn) {
        fn()
        return () => {}
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: {
        inject: () => () => {},
        register: (options, Component) => ({ options, Component }),
      },
    })
  } finally {
    sandbox.document = previousDocument
    sandbox.getComputedStyle = previousComputed
  }
  const applied = setCalls.find((item) => item[0] === '--kb-modal-bg')
  assert.ok(applied, '没有设置 --kb-modal-bg：弹窗底色仍会透光')
  // 40/44/52 各 60% 叠在近黑底 (22,23,27) 上 → 33,36,42，且不再带 alpha
  assert.equal(applied[1], 'rgb(33, 36, 42)')
  assert.ok(!applied[1].includes('rgba'), '压平后不应再是 rgba')
})

await check('热重载后旧 <style> 会被刷新成新样式（不是"存在就跳过"）', async () => {
  const inserted = []
  const stale = { id: 'kb-style', textContent: '/* 上一版样式 */', parentNode: null }
  const previousDocument = sandbox.document
  const previousComputed = sandbox.getComputedStyle
  sandbox.document = {
    body: { appendChild() {} },
    head: { appendChild: (node) => inserted.push(node) },
    documentElement: { style: { setProperty() {} } },
    getElementById: (id) => (id === 'kb-style' ? stale : null),
    createElement: () => ({ style: {}, id: '', textContent: '', parentNode: null }),
  }
  sandbox.getComputedStyle = () => ({ color: 'rgba(40, 44, 52, 0.6)' })
  try {
    api.apply({
      effect(fn) {
        fn()
        return () => {}
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: { inject: () => () => {}, register: (options, Component) => ({ options, Component }) },
    })
  } finally {
    sandbox.document = previousDocument
    sandbox.getComputedStyle = previousComputed
  }
  assert.equal(inserted.length, 0, '不该重复插入第二个 <style>')
  assert.ok(stale.textContent.includes('.kb-modal'), '旧样式没有被刷新')
  assert.ok(stale.textContent.includes('rgba(0,0,0,.58)'), '回退后的遮罩色没进样式表')
})

console.log('正文解析（极简 Markdown 子集）')
const parseBody = api.parseBody

await check('纯文本 → 一个段落', () => {
  const blocks = parseBody('连接层处理客户端连接：做权限校验、保存连接信息。')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'p')
})

await check('行首 "- " → 列表块', () => {
  const blocks = parseBody('- 第一点\n- 第二点')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'list')
  assert.equal(blocks[0].items.length, 2)
  assert.equal(blocks[0].items[0].marker, '-')
  assert.equal(blocks[0].items[0].runs[0].text, '第一点')
})

await check('行内 ①②③ 连写 → 拆成列表（存量卡片的典型形态）', () => {
  const blocks = parseBody('①修饰局部变量：作用域不变。②修饰全局变量：内部链接。③修饰函数：隐藏实现。')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'list')
  assert.equal(blocks[0].items.length, 3)
  assert.equal(blocks[0].items[0].marker, '①')
  assert.ok(blocks[0].items[0].runs[0].text.includes('修饰局部变量'))
  assert.ok(blocks[0].items[2].runs[0].text.includes('修饰函数'))
})

await check('数字枚举连号才拆，不连号当普通段落', () => {
  const seq = parseBody('1. 先建表 2. 再插数据 3. 最后建索引')
  assert.equal(seq[0].type, 'list')
  assert.equal(seq[0].items.length, 3)
  const notSeq = parseBody('见 1. 章节 5. 小节')
  assert.equal(notSeq[0].type, 'p')
})

await check('**粗体** → 加粗 run', () => {
  const blocks = parseBody('这里的 **ReadView** 很关键')
  assert.ok(blocks[0].runs.some((run) => run.bold && run.text === 'ReadView'))
})

await check('`代码` → code run，代码里的星号不当粗体', () => {
  const blocks = parseBody('执行 `git **push**` 即可')
  const code = blocks[0].runs.find((run) => run.code)
  assert.ok(code, '没认出代码段')
  assert.equal(code.text, 'git **push**')
  assert.ok(!blocks[0].runs.some((run) => run.bold))
})

await check('> 引用 → quote 块', () => {
  const blocks = parseBody('> 这是提醒')
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].runs[0].text, '这是提醒')
})

await check('【高亮】 → 高亮 run', () => {
  const blocks = parseBody('注意【必须加锁】否则会幻读')
  assert.ok(blocks[0].runs.some((run) => run.hl && run.text === '必须加锁'))
})

await check('版本号 8.0 不会被当成枚举', () => {
  const blocks = parseBody('MySQL 8.0 的架构分四层')
  assert.equal(blocks[0].type, 'p')
  assert.equal(blocks[0].runs[0].text, 'MySQL 8.0 的架构分四层')
})

await check('单个不在段首的 ① 不拆（避免误判）', () => {
  const blocks = parseBody('参见①这条的说明')
  assert.equal(blocks[0].type, 'p')
})

await check('空正文 → 空数组', () => {
  assert.equal(parseBody('').length, 0)
  assert.equal(parseBody(null).length, 0)
})

await check('空行分段', () => {
  const blocks = parseBody('第一段\n\n第二段')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'p')
  assert.equal(blocks[1].type, 'p')
})

await check('行首术语自动加粗（不改数据）', () => {
  const blocks = parseBody('大端存储：数据低位存到内存高地址。')
  assert.ok(blocks[0].runs[0].bold, '术语没被加粗')
  assert.equal(blocks[0].runs[0].text, '大端存储')
})

await check('长术语不加粗（避免整句变粗）', () => {
  const blocks = parseBody('连接层处理客户端连接的完整职责：权限校验。')
  assert.ok(!blocks[0].runs.some((run) => run.bold), '长短语不该被当成术语')
})

await check('已经用 ** 加粗的不重复处理', () => {
  const blocks = parseBody('**优点**：A 比 B 快。')
  assert.equal(blocks[0].runs[0].text, '优点')
  assert.ok(blocks[0].runs[0].bold)
})

await check('列表项里的术语也加粗', () => {
  const blocks = parseBody('- 优点：A 快\n- 缺点：B 慢。')
  assert.equal(blocks[0].type, 'list')
  const second = blocks[0].items[1]
  assert.ok(second.runs[0].bold, '列表项里的术语没加粗')
  assert.equal(second.runs[0].text, '缺点')
})

console.log('正文编辑用纯文本（标记只在渲染层生效）')
const toPlainBody = api.toPlainBody
const mergeMarkup = api.mergeMarkup

await check('去标记：**粗体** / `代码` / 【高亮】 / > 引用都只剩文字', () => {
  assert.equal(toPlainBody('`MySQL 8.0` 分四层。'), 'MySQL 8.0 分四层。')
  assert.equal(toPlainBody('- **连接层**：权限校验'), '- 连接层：权限校验')
  assert.equal(toPlainBody('注意【必须加锁】否则会幻读'), '注意必须加锁否则会幻读')
  assert.equal(toPlainBody('> 提醒一句'), '提醒一句')
  // 落单的标记也要抹掉，别留在框里难看
  assert.equal(toPlainBody('半个 ` 反引号'), '半个  反引号')
})

await check('去标记保留行首 "- "：列表本身要看得见', () => {
  const plain = toPlainBody('结论。\n- 要点一\n- 要点二')
  assert.equal(plain, '结论。\n- 要点一\n- 要点二')
})

await check('纯文本正文原样返回，不做任何改写', () => {
  const text = '连接层处理客户端连接：权限校验。\n- 保存连接信息'
  assert.equal(toPlainBody(text), text)
  assert.equal(mergeMarkup(text, text), text)
})

await check('只看不改 → 写回时保留原标记（不会把已有加粗洗掉）', () => {
  const raw = '`MySQL 8.0` 分四层。\n- **连接层**：权限校验\n- 服务层：解析 SQL'
  const shown = toPlainBody(raw)
  assert.equal(mergeMarkup(raw, shown), raw)
})

await check('追加一条要点 → 新行是纯文本，老行的标记还在', () => {
  const raw = '分四层。\n- **连接层**：权限校验'
  const edited = toPlainBody(raw) + '\n- 新增要点：文件系统层'
  const merged = mergeMarkup(raw, edited)
  assert.ok(merged.includes('- **连接层**：权限校验'), '没改动的行要保留原标记：' + merged)
  assert.ok(merged.includes('- 新增要点：文件系统层'), '新加的行按纯文本写：' + merged)
})

await check('改过的那一行按纯文本写（不猜用户想加什么标记）', () => {
  const raw = '分四层。\n- **连接层**：权限校验'
  const merged = mergeMarkup(raw, '分四层。\n- 连接层：权限校验 + 管理服务')
  assert.ok(merged.includes('- 连接层：权限校验 + 管理服务'), merged)
  assert.ok(!merged.includes('**'), '改过的行不该凭空冒出标记：' + merged)
})

console.log('校验结果缓存（同一张卡别重复调模型）')
const reviewCacheKey = api.reviewCacheKey
const reviewCacheGet = api.reviewCacheGet
const reviewCacheSet = api.reviewCacheSet
const reviewCacheClear = api.reviewCacheClear
const cacheCard = { id: 'k_c', topic: 'mysql-进阶', version: 3, body: '结论。\n- 要点' }

await check('缓存键区分卡片 / 模式 / 版本 / 正文', () => {
  const base = reviewCacheKey(cacheCard, 'both')
  assert.notEqual(base, reviewCacheKey({ ...cacheCard, id: 'k_other' }, 'both'))
  assert.notEqual(base, reviewCacheKey({ ...cacheCard, topic: '面试' }, 'both'))
  assert.notEqual(base, reviewCacheKey(cacheCard, 'verify'))
  assert.notEqual(base, reviewCacheKey({ ...cacheCard, version: 4 }, 'both'))
  assert.notEqual(base, reviewCacheKey({ ...cacheCard, body: '结论。\n- 改过的要点' }, 'both'), '正文变了必须换 key')
  assert.equal(base, reviewCacheKey({ ...cacheCard }, 'both'), '同样的卡同样的模式 → 同一个 key')
})

await check('存进去能取出来；失败 / 解析失败不进缓存', () => {
  reviewCacheClear()
  assert.equal(reviewCacheGet(cacheCard, 'both', ''), null)
  const data = { ok: true, issues: [], additions: [], suggested: '', model: 'fake' }
  reviewCacheSet(cacheCard, 'both', data)
  assert.equal(reviewCacheGet(cacheCard, 'both', ''), data)
  assert.equal(reviewCacheGet(cacheCard, 'verify', ''), null, '模式不同不能串用')
  reviewCacheSet(cacheCard, 'verify', { ok: false })
  assert.equal(reviewCacheGet(cacheCard, 'verify', ''), null, '失败结果不能缓存')
  reviewCacheSet(cacheCard, 'verify', { ok: true, parseError: true })
  assert.equal(reviewCacheGet(cacheCard, 'verify', ''), null, '解析失败必须下次真的重试')
  reviewCacheClear()
})

await check('换过模型就不复用旧结果（要跟当前会话对齐）', () => {
  reviewCacheClear()
  const data = { ok: true, issues: [], additions: [], suggested: '', model: 'model-a' }
  reviewCacheSet(cacheCard, 'both', data)
  assert.equal(reviewCacheGet(cacheCard, 'both', 'model-a'), data, '同一个模型 → 命中')
  assert.equal(reviewCacheGet(cacheCard, 'both', 'model-b'), null, '换了模型 → 当作没有缓存')
  reviewCacheClear()
})

await check('卡片只显示第一块作摘要，其余用省略号收尾', async () => {
  const original = fixtures.entries.entries[0].body
  fixtures.entries.entries[0].body = '第一段结论。\n- 要点一\n- 要点二'
  const { html } = await run(Panel, {})
  assert.ok(html.includes('第一段结论'), '摘要里没有第一段')
  assert.ok(!html.includes('要点一'), '卡片不该把列表全展开')
  assert.ok(html.includes('…'), '后面还有内容却没收尾')
  fixtures.entries.entries[0].body = original
})

console.log('会话内卡片（工具结果）')
const toolViews = registrations.filter((item) => item.slot === 'tool.call.toolview')
const cardBlock = {
  kind: 'tool-result',
  meta: {
    kbCards: [
      {
        id: 'k_1',
        title: '间隙锁',
        body: '间隙锁锁住索引记录之间的间隙。\n- 只在 RR 下生效',
        topic: 'mysql-进阶',
        topicName: 'MySQL 进阶',
        tags: ['lock'],
        verified: false,
        version: 2,
      },
      {
        id: 'k_2',
        title: 'MVCC 多版本',
        body: '多版本并发控制，读不加锁。',
        topic: 'mysql-进阶',
        topicName: 'MySQL 进阶',
        tags: [],
        verified: true,
        version: 1,
      },
    ],
  },
  call: { name: 'learn_search', argsRaw: JSON.stringify({ query: '间隙锁' }) },
}

await check('工具行只给一行摘要，不再渲染卡片（卡片在回答下方）', async () => {
  assert.equal(toolViews.length, 3)
  const Cards = toolViews.find((item) => item.registration.options.key === 'learn_search').registration.Component
  const view = await run(Cards, { block: cardBlock, phase: 'result', toolName: 'learn_search' })
  assert.match(view.html, /知识库命中 2 条/)
  assert.equal(
    find(view.tree, (node) => node.props && node.props.className === 'kb-chat-card'),
    null,
    '过程组里不该再出现卡片：答完那一组会被隐藏，而且会和下方重复',
  )
  assert.equal(findButton(view.tree, 'AI 校验补充'), null, '过程组里不该再有卡片动作')
})

await check('运行中的工具调用显示一行提示，不渲染卡片', async () => {
  const Cards = toolViews.find((item) => item.registration.options.key === 'learn_search').registration.Component
  const view = await run(Cards, { block: { phase: 'start', name: 'learn_search' }, phase: 'start', toolName: 'learn_search' })
  assert.match(view.html, /正在检索知识库/)
  assert.equal(find(view.tree, (node) => node.props && node.props.className === 'kb-chat-card'), null)
})

await check('没命中时给一句说明，不是空白', async () => {
  const Cards = toolViews.find((item) => item.registration.options.key === 'learn_search').registration.Component
  const view = await run(Cards, {
    block: { kind: 'tool-result', meta: { kbCards: [] }, call: { name: 'learn_search', argsRaw: '{}' } },
    phase: 'result',
    toolName: 'learn_search',
  })
  assert.match(view.html, /没有命中/)
})

await check('写入的工具行按角色说（本次新增 N 条（未写入））', async () => {
  const Cards = toolViews.find((item) => item.registration.options.key === 'learn_save').registration.Component
  const view = await run(Cards, {
    block: {
      kind: 'tool-result',
      meta: {
        kbCards: [
          {
            id: null,
            title: '智能指针',
            body: '独占所有权，离开作用域自动释放。',
            topic: 'mysql-进阶',
            topicName: 'MySQL 进阶',
            tags: [],
            verified: false,
            version: 1,
            role: 'new',
            status: 'preview',
          },
        ],
      },
      call: { name: 'learn_save', argsRaw: '{}' },
    },
    phase: 'result',
    toolName: 'learn_save',
  })
  assert.match(view.html, /本次新增 1 条/, '工具行要按角色说，不能一律「卡片 N 条」')
  assert.match(view.html, /未写入/, '预览出来的还没进库，要说清楚')
})

await check('面板顶部有「未核实 N 条」入口（批量核实）', async () => {
  const original = fixtures.entries.entries[0].verified
  fixtures.entries.entries[0].verified = false
  const view = await run(Panel, {})
  const button = findButton(view.tree, '未核实 1 条')
  assert.ok(button, '找不到批量核实的入口')
  fixtures.entries.entries[0].verified = original
})

console.log('回答下方的卡片条（turnTail）')
const turnTailReg = registrations.find((item) => item.slot === 'conversation.chat.turnTail').registration
const turnOf = (entries, endSeq) => ({
  data: { get: (key) => (key === 'kb-cards' ? { entries } : undefined) },
  end: endSeq === undefined ? undefined : { seq: endSeq },
})
const oneCard = {
  id: 'k_1',
  title: '间隙锁',
  body: '间隙锁锁住索引记录之间的间隙。\n- 只在 RR 下生效',
  topic: 'mysql-进阶',
  topicName: 'MySQL 进阶',
  tags: ['lock'],
  verified: false,
  version: 2,
}

await check('注册了 kb-cards Turn Definition（照官方 schedule-created 的路子）', async () => {
  const def = definitions.find((item) => item.kind === 'kb-cards')
  assert.ok(def, '没有注册 kb-cards definition')
  const started = def.match({ type: 'turn/start', data: { turn: 3 } })
  assert.equal(started.id, '3')
  assert.equal(started.role, 'start')
  assert.equal(def.match({ type: 'tool/result', data: { turn: 3 }, surfaceOp: 'other' }), null, '非 append 的旧事件不该计入')
  const updated = def.match({ type: 'tool/result', surfaceOp: 'append', data: { turn: 3 } })
  assert.equal(updated.id, '3')
  assert.equal(updated.role, 'update')
})

await check('Definition 从 tool/result 的 meta.kbCards 收卡片，没有就不变', async () => {
  const def = definitions.find((item) => item.kind === 'kb-cards')
  const state = def.start({}, { event: { data: { turn: 3 } } })
  const withCards = def.update(
    { state },
    { event: { type: 'tool/result', seq: 12, surfaceOp: 'append', data: { meta: { kbCards: [oneCard] } } } },
  )
  assert.equal(withCards.entries.length, 1)
  assert.equal(withCards.entries[0].seq, 12)
  const untouched = def.update(
    { state: withCards },
    { event: { type: 'tool/result', seq: 13, surfaceOp: 'append', data: { meta: {} } } },
  )
  assert.equal(untouched, withCards, '没有卡片的事件不该产生新状态')
  const loc = def.buildLocationData({ state: withCards }, 'turn', undefined)
  assert.equal(loc.kind, 'turn')
  assert.equal(loc.key, 'kb-cards')
  assert.equal(loc.value.entries[0].cards[0].title, '间隙锁')
  assert.equal(def.buildLocationData({ state: withCards }, 'session', undefined), null, '只发布到 turn 作用域')
})

await check('这一轮命中知识库时，回答下方出现一行小预览；点开展开成卡片（带三个动作）', async () => {
  // 2026-10-23 用户：「会话末尾的知识卡片太大了，可以做小当预览，可以点击或者悬停查看」
  const props = { turn: turnOf([{ seq: 12, cards: [oneCard] }], 20), seq: 20 }
  const view = await run(turnTailReg.Component, props)
  assert.match(view.html, /知识库命中 1 条/)
  assert.match(view.html, /kb-mini-card/, '默认应该是一行小预览')
  assert.match(view.html, /间隙锁/)
  assert.ok(!findButton(view.tree, 'AI 校验补充'), '收起态不该占位置放三个动作')
  const mini = find(view.tree, (node) => node.props && String(node.props.className || '').includes('kb-mini-card'))
  assert.ok(mini, '找不到小预览')
  assert.match(mini.props.title, /间隙锁锁住索引记录之间的间隙/, '悬停要能看到正文')
  assert.match(mini.props.title, /只在 RR 下生效/, '悬停要给整段正文，不只是首行（2026-10-23 用户反馈）')
  const titleNode = find(mini, (node) => node.props && node.props.className === 'kb-mini-title')
  assert.ok(titleNode, '标题要单独一行')
  await mini.props.onClick()
  const opened = await run(turnTailReg.Component, props)
  assert.ok(findButton(opened.tree, 'AI 校验补充'), '缺 AI 校验补充')
  assert.ok(findButton(opened.tree, '编辑'), '缺 编辑')
  assert.ok(findButton(opened.tree, '问一下'), '缺 问一下')
  // 点卡片任意位置就能收起来（2026-10-23 用户：不要非得点按钮）
  const head = find(opened.tree, (node) => node.props && node.props.className === 'kb-chat-head')
  assert.ok(head, '找不到卡片头')
  assert.equal(typeof head.props.onClick, 'function', '头部要能点一下就收起')
  await head.props.onClick()
  const collapsed = await run(turnTailReg.Component, props)
  assert.match(collapsed.html, /kb-mini-card/, '点一下头部应该缩回一行预览')
})

await check('这一轮没命中就什么都不渲染', async () => {
  const view = await run(turnTailReg.Component, { turn: turnOf([], 20), seq: 20 })
  assert.equal(view.html.trim(), '')
})

await check('turn 结束之后的结算不计入这一轮', async () => {
  const view = await run(turnTailReg.Component, { turn: turnOf([{ seq: 30, cards: [oneCard] }], 20), seq: 20 })
  assert.equal(view.html.trim(), '')
})

await check('数据形状不对时安静地不渲染（不炸会话）', async () => {
  const noData = await run(turnTailReg.Component, { turn: {}, seq: 20 })
  assert.equal(noData.html.trim(), '')
  const broken = await run(turnTailReg.Component, { turn: { data: { get: () => { throw new Error('boom') } } }, seq: 20 })
  assert.equal(broken.html.trim(), '')
})

// ------------------------------------------------- 相关补充（大模型重排的第二档）
const relatedCard = {
  id: 'k_2',
  title: '缓冲池的 LRU 变体算法',
  body: 'midpoint insertion strategy。\n- 冷热分离',
  topic: 'mysql-进阶',
  topicName: 'MySQL 进阶',
  tags: ['buffer'],
  verified: true,
  version: 1,
}

await check('相关补充卡片排在命中之后，默认收缩不渲染', async () => {
  const view = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard], related: [relatedCard] }], 20),
    seq: 20,
  })
  assert.match(view.html, /知识库命中 1 条/)
  assert.match(view.html, /相关 1 条/)
  assert.match(view.html, /相关知识点 1 条/, '要有可点的折叠标题')
  assert.match(view.html, /间隙锁/, '命中卡片要显示')
  assert.ok(!view.html.includes('缓冲池的 LRU 变体算法'), '相关补充默认不该展开')
})

await check('点一下相关知识点才展开', async () => {
  const props = { turn: turnOf([{ seq: 12, cards: [oneCard], related: [relatedCard] }], 20), seq: 20 }
  const view = await run(turnTailReg.Component, props)
  const toggle = find(view.tree, (item) => item.tag === 'button' && item.props && item.props.className === 'kb-related-head')
  assert.ok(toggle, '找不到「相关知识点」折叠按钮')
  assert.equal(toggle.props['aria-expanded'], 'false', '默认要是收缩状态')
  await toggle.props.onClick()
  const after = await run(turnTailReg.Component, props)
  assert.match(after.html, /缓冲池的 LRU 变体算法/, '点了之后相关卡片要出来')
  const reopened = find(after.tree, (item) => item.tag === 'button' && item.props && item.props.className === 'kb-related-head')
  assert.equal(reopened.props['aria-expanded'], 'true', '展开后 aria-expanded 要变 true')
  assert.match(textOf(reopened), /▾/, '展开后箭头要朝下')
})

await check('相关补充展开后是紧凑列表，不是完整卡片', async () => {
  // 2026-10-23 用户：「related 只是属于同一知识领域，为什么还要放到选中卡片里，
  // 直接放到下面待展开的相关知识里呗」—— 展开后要是完整卡片，用户分不清哪张是答案。
  forget() // 上一条用例把「相关知识点」展开过了，重新挂载回到默认折叠
  const props = { turn: turnOf([{ seq: 12, cards: [oneCard], related: [relatedCard] }], 20), seq: 20 }
  const view = await run(turnTailReg.Component, props)
  await find(view.tree, (item) => item.tag === 'button' && item.props && item.props.className === 'kb-related-head').props.onClick()
  const after = await run(turnTailReg.Component, props)
  const box = find(after.tree, (node) => node.props && node.props.className === 'kb-related')
  assert.ok(box, '找不到相关补充区')
  assert.equal(
    find(box, (node) => node.props && String(node.props.className || '').includes('kb-chat-card')),
    null,
    '相关补充区里不该有完整卡片',
  )
  assert.ok(find(box, (node) => node.props && node.props.className === 'kb-rel-row'), '相关补充要渲染成紧凑一行')
  assert.equal((after.html.match(/kb-chat-card/g) || []).length, 1, '只有命中那张是完整卡片')
})

await check('相关补充点开一行能看到正文，不是只有标题', async () => {
  // 2026-10-23 用户：「那些相关知识点点开后没有卡片，只有文字，那也没有意义」
  // —— 行要保持浅色小行（分得清不是答案），但点开必须是真正文。
  forget()
  const props = { turn: turnOf([{ seq: 12, cards: [oneCard], related: [relatedCard] }], 20) }
  const view = await run(turnTailReg.Component, props)
  await find(view.tree, (item) => item.tag === 'button' && item.props && item.props.className === 'kb-related-head').props.onClick()
  let after = await run(turnTailReg.Component, props)
  const row = find(after.tree, (node) => node.tag === 'button' && node.props && node.props.className === 'kb-rel-row')
  assert.ok(row, '找不到相关补充那一行')
  assert.equal(row.props['aria-expanded'], 'false', '默认不展开')
  assert.ok(!after.html.includes('midpoint insertion strategy'), '没点开时不该铺正文')

  await row.props.onClick()
  after = await run(turnTailReg.Component, props)
  assert.match(after.html, /midpoint insertion strategy/, '点开要看到正文')
  const opened = find(after.tree, (node) => node.tag === 'button' && node.props && node.props.className === 'kb-rel-row')
  assert.equal(opened.props['aria-expanded'], 'true', '点开后 aria-expanded 要变 true')
  assert.match(textOf(opened), /▾/, '点开后箭头要朝下')
  assert.match(after.html, /不是本轮答案/, '要标明它只是参考，不是答案')

  await opened.props.onClick()
  after = await run(turnTailReg.Component, props)
  assert.ok(!after.html.includes('midpoint insertion strategy'), '再点一次要收回去')
})

await check('相关补充条数多时先摆 12 条，多出来的折成「再看 N 条」', async () => {
  // 2026-10-23 用户：相关知识点不限制数量（后端全留），但一次铺几十行会把回答顶走。
  forget()
  const many = Array.from({ length: 15 }, (_, index) => ({
    ...relatedCard,
    id: 'k_r' + index,
    title: '相关条目 ' + (index + 1),
  }))
  const props = { turn: turnOf([{ seq: 12, cards: [oneCard], related: many }], 20) }
  const view = await run(turnTailReg.Component, props)
  await find(view.tree, (item) => item.tag === 'button' && item.props && item.props.className === 'kb-related-head').props.onClick()
  let after = await run(turnTailReg.Component, props)
  const rows = []
  const collect = (node) => {
    if (!node || typeof node === 'string') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.props && node.props.className === 'kb-rel-row') rows.push(node)
    collect(node.children)
  }
  collect(after.tree)
  assert.equal(rows.length, 12, '默认只摆 12 行')
  const more = find(after.tree, (node) => node.tag === 'button' && node.props && node.props.className === 'kb-rel-more')
  assert.ok(more, '要有「再看 N 条」')
  assert.match(textOf(more), /再看 3 条/, '要写清还有几条')

  await more.props.onClick()
  after = await run(turnTailReg.Component, props)
  let expanded = 0
  const count = (node) => {
    if (!node || typeof node === 'string') return
    if (Array.isArray(node)) return node.forEach(count)
    if (node.props && node.props.className === 'kb-rel-row') expanded++
    count(node.children)
  }
  count(after.tree)
  assert.equal(expanded, 15, '点开后 15 行都要出来')
})

await check('只有相关补充没有命中时也要渲染，不能空白', async () => {
  const view = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [], related: [relatedCard] }], 20),
    seq: 20,
  })
  assert.match(view.html, /相关知识点 1 条/)
  assert.ok(!view.html.includes('知识库命中'), '没有命中就不该显示命中计数')
})

await check('Definition 同时收集 kbCards 与 kbRelated', async () => {
  const def = definitions.find((item) => item.kind === 'kb-cards')
  const state = def.start({}, { event: { data: { turn: 3 } } })
  const next = def.update(
    { state },
    {
      event: {
        type: 'tool/result',
        seq: 12,
        surfaceOp: 'append',
        data: { meta: { kbCards: [oneCard], kbRelated: [relatedCard] } },
      },
    },
  )
  assert.equal(next.entries.length, 1)
  assert.equal(next.entries[0].cards.length, 1)
  assert.equal(next.entries[0].related.length, 1)
})

await check('只有 kbRelated 的事件也记一条 entry', async () => {
  const def = definitions.find((item) => item.kind === 'kb-cards')
  const state = def.start({}, { event: { data: { turn: 3 } } })
  const next = def.update(
    { state },
    { event: { type: 'tool/result', seq: 15, surfaceOp: 'append', data: { meta: { kbRelated: [relatedCard] } } } },
  )
  assert.equal(next.entries.length, 1)
  assert.equal(next.entries[0].cards.length, 0)
  assert.equal(next.entries[0].related.length, 1)
})

// ------------------------------------------------- 卡片角色 + 预览先行（批次 2）
console.log('卡片角色与预览先行（2026-10-23 批次 2）')

// 2026-10-23 用户反馈：「选中卡片出现了同一张卡片多次被命中」
// 一轮里的卡片是把所有工具调用的卡片拼起来的：按方向检索四次，
// 同一条可能同时沾几个方向被命中几次。
await check('同一张卡片被多个工具调用命中时，界面上只出现一次', async () => {
  const many = [{ seq: 11, cards: [oneCard] }, { seq: 12, cards: [oneCard] }, { seq: 13, cards: [oneCard] }]
  const view = await run(turnTailReg.Component, { turn: turnOf(many, 20), seq: 20 })
  // 收起态一行一张卡：直接数小预览行
  const count = (view.html.match(/kb-mini-card/g) || []).length
  assert.equal(count, 1, '同一个 id 只该渲染一次，实际 ' + count + ' 次')
  assert.match(view.html, /知识库命中 1 条/, '计数也要按去重后的算')
})

await check('已经是命中的卡片，不再当「相关补充」重复列一次', async () => {
  const view = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard], related: [oneCard, relatedCard] }], 20),
    seq: 20,
  })
  const count = (view.html.match(/kb-mini-card/g) || []).length
  assert.equal(count, 1, '命中卡不该在相关补充里再出现一次')
  assert.match(view.html, /相关 1 条/, '相关补充只剩真正没列过的那条')
})

await check('「库中已有」和「本次更新」里的同一标题不算重复（两种投影）', async () => {
  const updateCard = { ...oneCard, role: 'update' }
  const view = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard, updateCard] }], 20),
    seq: 20,
  })
  const count = (view.html.match(/kb-mini-card/g) || []).length
  assert.equal(count, 2, '已有 + 更新 是两种投影，都要显示')
})

await check('卡片头上有角色徽章（库中已有）', async () => {
  const view = await run(turnTailReg.Component, { turn: turnOf([{ seq: 12, cards: [oneCard] }], 20), seq: 20 })
  assert.match(view.html, /kb-role-badge/, '缺角色徽章')
  assert.match(view.html, /库中已有/, '徽章文案不对')
  assert.match(view.html, /kb-role-existing/, '卡片要带角色类名（色条按角色取色）')
})

// 2026-10-23 用户反馈：「有多个卡片的时候需要展开，这个按键在卡片最上方，
// 应当在最下方合理一点」—— 用户是看完这几张才决定要不要展开的。
await check('「展开全部」在卡片下方，不在最上方', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...oneCard, id: 'k_m' + i, title: '卡片 ' + i }))
  const view = await run(turnTailReg.Component, { turn: turnOf([{ seq: 12, cards: many }], 20), seq: 20 })
  const head = find(view.tree, (node) => node.props && node.props.className === 'kb-stack-head kb-turn-head')
  assert.ok(head, '找不到标题行')
  assert.equal(find(head, (node) => node.tag === 'button'), null, '展开按钮不该在头顶')
  const foot = find(view.tree, (node) => node.props && node.props.className === 'kb-turn-foot')
  assert.ok(foot, '底部缺 kb-turn-foot 行')
  assert.ok(findButton(foot, '展开全部 6 条'), '展开按钮要在卡片下方')
})

await check('点底部的「展开全部」→ 六张全出来，按钮变「收起」', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...oneCard, id: 'k_m' + i, title: '卡片 ' + i }))
  const props = { turn: turnOf([{ seq: 12, cards: many }], 20), seq: 20 }
  const view = await run(turnTailReg.Component, props)
  const foot = find(view.tree, (node) => node.props && node.props.className === 'kb-turn-foot')
  await findButton(foot, '展开全部 6 条').props.onClick()
  const after = await run(turnTailReg.Component, props)
  assert.match(after.html, /卡片 5/, '展开后最后一张也要出来')
  const footAfter = find(after.tree, (node) => node.props && node.props.className === 'kb-turn-foot')
  assert.ok(findButton(footAfter, '收起'), '展开后按钮要变「收起」，而且还在底部')
})

const newCard = {
  id: null,
  title: '智能指针',
  body: '独占所有权。\n- 离开作用域自动释放',
  topic: 'mysql-进阶',
  topicName: 'MySQL 进阶',
  tags: ['c++'],
  verified: false,
  version: 1,
  role: 'new',
}

await check('不同角色的卡片分组显示，不混排', async () => {
  const view = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard, newCard] }], 20),
    seq: 20,
  })
  assert.match(view.html, /kb-group-head/, '要有分组标题')
  assert.match(view.html, /本次新增 1 条/, '缺「本次新增」分组')
  assert.match(view.html, /库中已有 1 条/, '缺「库中已有」分组')
  assert.ok(view.html.indexOf('本次新增') < view.html.indexOf('库中已有'), '要加的卡片要排在已有卡片前面')
  assert.match(view.html, /kb-role-new/, '新卡片要带 new 角色类名')
})

await check('没有 id 的预览卡不给「评审 / 编辑 / 问一下」', async () => {
  const props = { turn: turnOf([{ seq: 12, cards: [newCard] }], 20), seq: 20 }
  // 先展开（收起态本来就只显示一行，谈不上有没有动作）
  const first = await run(turnTailReg.Component, props)
  const mini = find(first.tree, (node) => node.props && String(node.props.className || '').includes('kb-mini-card'))
  assert.ok(mini, '找不到小预览')
  await mini.props.onClick()
  const view = await run(turnTailReg.Component, props)
  assert.ok(!findButton(view.tree, 'AI 校验补充'), '预览卡不该有可写库的动作')
  assert.ok(!findButton(view.tree, '编辑'), '预览卡不该有可写库的动作')
  assert.ok(!findButton(view.tree, '问一下'), '预览卡不该有可写库的动作')
  assert.match(view.html, /还没进库/, '要说明这张卡还没进库')
})

await check('提议条：标题+理由摆出来，点「同意」出预览，再点「确认写入」', async () => {
  forget()
  const proposal = {
    id: 'p_1',
    topic: '面试',
    topicName: '面试',
    items: [
      { title: 'RAII 资源管理', why: '库里没有独立条目' },
      { title: 'STL 容器与迭代器体系', why: '只散在 vector 几条里' },
    ],
  }
  const props = { turn: turnOf([{ seq: 12, proposal }], 20), seq: 20 }
  let view = await run(turnTailReg.Component, props)
  assert.match(view.html, /kb-proposal/, '缺提议条')
  assert.match(view.html, /提议补 2 条/)
  assert.match(view.html, /库里没有独立条目/, '理由要摆出来')
  const accept = findButtonByPrefix(view.tree, '同意，出卡片预览')
  assert.ok(accept, '缺「同意，出卡片预览」按钮')
  await accept.props.onClick()
  view = await run(turnTailReg.Component, props)
  assert.match(view.html, /RAII 把资源生命周期绑到对象上/, '生成出来的正文要能预览')
  const confirm = findButton(view.tree, '确认写入 1 条')
  assert.ok(confirm, '预览之后要给「确认写入」')
  const before = calls.length
  await confirm.props.onClick()
  const posted = calls.slice(before).find(call => String(call.url).endsWith('/kb/api/save'))
  assert.ok(posted, '确认写入要调 /kb/api/save')
  assert.equal(posted.body.batchId, 'b_prop')
  view = await run(turnTailReg.Component, props)
  assert.match(view.html, /已写入/, '写完之后要告诉用户')
})

await check('提议条：每条能单独勾选，还能挑补到哪个主题（2026-10-23 用户要求）', async () => {
  forget()
  const proposal = {
    id: 'p_pick',
    topic: 'mian-shi',
    topicName: '面试',
    topics: [
      { slug: 'mian-shi', name: '面试', count: 128 },
      { slug: 'mysql-jin-jie', name: 'mysql-进阶', count: 123 },
    ],
    items: [
      { title: 'TIME_WAIT 为什么等 2MSL', why: '库里没有独立条目' },
      { title: '为什么挥手需要四次', why: '只散在别的条目里' },
    ],
  }
  const props = { turn: turnOf([{ seq: 12, proposal }], 20), seq: 20 }
  let view = await run(turnTailReg.Component, props)
  assert.match(view.html, /TIME_WAIT 为什么等 2MSL/)
  // 每条一个勾选框
  const boxes = findAll(view.tree, item => item.tag === 'input' && item.props && item.props.type === 'checkbox')
  assert.equal(boxes.length, 2, '每个提议条目都要能单独勾选')
  // 主题下拉
  const selects = findAll(view.tree, item => item.tag === 'select')
  assert.ok(selects.length, '要有主题下拉：补到哪个主题要能选')
  assert.match(view.html, /mysql-进阶/, '下拉里要列出主题')
  // 取消勾第一条 → 只提交剩下那条
  await boxes[0].props.onChange()
  view = await run(turnTailReg.Component, props)
  const accept = findButtonByPrefix(view.tree, '同意，出卡片预览')
  assert.ok(accept, '缺同意按钮')
  assert.match(textOf(accept), /1 条/, '按钮上要写明只补几条')
  const before = calls.length
  await accept.props.onClick()
  const posted = calls.slice(before).find(call => String(call.url).endsWith('/kb/api/propose/accept'))
  assert.ok(posted, '要调 /kb/api/propose/accept')
  assert.deepEqual(posted.body.items, [1], '只提交勾上的那一条')
  assert.equal(posted.body.topic, 'mian-shi', '还要带上选中的主题')
})

await check('预览卡片展开后能单独写入（2026-10-24 用户：审批不能只能批量）', async () => {
  forget()
  const previewCard = {
    id: null,
    title: '为什么挥手需要四次',
    body: '被动方要等自己的数据发完才发 FIN。',
    role: 'new',
    verified: false,
    version: 1,
    tags: ['TCP'],
    topic: 'mian-shi',
    topicName: '面试',
  }
  const props = {
    turn: turnOf(
      [{ seq: 12, cards: [previewCard], save: { batchId: 'b_one', count: 1, topic: 'mian-shi', topicName: '面试' } }],
      20,
    ),
    seq: 20,
  }
  let view = await run(turnTailReg.Component, props)
  // 折叠态没有按钮：先点开这张卡
  const mini = find(view.tree, item => item.props && String(item.props.className || '').includes('kb-mini-card'))
  assert.ok(mini, '要有折叠态的卡片')
  await mini.props.onClick()
  view = await run(turnTailReg.Component, props)
  const writeOne = findButton(view.tree, '写入这条')
  assert.ok(writeOne, '展开后要有「写入这条」')
  const before = calls.length
  await writeOne.props.onClick()
  const posted = calls.slice(before).find(call => String(call.url).endsWith('/kb/api/save'))
  assert.ok(posted, '单独写入也要调 /kb/api/save')
  assert.deepEqual(posted.body.titles, ['为什么挥手需要四次'], '按标题只提交这一条')
  assert.equal(posted.body.batchId, 'b_one')
})

await check('清单列出来的卡片不叫「命中」（2026-10-23 用户实测 251 张）', async () => {
  const listed = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard, relatedCard], source: 'entries' }], 20),
    seq: 20,
  })
  assert.match(listed.html, /列出 2 条/, '清单要叫「列出」')
  assert.ok(!listed.html.includes('知识库命中'), '不能把列出来的说成命中')
  const searched = await run(turnTailReg.Component, {
    turn: turnOf([{ seq: 12, cards: [oneCard], source: 'search' }], 20),
    seq: 20,
  })
  assert.match(searched.html, /知识库命中 1 条/, '检索出来的才叫命中')
})

await check('有待写入批次时出现「确认写入 N 条」按钮', async () => {
  forget() // 丢掉上一条用例留下的状态，从干净状态开始
  const props = {
    turn: turnOf([{ seq: 12, cards: [oneCard], save: { batchId: 'b_1', count: 3, topic: 'mysql-进阶', topicName: 'MySQL 进阶' } }], 20),
    seq: 20,
  }
  const view = await run(turnTailReg.Component, props)
  assert.ok(findButton(view.tree, '确认写入 3 条'), '缺「确认写入」按钮')
  assert.match(view.html, /这批卡片还没进库/, '要说明这批还没进库')
})

await check('点「确认写入」会 POST /kb/api/save，写完显示已写入', async () => {
  forget() // 丢掉上一条用例留下的状态（已写入），从干净状态开始
  const props = {
    turn: turnOf([{ seq: 12, cards: [oneCard], save: { batchId: 'b_1', count: 3, topic: 'mysql-进阶', topicName: 'MySQL 进阶' } }], 20),
    seq: 20,
  }
  const view = await run(turnTailReg.Component, props)
  const button = findButton(view.tree, '确认写入 3 条')
  assert.ok(button, '缺「确认写入」按钮')
  const before = calls.length
  await button.props.onClick()
  const posted = calls.slice(before).find(call => String(call.url).endsWith('/kb/api/save'))
  assert.ok(posted, '应调 /kb/api/save')
  assert.equal(posted.method, 'POST')
  assert.equal(posted.body.batchId, 'b_1')
  const after = await run(turnTailReg.Component, props)
  assert.match(after.html, /已写入 3 条/, '写完要显示已写入')
  assert.ok(!findButton(after.tree, '确认写入 3 条'), '写完不该还能再点')
})

await check('写入失败时把原因显示出来，不静默', async () => {
  forget() // 同样要清掉上一条用例的「已写入」状态
  const props = {
    turn: turnOf([{ seq: 12, cards: [oneCard], save: { batchId: 'b_2', count: 1, topic: 'mysql-进阶', topicName: 'MySQL 进阶' } }], 20),
    seq: 20,
  }
  const view = await run(turnTailReg.Component, props)
  const button = findButton(view.tree, '确认写入 1 条')
  // 把这次调用的返回换成失败
  const originalFetch = sandbox.fetch
  sandbox.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/kb/api/save')) {
      calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined })
      return { ok: false, status: 409, json: async () => ({ error: '这批和库里的条目高度相似' }) }
    }
    return originalFetch(url, options)
  }
  await button.props.onClick()
  sandbox.fetch = originalFetch
  const after = await run(turnTailReg.Component, props)
  assert.match(after.html, /这批和库里的条目高度相似/, '失败原因要显示给用户')
})

await check('宿主没重启时点「确认写入」会说清要重启，不甩「未知接口」', async () => {
  forget()
  const props = {
    turn: turnOf([{ seq: 12, cards: [oneCard], save: { batchId: 'b_3', count: 1, topic: 'mysql-进阶', topicName: 'MySQL 进阶' } }], 20),
    seq: 20,
  }
  const view = await run(turnTailReg.Component, props)
  const button = findButton(view.tree, '确认写入 1 条')
  const originalFetch = sandbox.fetch
  sandbox.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/kb/api/save')) {
      return { ok: false, status: 404, json: async () => ({ error: '未知接口 /save' }) }
    }
    return originalFetch(url, options)
  }
  await button.props.onClick()
  sandbox.fetch = originalFetch
  const after = await run(turnTailReg.Component, props)
  assert.match(after.html, /重启 DSH/, '要说清要重启 DSH')
})

console.log('AI 校验面板')
const turnProps = (cards) => ({ turn: turnOf([{ seq: 12, cards }], 20), seq: 20 })
const allWithClass = (node, className, out = []) => {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const item of node) allWithClass(item, className, out)
    return out
  }
  if (node.props && node.props.className === className) out.push(node)
  allWithClass(node.children, className, out)
  return out
}
const badges = (node) =>
  allWithClass(node, 'kb-badge quiet clickable')

const openAll = async (props) => {
  // 会话末尾的卡片默认收成一行预览（2026-10-23 用户要求），
  // 要测卡片内部（角标 / 动作按钮 / 正文）就得先展开。
  const miniCards = (node, out = []) => {
    if (!node || typeof node === 'string') return out
    if (Array.isArray(node)) {
      for (const item of node) miniCards(item, out)
      return out
    }
    if (node.props && String(node.props.className || '').includes('kb-mini-card')) out.push(node)
    miniCards(node.children, out)
    return out
  }
  const first = await run(turnTailReg.Component, props)
  for (const node of miniCards(first.tree)) {
    if (node.props && typeof node.props.onClick === 'function') await node.props.onClick()
  }
  return run(turnTailReg.Component, props)
}


await check('校验面板按三条路径分区块，各自带标题与说明', async () => {
  const view = await openAll(turnProps([oneCard]))
  const badge = badges(view.tree)[0]
  assert.ok(badge, '找不到卡片上的核实角标')
  await badge.props.onClick()
  const shown = await openAll(turnProps([oneCard]))
  assert.match(shown.html, /核实这条/)
  assert.match(shown.html, /只记录谁确认的，不改卡片内容/)
  const sections = allWithClass(shown.tree, 'kb-vsec')
  assert.equal(sections.length, 3, '应该有正好三个区块（自己确认 / AI 先查 / 附出处）')
  assert.match(shown.html, /自己确认/)
  assert.match(shown.html, /让 AI 先查一遍/)
  assert.match(shown.html, /附上出处/)
  // 标题旁边要标出这次会用哪个模型（还没跑校验就该能看到）
  assert.match(shown.html, /模型 deepseek-flash/, '面板要显示跟会话对齐的模型')
  assert.ok(allWithClass(shown.tree, 'kb-model-chip').length >= 1, '模型要用醒目的标签，不是灰小字')
})

await check('每块都是完整句子说明，不是一个标签 + 一个按钮', async () => {
  const shown = await openAll(turnProps([oneCard]))
  const descs = allWithClass(shown.tree, 'kb-vsec-desc').map((node) => textOf(node))
  assert.equal(descs.length, 3, '三个区块都该有说明文字')
  for (const desc of descs) assert.ok(desc.length >= 8, '说明太短，等于没解释：' + desc)
  // 按钮用更大的 kb-vbtn，不是 11.5px 的 kb-mini
  const bigButtons = allWithClass(shown.tree, 'kb-vbtn').concat(
    allWithClass(shown.tree, 'kb-vbtn primary'),
  )
  assert.ok(bigButtons.length >= 3, '三条路径的按钮应该用大号样式')
})

await check('点「附上出处」才出现输入框和保存按钮', async () => {
  const shown = await openAll(turnProps([oneCard]))
  assert.equal(find(shown.tree, (node) => node.tag === 'input'), null, '默认不该有输入框')
  const open = findButton(shown.tree, '填来源')
  assert.ok(open, '找不到「填来源」按钮')
  await open.props.onClick()
  const after = await openAll(turnProps([oneCard]))
  assert.ok(find(after.tree, (node) => node.tag === 'input'), '点了之后要出现输入框')
  assert.ok(findButton(after.tree, '存为来源并核实'), '要有保存按钮')
})

await check('点「开始校验」后问题单独成块，带计数', async () => {
  currentIssues = [{ text: 'TCP 首部长度写反了：固定 20 字节，可变 20~60 字节' }]
  const shown = await openAll(turnProps([oneCard]))
  const start = findButton(shown.tree, '开始校验')
  assert.ok(start, '找不到「开始校验」按钮')
  await start.props.onClick()
  const after = await openAll(turnProps([oneCard]))
  assert.equal(allWithClass(after.tree, 'kb-vissues').length, 1, '问题要单独成块')
  assert.match(after.html, /AI 发现的问题 · 1/)
  assert.match(after.html, /TCP 首部长度写反了/)
})

await check('AI 没发现问题时给出结论 + 无异议按钮', async () => {
  currentIssues = []
  // 用第二张**未核实**的卡（另一个 ChatCard 实例），避免复用上面那张已经查过的状态
  const anotherCard = { ...oneCard, id: 'k_3', title: 'TCP 与 UDP 的区别' }
  const props = turnProps([oneCard, anotherCard])
  const shown = await openAll(props)
  const list = badges(shown.tree)
  assert.ok(list.length >= 2, '应该有两张卡的角标')
  await list[1].props.onClick()
  await openAll(props)
  const opened = await openAll(props)
  const start = findButton(opened.tree, '开始校验')
  assert.ok(start, '找不到第二张卡的「开始校验」')
  await start.props.onClick()
  const after = await openAll(props)
  assert.match(after.html, /AI 没有发现事实性问题/)
  assert.ok(findButton(after.tree, '无异议，标为已核实'))
  // 只看**第二张卡**的面板：第一张卡的问题块还开着，不能全局计数
  const panels = allWithClass(after.tree, 'kb-verify')
  assert.equal(panels.length, 2, '两张卡各一个面板')
  assert.equal(allWithClass(panels[1], 'kb-vissues').length, 0, '没问题就不该有警示块')
  currentIssues = [{ text: 'TCP 首部长度写反了：固定 20 字节，可变 20~60 字节' }]
})

console.log('AI 校验补充工作台')
/** 打开工作台。面板开关是 toggle，而且组件的 ref 会跨 run 保留，
    所以这里先确保打开，再点「让 AI 校验」拉一次当前 fixture。 */
const openWorkbench = async () => {
  const props = turnProps([oneCard])
  let view = await openAll(props)
  if (!String(view.html).includes('kb-workpanel')) {
    const button = findButton(view.tree, 'AI 校验补充')
    assert.ok(button, '找不到「AI 校验补充」按钮')
    await button.props.onClick()
    await sleep(30)
    view = await openAll(props)
  }
  // 已经有结果时按钮是「重新校验」（走强制重跑），两种标签都要认
  const runButton = findButton(view.tree, '让 AI 校验') || findButton(view.tree, '重新校验')
  if (runButton) {
    await runButton.props.onClick()
    await sleep(30)
    view = await openAll(props)
  }
  return view
}

await check('工作台按区块组织：问题 / 补充要点 / 建议改写 / 正文', async () => {
  currentIssues = [{ text: 'TCP 首部长度写反了' }]
  currentAdditions = [{ text: 'UDP 首部固定 8 字节，TCP 首部可变 20~60 字节' }]
  currentSuggested = ''
  const shown = await openWorkbench()
  assert.match(shown.html, /卡片工作台/)
  assert.match(shown.html, /模型 fake/, '面板顶部要标出这次用的是哪个模型（要跟会话对齐）')
  assert.match(shown.html, /发现的问题 · 1/)
  assert.match(shown.html, /可补充的要点 · 1/)
  assert.match(shown.html, /正文（可直接改）/)
  assert.ok(allWithClass(shown.tree, 'kb-vsec').length >= 3, '三块内容都要有自己的区块')
  assert.ok(find(shown.tree, (node) => node.props && node.props.className === 'kb-textarea kb-work-body'), '正文框要用大号样式')
})

await check('点「采纳」把要点追加进正文', async () => {
  const shown = await openWorkbench()
  const adopt = findButton(shown.tree, '采纳')
  assert.ok(adopt, '找不到「采纳」按钮')
  await adopt.props.onClick()
  const after = await openAll(turnProps([oneCard]))
  const area = find(after.tree, (node) => node.tag === 'textarea' && node.props && String(node.props.className || '').includes('kb-work-body'))
  assert.ok(area, '找不到正文框')
  assert.match(String(area.props.value), /UDP 首部固定 8 字节/, '采纳的要点要进正文')
  assert.match(String(area.props.value), /^- /m, '追加成一条 - 要点')
})

await check('点「忽略」把问题从列表里去掉', async () => {
  currentIssues = [{ text: '第一条问题' }, { text: '第二条问题' }]
  const shown = await openWorkbench()
  assert.match(shown.html, /发现的问题 · 2/)
  const ignores = allWithClass(shown.tree, 'kb-vbtn').filter((node) => textOf(node).trim() === '忽略')
  assert.ok(ignores.length >= 2, '每条问题都该有「忽略」')
  await ignores[0].props.onClick()
  const after = await openAll(turnProps([oneCard]))
  assert.match(after.html, /发现的问题 · 1/, '忽略一条后计数要减')
  assert.ok(!after.html.includes('第一条问题'), '忽略掉的那条不该还在')
})

await check('AI 没找到可补充的要点时也要明说，不能沉默', async () => {
  currentParseError = false
  currentIssues = []
  currentAdditions = []
  const shown = await openWorkbench()
  assert.match(shown.html, /可补充的要点 · 0/)
  assert.match(shown.html, /AI 没找到可补充的要点/, '沉默会让用户分不清「没啥可补」和「功能坏了」')
})

await check('模型没按 JSON 回答时明确报错，不能显示成「没发现问题」', async () => {
  currentParseError = true
  currentIssues = []
  currentAdditions = []
  const shown = await openWorkbench()
  assert.match(shown.html, /AI 没按格式回答/, '解析失败必须如实说出来')
  assert.match(shown.html, /这张卡看起来没什么问题，我就不列 JSON 了/, '要把模型原文贴出来')
  assert.ok(findButton(shown.tree, '重试'), '要给一个重试按钮')
  assert.ok(!shown.html.includes('AI 没有发现事实性问题'), '解析失败绝不能显示成「没发现问题」')
  currentParseError = false
})

console.log('正文编辑框显示纯文本')
const markupCard = {
  ...oneCard,
  id: 'k_markup',
  body: '`MySQL 8.0` 分四层。\n- **连接层**：权限校验\n- 服务层：解析 SQL',
}

await check('编辑框里看不到 ** / 反引号 / 【】 这些标记，只剩文字', async () => {
  currentIssues = []
  currentAdditions = []
  currentSuggested = ''
  forget() // 重新挂载，别复用上一条用例残留的 hook 状态
  const props = turnProps([markupCard])
  let view = await openAll(props)
  const open = findButton(view.tree, 'AI 校验补充')
  assert.ok(open, '找不到「AI 校验补充」按钮')
  await open.props.onClick()
  await sleep(30)
  view = await openAll(props)
  const area = find(
    view.tree,
    (node) => node.tag === 'textarea' && String((node.props && node.props.className) || '').includes('kb-work-body'),
  )
  assert.ok(area, '找不到正文框')
  const value = String(area.props.value)
  assert.ok(!value.includes('**'), '编辑框里不该出现粗体标记：' + value)
  assert.ok(!value.includes('`'), '编辑框里不该出现反引号：' + value)
  assert.ok(value.includes('MySQL 8.0 分四层。'), '去掉标记后文字要还在：' + value)
  assert.ok(value.includes('- 连接层：权限校验'), '"- " 要点行要留着（它既是列表也是契约）：' + value)
})

await check('编辑框没改动就保存 → 写回的是带标记的原正文（不会被洗成裸文本）', async () => {
  const props = turnProps([markupCard])
  const before = calls.filter((item) => item.url.endsWith('/card/apply')).length
  let view = await openAll(props)
  const first = findButton(view.tree, '覆盖原卡片')
  assert.ok(first, '找不到「覆盖原卡片」按钮')
  await first.props.onClick()
  await sleep(10)
  view = await openAll(props)
  const confirm = findButton(view.tree, '覆盖原卡片')
  assert.ok(confirm, '二次确认按钮没出现')
  await confirm.props.onClick()
  await sleep(30)
  const posted = calls.filter((item) => item.url.endsWith('/card/apply'))
  assert.equal(posted.length, before + 1, '应该发出一次写回请求')
  assert.equal(posted[posted.length - 1].body.body, markupCard.body, '没改动就保存，原标记必须原样写回')
})

console.log('重复点开不重复调模型')
await check('关掉再点开「AI 校验补充」→ 命中缓存，不再请求 /card/review', async () => {
  const previousModel = currentModel
  currentModel = 'fake' // 让 /card/model 与校验结果里的 model 一致，缓存才该命中
  currentIssues = [{ text: '缓存用例的问题' }]
  currentAdditions = []
  currentSuggested = ''
  reviewCacheClear()
  const props = turnProps([oneCard])
  const reviewCalls = () => calls.filter((item) => item.url.endsWith('/card/review')).length
  const baseline = reviewCalls()

  // 第一次打开：真的调一次
  forget()
  let view = await openAll(props)
  await findButton(view.tree, 'AI 校验补充').props.onClick()
  await sleep(30)
  view = await openAll(props)
  assert.equal(reviewCalls(), baseline + 1, '第一次打开应该请求一次')
  assert.match(view.html, /发现的问题 · 1/, '结果要显示出来')

  // 关掉再打开 = 组件重新挂载（真实界面里 ref/state 都是新的）
  forget()
  view = await openAll(props)
  await findButton(view.tree, 'AI 校验补充').props.onClick()
  await sleep(30)
  view = await openAll(props)
  assert.equal(reviewCalls(), baseline + 1, '第二次打开不该再调模型：' + reviewCalls())
  assert.match(view.html, /用的是上次的结果，这次没调模型/, '复用缓存要明说，别让用户以为又调了一次')
  assert.match(view.html, /发现的问题 · 1/, '缓存的结果要照常显示')

  // 想看新的：点「重新校验」强制重跑
  const again = findButton(view.tree, '重新校验')
  assert.ok(again, '缓存态要有一个能强制重跑的按钮')
  await again.props.onClick()
  await sleep(30)
  assert.equal(reviewCalls(), baseline + 2, '「重新校验」必须真的再请求一次')

  reviewCacheClear()
  currentModel = previousModel
})

console.log('token 用量')
await check('面板显示「本次 N tokens」，侧边栏显示累计', async () => {
  currentIssues = [{ text: '用量用例' }]
  currentAdditions = []
  currentSuggested = ''
  forget()
  const props = turnProps([oneCard])
  let view = await openAll(props)
  await findButton(view.tree, 'AI 校验补充').props.onClick()
  await sleep(30)
  view = await openAll(props)
  assert.match(view.html, /本次 1,540 tokens/, '面板要写清这次用了多少 tokens')
  assert.ok(api.readTokenTotal() >= 1540, '用量要累计起来：' + api.readTokenTotal())
  const panel = await run(Panel, {})
  assert.match(panel.html, /AI 累计 [\d,]+ tokens/, '侧边栏要显示累计用量')
})

await check('命中缓存时显示「上次 N tokens」，不重复计费', async () => {
  const props = turnProps([oneCard])
  const before = api.readTokenTotal()
  forget()
  let view = await openAll(props)
  await findButton(view.tree, 'AI 校验补充').props.onClick()
  await sleep(30)
  view = await openAll(props)
  assert.match(view.html, /上次 1,540 tokens/, '缓存结果要标明是上次的用量')
  assert.equal(api.readTokenTotal(), before, '缓存命中不能再加一次')
})

console.log('查看当前版本（改完之后这一版）')
await check('没改时显示「已保存 · vN」；改了要显示改后的内容并标明未保存', async () => {
  const props = turnProps([markupCard])
  forget()
  let view = await openAll(props)
  await findButton(view.tree, 'AI 校验补充').props.onClick()
  await sleep(30)
  view = await openAll(props)
  await findButton(view.tree, '查看当前版本').props.onClick()
  await sleep(10)
  view = await openAll(props)
  assert.match(view.html, /已保存 · v2/, '没改的时候标明已保存 + 版本号')
  assert.match(view.html, /MySQL 8\.0 分四层/, '要渲染正文，不是只给版本号')

  // 在编辑框里改一行
  const area = find(
    view.tree,
    (node) => node.tag === 'textarea' && String((node.props && node.props.className) || '').includes('kb-work-body'),
  )
  assert.ok(area, '找不到正文框')
  await area.props.onChange({ target: { value: String(area.props.value) + '\n- 新增要点：文件系统层' } })
  await sleep(10)
  view = await openAll(props)
  assert.match(view.html, /当前是未保存的修改 · 库里仍是 v2/, '改了要如实标出来')
  assert.match(view.html, /新增要点：文件系统层/, '要显示改完之后的内容，而不是库里那份旧的')
})

await check('写回之后变成「已保存 · v9」，内容也跟着换成新版本', async () => {
  const props = turnProps([markupCard])
  let view = await openAll(props)
  await findButton(view.tree, '覆盖原卡片').props.onClick()
  await sleep(10)
  view = await openAll(props)
  await findButton(view.tree, '覆盖原卡片').props.onClick()
  await sleep(30)
  view = await openAll(props)
  assert.match(view.html, /已保存 · v9/, '写回后版本号要更新')
  assert.match(view.html, /写回后的正文/, '写回后显示的要是新内容')
})

console.log('过期卡片（别的端已经改过这条）')
await check('库里版本比会话里新 → 禁用「AI 校验补充」「编辑」，并说明原因', async () => {
  currentStoreVersion = 5 // 库里已经是 v5，会话里还拿着 v2
  api.clearCardVersionCache()
  forget()
  const view = await openAll(turnProps([oneCard]))
  const review = findButton(view.tree, 'AI 校验补充')
  const edit = findButton(view.tree, '编辑')
  assert.ok(review, '找不到「AI 校验补充」按钮')
  assert.ok(edit, '找不到「编辑」按钮')
  assert.equal(review.props.disabled, true, '过期卡片的「AI 校验补充」必须禁用')
  assert.equal(edit.props.disabled, true, '过期卡片的「编辑」必须禁用')
  assert.match(view.html, /库里已更新到 v5/, '要写清楚库里现在是哪一版')
  const ask = findButton(view.tree, '问一下')
  assert.ok(ask, '找不到「问一下」按钮')
  assert.notEqual(ask.props.disabled, true, '「问一下」是只读的，不该被禁用')
  currentStoreVersion = 2
})

await check('版本一致 → 两个按钮照常可用', async () => {
  currentStoreVersion = 2
  api.clearCardVersionCache()
  forget()
  const view = await openAll(turnProps([oneCard]))
  const review = findButton(view.tree, 'AI 校验补充')
  const edit = findButton(view.tree, '编辑')
  assert.equal(review.props.disabled, false, '不过期就不该禁用')
  assert.equal(edit.props.disabled, false, '不过期就不该禁用')
  assert.ok(!view.html.includes('库里已更新到'), '不过期就不该出现过期提示')
})

console.log('版本查询合并（审计 P1-7）')
const versionCalls = () => calls.filter(c => c.url.includes('/card/versions'))

await check('同一批卡片的版本查询合并成一次请求', async () => {
  api.clearCardVersionCache()
  const before = versionCalls().length
  const results = await Promise.all([
    api.fetchCardVersions(['k1'], '面试'),
    api.fetchCardVersions(['k2'], '面试'),
    api.fetchCardVersions(['k3'], '面试'),
    api.fetchCardVersions(['k4'], '面试'),
    api.fetchCardVersions(['k5'], '面试'),
  ])
  const after = versionCalls()
  assert.equal(after.length - before, 1, '5 张卡应该只发 1 个请求，而不是 5 个')
  const ids = new URL(after[after.length - 1].url, 'http://127.0.0.1').searchParams.get('ids')
  assert.deepEqual(ids.split(','), ['k1', 'k2', 'k3', 'k4', 'k5'], '一个请求里要带上全部 id')
  assert.ok(results[0].k1, '每个调用方都要拿到自己那张卡的结果')
  assert.ok(results[4].k5)
})

await check('超过 50 张卡时分批问，一个都不能少', async () => {
  api.clearCardVersionCache()
  const before = versionCalls().length
  const many = Array.from({ length: 55 }, (_, i) => 'm' + i)
  const map = await api.fetchCardVersions(many, '面试')
  const after = versionCalls()
  assert.equal(after.length - before, 2, '55 个 id 应该分 2 批问')
  assert.equal(Object.keys(map).length, 55, '一个都不能少')
})

console.log('插件 AI 模型选择器（2026-10-23「模型要能切换」）')
/** 收集树里所有模型选择器（模型下拉 + 档位下拉） */
function collectModelSelects(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out
  if (tree.tag === 'select' && String(tree.props && tree.props.className).includes('kb-ai-model-select')) {
    out.push(tree)
  }
  for (const child of tree.children || []) collectModelSelects(child, out)
  const kids = tree.props && tree.props.children
  if (kids) for (const kid of Array.isArray(kids) ? kids : [kids]) collectModelSelects(kid, out)
  return out
}

await check('面板头部有模型选择器，默认「跟随会话」并列出可选模型', async () => {
  currentAiModel = { mode: 'session', provider: null, model: null, reasoningEffort: null }
  const view = await run(Panel, {})
  const selects = collectModelSelects(view.tree)
  assert.equal(selects.length, 1, '跟随会话时只有一个模型选择器，实际 ' + selects.length)
  assert.equal(selects[0].props.value, '__session__', '默认应该跟随会话')
  assert.ok(view.html.includes('跟随会话'), '缺「跟随会话」选项')
  assert.ok(view.html.includes('deepseek-flash'), '缺枚举出来的模型')
  assert.ok(view.html.includes('MiniMax-M3.1-Flash'), '缺第二个 provider 的模型')
})

await check('选具体模型 → POST /ai-model 固定 provider + model', async () => {
  calls.length = 0
  const view = await run(Panel, {})
  const select = collectModelSelects(view.tree)[0]
  await select.props.onChange({ target: { value: 'deepseek-official|deepseek-flash' } })
  await sleep(30)
  const posted = calls.find(item => item.url.includes('/ai-model') && item.method === 'POST')
  assert.ok(posted, '没发出保存请求')
  assert.equal(posted.body.aiModel.mode, 'fixed')
  assert.equal(posted.body.aiModel.provider, 'deepseek-official')
  assert.equal(posted.body.aiModel.model, 'deepseek-flash')
})

await check('固定后出现档位选择器，改档位会带上当前模型', async () => {
  currentAiModel = { mode: 'fixed', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null }
  const view = await run(Panel, {})
  const selects = collectModelSelects(view.tree)
  assert.equal(selects.length, 2, '固定模型且有档位时应该有两个选择器，实际 ' + selects.length)
  const effortSelect = selects[1]
  calls.length = 0
  await effortSelect.props.onChange({ target: { value: 'low' } })
  await sleep(30)
  const posted = calls.find(item => item.url.includes('/ai-model') && item.method === 'POST')
  assert.ok(posted, '没发出保存请求')
  assert.equal(posted.body.aiModel.mode, 'fixed')
  assert.equal(posted.body.aiModel.model, 'deepseek-flash', '改档位不能把选中的模型弄丢')
  assert.equal(posted.body.aiModel.reasoningEffort, 'low')
  currentAiModel = { mode: 'session', provider: null, model: null, reasoningEffort: null }
})

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')
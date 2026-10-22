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

  return { React, run }
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

// ---------------------------------------------------------------- 载入 bundle
const { React, run } = makeReact()
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
    if (route.endsWith('/entries')) return okJson(fixtures.entries)
    if (route.endsWith('/search')) return okJson(fixtures.search)
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

await check('apply 注册 main 与 sidebar.panellist 两处', async () => {
  api.apply(fakeCtx)
  assert.equal(registrations.length, 2)
  assert.deepEqual(
    registrations.map((item) => item.slot),
    ['main', 'sidebar.panellist'],
  )
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
  assert.match(html, /1 条活跃 · 2 条合计 · 1 个主题/)
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
  assert.equal(collected.length, 2, '两处注册都要完成')
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

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')

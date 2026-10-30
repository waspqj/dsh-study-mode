// 学习模式 KB 插件 · 工具 schema 与边界自测（node test/tools-schema.test.mjs）
//
// 这组用例锁的是一次真实故障的根因：工具 parameters 早先写成私有 DSL
// （参数名直接摊在顶层、required 是布尔值），宿主投影给模型时 properties 为空，
// 模型看不见参数名 → 调用时参数被丢掉 → learn_save 一直报「cards 不能为空」，
// 模型换 14 种参数形状盲试。所以这里对 schema 形状做硬断言。
//
// 风格与仓库其它脚本一致：无分号。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-schema-'))
process.env.DSH_LEARN_ROOT = root

const { apply, MUST_KEEP, DENY_TOOLS } = await import('../plugin/tools.js')

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

const registered = new Map()
const listeners = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  on(event, listener) {
    listeners.set(event, listener)
  },
}
apply(ctx, {})

console.log('工具暴露面（改 / 删默认不暴露给模型）')
await check('默认只注册 5 个工具：改 / 删两个不发给模型', async () => {
  // 2026-10-23 用户：「我不说要删改条目为什么要每次都发过去」
  // —— 工具 schema 每次请求都随 tools 一起发，改/删两个加起来约 1200 字。
  assert.deepEqual(
    Array.from(registered.keys()).sort(),
    ['learn_entries', 'learn_propose', 'learn_save', 'learn_search', 'learn_topics'],
  )
})
await check('打开设置后改 / 删两个工具才注册', async () => {
  const settingsFile = path.join(root, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ kbEditTools: true }))
  const again = new Map()
  apply(
    {
      tools: {
        register(definition) {
          again.set(definition.name, definition)
          return () => {}
        },
      },
      on() {},
    },
    {},
  )
  assert.ok(again.get('learn_update'), '打开后要有 learn_update')
  assert.ok(again.get('learn_delete'), '打开后要有 learn_delete')
})

const exec = { agent: { id: 'sess-schema' } }
const topics = registered.get('learn_topics')
const search = registered.get('learn_search')
const save = registered.get('learn_save')

console.log('工具参数 schema 必须是标准 JSON Schema')
await check('每个工具的 parameters 形如 {type:"object", properties:{...}}', async () => {
  for (const tool of registered.values()) {
    const schema = tool.parameters
    assert.equal(schema.type, 'object', tool.name + ' 的 parameters.type 应为 object')
    assert.ok(schema.properties, tool.name + ' 缺 properties')
    assert.ok(
      Object.keys(schema.properties).length > 0,
      tool.name + ' 的 properties 为空 —— 模型会看不见任何参数名',
    )
  }
})
await check('每个参数都有 type 与 description', async () => {
  for (const tool of registered.values()) {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.equal(typeof spec.type, 'string', tool.name + '.' + key + ' 缺 type')
      assert.equal(typeof spec.description, 'string', tool.name + '.' + key + ' 缺 description')
    }
  }
})
await check('参数里不能出现布尔 required（标准 JSON Schema 的 required 是顶层数组）', async () => {
  for (const tool of registered.values()) {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.ok(
        typeof spec.required !== 'boolean',
        tool.name + '.' + key + ' 用了布尔 required，会被宿主投影丢掉',
      )
    }
  }
})
await check('顶层 required 是数组，且每一项都在 properties 里', async () => {
  for (const tool of registered.values()) {
    const required = tool.parameters.required
    if (required === undefined) continue
    assert.ok(Array.isArray(required), tool.name + ' 的 required 必须是数组')
    for (const key of required) {
      assert.ok(key in tool.parameters.properties, tool.name + '.required 里的 ' + key + ' 不在 properties 中')
    }
  }
})
await check('learn_save.cards 的 items 也是标准对象 schema', async () => {
  const items = save.parameters.properties.cards.items
  assert.equal(items.type, 'object')
  assert.ok(items.properties.title, 'cards.items 缺 title')
  assert.ok(items.properties.body, 'cards.items 缺 body')
  assert.deepEqual(items.required, ['title', 'body'])
})
await check('learn_save 的 cards 是唯一必填项', async () => {
  assert.deepEqual(save.parameters.required, ['cards'])
})

console.log('learn_save 入参健壮性')
await check('先建一个主题供后面的写入用例使用', async () => {
  topics.execute({ action: 'create', name: '测试主题' }, exec)
  assert.equal(topics.execute({ action: 'current' }, exec).current.slug, '测试主题')
})
await check('cards 传 JSON 字符串也能吃下', async () => {
  const result = await save.execute({ cards: JSON.stringify([{ title: '字符串入参', body: '正文' }]) }, exec)
  assert.equal(result.plan[0].title, '字符串入参')
})
await check('cards 传单个对象也能吃下', async () => {
  const result = await save.execute({ cards: { title: '单对象', body: '正文' } }, exec)
  assert.equal(result.plan[0].title, '单对象')
})
await check('cards 缺失时报错直接说清正确形状', async () => {
  await assert.rejects(() => save.execute({}, exec), /cards 不能为空/)
  await assert.rejects(() => save.execute({ cards: [] }, exec), /cards 不能为空/)
})
await check('卡片缺 body 时报错点名是哪一张', async () => {
  await assert.rejects(() => save.execute({ cards: [{ title: '只有标题的卡' }] }, exec), /只有标题的卡/)
})
await check('cards 是坏 JSON 时报清楚', async () => {
  await assert.rejects(() => save.execute({ cards: 'not json' }, exec), /JSON/)
})

console.log('不该产生的副作用')
await check('learn_topics action=use 遇到不存在的主题会报错，不建空主题', async () => {
  const before = topics.execute({ action: 'list' }, exec).topics.length
  assert.throws(() => topics.execute({ action: 'use', name: '不存在的幽灵主题' }, exec), /不存在/)
  const after = topics.execute({ action: 'list' }, exec).topics.length
  assert.equal(after, before, 'use 不该新建主题')
})
await check('learn_search 指定不存在的主题只给提示，不建空主题', async () => {
  const before = topics.execute({ action: 'list' }, exec).topics.length
  const result = await search.execute({ query: '间隙锁', topic: '不存在的幽灵主题' }, exec)
  assert.equal(result.needTopic, true)
  assert.equal(result.hits.length, 0)
  const after = topics.execute({ action: 'list' }, exec).topics.length
  assert.equal(after, before, '检索不该新建主题')
})
await check('learn_search 指定存在的主题能正常检索', async () => {
  const result = await search.execute({ query: '间隙锁', topic: '测试主题' }, exec)
  assert.equal(result.needTopic, undefined)
  assert.equal(result.scope, '测试主题')
})

console.log('按领域收窄（appliesTo）')
const entriesTool = registered.get('learn_entries')
await check('learn_search 与 learn_entries 都暴露了 appliesTo 参数', async () => {
  assert.equal(typeof search.parameters.properties.appliesTo.type, 'string')
  assert.equal(typeof entriesTool.parameters.properties.appliesTo.type, 'string')
})
await check('learn_search 带 appliesTo 不报错，并如实回报收窄条件', async () => {
  const result = await search.execute({ query: '间隙锁', topic: '测试主题', appliesTo: [' MySQL '] }, exec)
  assert.equal(result.appliesTo, 'mysql', '归一化后的针要回显')
  assert.ok(Array.isArray(result.hits))
})
await check('learn_entries 返回 facets（领域 + 标签分布）', async () => {
  const result = entriesTool.execute({ topic: '测试主题' }, exec)
  assert.ok(result.facets, '缺 facets 模型就没法选过滤值')
  assert.ok(Array.isArray(result.facets.appliesTo))
  assert.ok(Array.isArray(result.facets.tags))
  assert.equal(typeof result.facets.unscoped, 'number')
})

console.log('清单要限量（2026-10-30 用户实测「检索卡住了好久」的根因）')
await check('不传 limit 时最多给 30 条', async () => {
  const result = await entriesTool.execute({ topic: '测试主题' }, exec)
  assert.ok(result.entries.length <= 30, '一次最多给 30 条')
})
await check('limit 再大也封顶在 60 条', async () => {
  const result = await entriesTool.execute({ topic: '测试主题', limit: 5000 }, exec)
  assert.ok(result.entries.length <= 60, '清单一次最多 60 条 —— 200 多条就是 2.4 万字符了')
})
await check('offset 能翻页，且跟第一页不重叠', async () => {
  const first = await entriesTool.execute({ topic: '测试主题', limit: 5 }, exec)
  const second = await entriesTool.execute({ topic: '测试主题', limit: 5, offset: 5 }, exec)
  const firstIds = new Set(first.entries.map(entry => entry.id))
  const overlap = second.entries.filter(entry => firstIds.has(entry.id))
  assert.equal(overlap.length, 0, '两页不该有重复')
})
await check('没列完时要说清楚还剩多少、怎么接着列', async () => {
  // 模型必须知道「还有更多」，否则它会以为库里就这么多了
  const rendered = entriesTool.output.render(
    {},
    {
      topic: '测试主题',
      total: 208,
      offset: 0,
      entries: [{ id: 'k_1', title: '示例卡', tags: [], version: 1, verified: false }],
      facets: null,
    },
  )
  const text = Array.isArray(rendered) ? rendered.map(part => part.text || '').join('\n') : String(rendered)
  assert.match(text, /只列了前 1 条/, '要说明只列了一部分')
  assert.match(text, /offset=/, '要告诉模型怎么接着列')
})

await check('learn_entries 也发布 kbCards（「有哪些」类回答不能没有卡片）', async () => {
  // 回归：批次 1 把「清单类问题」导向 learn_entries，但它当时没有 presentationMeta，
  // 于是模型列了 13 条、对话里一张卡片都没出现（2026-10-23 用户实测报「没给我卡片啊」）。
  // 先落一张真条目（先预览再 approved，指纹闸门才放行）。
  const cards = [{ title: '卡片视图样例', body: '正文样例\n- 要点一' }]
  await save.execute({ cards, topic: '测试主题' }, exec)
  await save.execute({ cards, topic: '测试主题', approved: true }, exec)

  const result = entriesTool.execute({ topic: '测试主题' }, exec)
  assert.ok(result.entries.length > 0, '前置条件：主题里要有一条真条目')
  assert.equal(typeof entriesTool.output.presentationMeta, 'function', 'learn_entries 缺 presentationMeta')
  const meta = entriesTool.output.presentationMeta({}, result)
  assert.ok(Array.isArray(meta.kbCards), '缺 kbCards')
  assert.equal(meta.kbCards.length, result.entries.length, '列了几条就要出几张卡')
  assert.ok(meta.kbCards.every(card => card.title), '卡片必须有标题')
  assert.ok(meta.kbCards.some(card => card.body), '正文要从存储回读，不能全是空壳')
  assert.ok(meta.kbCards.every(card => 'appliesTo' in card), '卡片要带适用领域')
})

console.log('卡片角色与预览先行（2026-10-23 批次 2）')
await check('learn_save 的 mode 默认是 preview（先给用户看内容再写）', async () => {
  assert.equal(save.parameters.properties.mode.default, 'preview', '默认必须是预览，不是直接弹权限框')
  const result = await save.execute({ cards: [{ title: '角色样例', body: '正文' }], topic: '测试主题' }, exec)
  assert.equal(result.status, 'preview')
  assert.ok(result.batchId, '预览要给出 batchId —— 界面上的「确认写入」按钮靠它')
})
await check('learn_save 的卡片带角色（新增是 new）', async () => {
  const args = { cards: [{ title: '角色样例二', body: '正文' }], topic: '测试主题' }
  const result = await save.execute(args, exec)
  const meta = save.output.presentationMeta(args, result)
  assert.ok(Array.isArray(meta.kbCards))
  assert.equal(meta.kbCards[0].role, 'new', '新建的卡片角色应是 new')
})
await check('learn_save 预览时发布 kbSave（界面据此渲染「确认写入」按钮）', async () => {
  const args = { cards: [{ title: '批次样例', body: '正文' }], topic: '测试主题' }
  const result = await save.execute(args, exec)
  const meta = save.output.presentationMeta(args, result)
  assert.ok(meta.kbSave, '缺 kbSave —— 界面就没有「确认写入 N 条」按钮')
  assert.equal(meta.kbSave.batchId, result.batchId)
  assert.equal(meta.kbSave.count, 1)
})
await check('预览出来的卡片没有 id（界面据此不给可写库的动作）', async () => {
  const args = { cards: [{ title: '没落盘的卡', body: '正文' }], topic: '测试主题' }
  const result = await save.execute(args, exec)
  const meta = save.output.presentationMeta(args, result)
  assert.equal(meta.kbCards[0].id, null, '预览卡不该带 id —— 拿旧 id 去编辑会改错东西')
  assert.equal(meta.kbCards[0].role, 'new', '但角色仍要说明这是「本次新增」')
})
await check('检索与清单的卡片角色是「库中已有」', async () => {
  const result = await entriesTool.execute({ topic: '测试主题' }, exec)
  const meta = entriesTool.output.presentationMeta({}, result)
  assert.ok(meta.kbCards.length > 0, '前置条件：主题里要有条目')
  assert.ok(meta.kbCards.every(card => card.role === 'existing'), '库里的条目角色应是 existing')
})

console.log('清单的文本不能带编号、不能被当答案（2026-10-23 用户实测）')
await check('learn_entries 的文本里 id 挪到行尾，并说明它只给工具用', async () => {
  const result = entriesTool.execute({ topic: '测试主题' }, exec)
  const rendered = entriesTool.output.render({}, result)
  const text = rendered[0].text
  assert.ok(!/^- \[k_/.test(text), 'id 不能在行首 —— 模型会照抄这个格式写进回答')
  // 改 / 删工具默认不提供 → 提示里不能提这两个工具（否则模型会去调不存在的工具）
  assert.ok(!/#id 是给你调 learn_update/.test(text), '默认没有改删工具，就别提它们')
  assert.match(text, /不要写进给用户的回答/, '要明说别把 id 写给用户')
  assert.ok(text.includes('#k_'), 'id 还得留着 —— 模型要靠它定位条目')
})
await check('一次列太多条时明说「这是目录，不是答案」', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: 'k_' + i,
    title: '条目 ' + i,
    kind: 'point',
    version: 1,
    verified: false,
    tags: [],
    appliesTo: null,
    source: null,
    status: 'active',
  }))
  const rendered = entriesTool.output.render({}, {
    topic: '测试主题',
    total: 40,
    entries: many,
    facets: { appliesTo: [], tags: [], unscoped: 40 },
  })
  assert.match(rendered[0].text, /这是目录，不是答案/, '大批量枚举时要说清这不是答案')
  assert.match(rendered[0].text, /只挑相关的几条/, '要说清该怎么用这份清单')
})

console.log('定位与收窄：让模型不必整库倒（2026-10-23 用户实测 251 张卡）')
await check('learn_entries 暴露 query 参数（按关键词收窄）', async () => {
  assert.equal(typeof entriesTool.parameters.properties.query.type, 'string')
  assert.match(entriesTool.parameters.properties.query.description, /命中任一即可/)
})
await check('learn_entries 带 query 时报出每个方向各命中几条', async () => {
  const result = entriesTool.execute({ topic: '测试主题', query: '卡片视图、查无此项' }, exec)
  const rendered = entriesTool.output.render({}, result)
  assert.match(rendered[0].text, /关键词命中：/, '要报出每个关键词各几条')
  assert.match(rendered[0].text, /查无此项 0 条/, '0 条 = 库里真没有')
})
await check('learn_topics 的列表带领域分布（模型据此定位该查哪个主题）', async () => {
  // 先给主题里放一条带标签的卡（默认是预览，要落盘得再带 approved=true）：
  // 领域没标的主题靠标签让模型认出来
  const tagged = [{ title: '带标签的卡', body: '正文', tags: ['锁'], appliesTo: 'MySQL' }]
  await save.execute({ cards: tagged, topic: '测试主题' }, exec)
  await save.execute({ cards: tagged, topic: '测试主题', approved: true }, exec)
  const result = topics.execute({ action: 'list' }, exec)
  const rendered = topics.output.render({}, result)[0].text
  assert.match(rendered, /领域：/, '主题列表要带领域分布')
  assert.match(rendered, /标签：/, '领域没标的主题靠标签认出来')
})
await check('卡片来源要报给界面（列出 ≠ 命中）', async () => {
  const listed = entriesTool.execute({ topic: '测试主题' }, exec)
  assert.equal(entriesTool.output.presentationMeta({}, listed).kbCardSource, 'entries')
  const hit = await search.execute({ query: '卡片视图', topic: '测试主题' }, exec)
  assert.equal(search.output.presentationMeta({}, hit).kbCardSource, 'search')
  const preview = await save.execute({ cards: [{ title: '来源样例', body: '正文' }], topic: '测试主题' }, exec)
  assert.equal(save.output.presentationMeta({ cards: [{ title: '来源样例', body: '正文' }] }, preview).kbCardSource, 'save')
})

console.log('提议补条目（learn_propose，2026-10-23）')
const proposeTool = registered.get('learn_propose')
await check('learn_propose 注册了 items 参数（只给标题 + 理由）', async () => {
  assert.ok(proposeTool, '没有注册 learn_propose')
  assert.equal(typeof proposeTool.parameters.properties.items.type, 'string')
  assert.deepEqual(proposeTool.parameters.required, ['items'])
  assert.match(proposeTool.parameters.properties.items.items.properties.title.description, /标题/)
})
await check('提议后发布 kbProposal（界面据此渲染提议条）', async () => {
  const result = proposeTool.execute({ items: [{ title: 'RAII 资源管理', why: '库里只有零散提及' }] }, exec)
  assert.equal(result.status, 'proposed')
  assert.ok(result.proposalId, '提议要给 proposalId，界面靠它换预览')
  const meta = proposeTool.output.presentationMeta({}, result)
  assert.ok(meta.kbProposal, '缺 kbProposal —— 界面上就没有提议条')
  assert.equal(meta.kbProposal.id, result.proposalId)
  assert.equal(meta.kbProposal.items[0].title, 'RAII 资源管理')
})
await check('库里已有同名条目就自动跳过，不重复提议', async () => {
  const result = proposeTool.execute(
    { items: [{ title: '卡片视图样例', why: 'x' }, { title: '全新条目', why: 'y' }] },
    exec,
  )
  assert.equal(result.status, 'proposed')
  assert.equal(result.items.length, 1, '已有的那条要被跳过')
  assert.deepEqual(result.existing, ['卡片视图样例'])
})
await check('全都已存在时直接说已经有了', async () => {
  const result = proposeTool.execute({ items: [{ title: '卡片视图样例', why: 'x' }] }, exec)
  assert.equal(result.status, 'already')
  const rendered = proposeTool.output.render({}, result)[0].text
  assert.match(rendered, /已经有了/)
})

console.log('工具限制：不能动宿主接管面')
await check('注册了 agent/created 监听', async () => {
  assert.ok(listeners.get('agent/created'), '应注册 agent/created 监听')
})

await check('deny 列表绝不包含 ops_* / pwsh / MUST_KEEP 里的工具', async () => {
  for (const name of DENY_TOOLS) {
    assert.ok(!name.startsWith('ops_'), `ops_ 系列不能被限制：${name}`)
    assert.notEqual(name, 'pwsh', 'pwsh 属于 dsh-ops 接管面')
    assert.ok(!MUST_KEEP.includes(name), `MUST_KEEP 里的工具不能被限制：${name}`)
  }
})

await check('MUST_KEEP 覆盖宿主 hide-official 要求的 8 个 OPS 替身', async () => {
  const required = ['ops_replace', 'ops_write_file', 'ops_edit_file', 'ops_diff', 'ops_stat', 'ops_copy', 'ops_move', 'ops_remove']
  for (const name of required) {
    assert.ok(MUST_KEEP.includes(name), `MUST_KEEP 缺 ${name}`)
  }
})

await check('实际限制时不会砍掉接管面（模拟宿主调用）', async () => {
  const applied = []
  const fakeTools = {
    get(name) {
      return { name }
    },
    restrict(filter) {
      applied.push(filter)
      return () => applied.pop()
    },
  }
  listeners.get('agent/created').call({ ctx: { tools: fakeTools } })
  assert.equal(applied.length, 1, '应调用了一次 restrict')
  const deny = applied[0].deny
  for (const name of MUST_KEEP) assert.ok(!deny.includes(name), `${name} 不该被限制`)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

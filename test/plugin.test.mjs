// 学习模式 KB 插件 · 插件级自测（node test/plugin.test.mjs）
// 用 mock ctx 跑通：工具注册 → 建主题 → 预览 → 落盘 → 检索 → 更新 → 归档 → 列出。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-plugin-'))
process.env.DSH_LEARN_ROOT = root

const { apply, name, inject, DENY_TOOLS } = await import('../plugin/tools.js')

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

console.log('插件元信息')
await check('导出 name / inject / apply', async () => {
  assert.equal(name, 'learning-kb')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

const registered = new Map()
const approvalCalls = []
let approvalOutcome = 'unavailable'
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  on() {},
  get(name) {
    if (name !== 'approval') return undefined
    return {
      request(payload) {
        approvalCalls.push(payload)
        return Promise.resolve(approvalOutcome)
      },
    }
  },
}
// 这组用例要覆盖改 / 删条目的工具 → 显式打开（默认不暴露给模型，见 tools-schema 用例）
process.env.DSH_KB_EDIT = '1'
apply(ctx, {})

console.log('工具注册')
await check('注册了 7 个工具', async () => {
  assert.deepEqual(
    Array.from(registered.keys()).sort(),
    ['learn_delete', 'learn_entries', 'learn_propose', 'learn_save', 'learn_search', 'learn_topics', 'learn_update'],
  )
})
// 工具 description / 参数说明也是模型看得见的提示词 —— 关键规则可以放在那里
const toolPromptText = () =>
  Array.from(registered.values())
    .map(
      tool =>
        String(tool.description || '') +
        ' ' +
        Object.values(tool.parameters?.properties || {})
          .map(param => String(param.description || ''))
          .join(' '),
    )
    .join('\n')
await check('每个工具都有 schema 与 execute', async () => {
  for (const tool of registered.values()) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

const exec = { agent: { id: 'sess-1' } }
const topics = registered.get('learn_topics')
const search = registered.get('learn_search')
const save = registered.get('learn_save')
const update = registered.get('learn_update')
const remove = registered.get('learn_delete')
const entries = registered.get('learn_entries')

console.log('主题管理')
await check('新建主题并绑定当前会话', async () => {
  const result = topics.execute({ action: 'create', name: 'MySQL 进阶', description: '存储引擎与事务', keywords: ['innodb'] }, exec)
  assert.equal(result.current.slug, 'mysql-进阶')
  assert.equal(result.current.count, 0)
})
await check('未绑定会话看不到该主题', async () => {
  const other = topics.execute({ action: 'current' }, { agent: { id: 'sess-2' } })
  assert.equal(other.current, null)
  assert.equal(other.topics.length, 1)
})
await check('按关键词模糊查找主题', async () => {
  const result = topics.execute({ action: 'find', name: 'innodb' }, exec)
  assert.equal(result.found.slug, 'mysql-进阶')
})

console.log('写入：先预览再写（2026-10-23 用户要流程）')
let entryId = ''
const card = {
  title: '间隙锁',
  body: '间隙锁锁住索引记录之间的间隙，阻止插入。',
  tags: ['lock'],
  source: { type: 'file', ref: '课件第 5 页', locator: 'p.5' },
  appliesTo: 'MySQL 8.0',
}
await check('默认只出预览、不写库（用户先看到内容再决定）', async () => {
  const result = await save.execute({ cards: [card] }, exec)
  assert.equal(result.status, 'preview')
  assert.equal(result.dryRun, true)
  assert.equal(result.plan[0].action, 'create')
  assert.ok(result.batchId, '预览要给出 batchId —— 界面上的「确认写入」按钮靠它')
  assert.equal(entries.execute({}, exec).total, 0, '预览不应写盘')
})
await check('预览过之后带 approved=true 能落盘（按钮不可用时的降级路径）', async () => {
  const result = await save.execute({ approved: true, cards: [card] }, exec)
  assert.equal(result.status, 'written')
  assert.equal(result.total, 1)
  entryId = entries.execute({}, exec).entries[0].id
})
await check('没预览过的内容带 approved=true 会被拒', async () => {
  await assert.rejects(
    () => save.execute({ approved: true, cards: [{ title: '没预览', body: '正文' }] }, exec),
    /还没有预览过/,
  )
})
await check('mode=commit 时弹宿主确认框，用户点了就写盘', async () => {
  approvalOutcome = 'allowed-once'
  const before = approvalCalls.length
  // 写进单独的主题：不污染主主题的条目计数（后面几条用例在数它）
  const result = await save.execute(
    { cards: [{ title: '确认框样例', body: '讲的是刷脏页的机制。' }], topic: '确认框测试主题', mode: 'commit' },
    exec,
  )
  assert.equal(result.status, 'written')
  assert.equal(approvalCalls.length, before + 1, '应弹过一次确认框')
  assert.match(approvalCalls[approvalCalls.length - 1].reason, /确认框样例/, '确认框里应显示卡片标题')
  assert.equal(approvalCalls[approvalCalls.length - 1].toolName, 'learn_save')
  approvalOutcome = 'unavailable'
})
await check('确认框里带正文首行（用户看得见内容才敢点头）', async () => {
  // 用「拒绝」触发：确认框照样弹、照样有内容，但一条也不落盘
  approvalOutcome = 'rejected'
  await save.execute(
    { cards: [{ title: '带正文的卡', body: '首行是结论：这样写用户才看得懂。\n- 要点一' }], mode: 'commit' },
    exec,
  )
  const reason = approvalCalls[approvalCalls.length - 1].reason
  assert.match(reason, /首行是结论：这样写用户才看得懂。/, '确认框里应能看到正文首行')
  approvalOutcome = 'unavailable'
})
await check('mode=commit 且用户拒绝时库不落盘', async () => {
  approvalOutcome = 'rejected'
  const before = entries.execute({}, exec).total
  const result = await save.execute({ cards: [{ title: '被拒的卡片', body: '正文' }], mode: 'commit' }, exec)
  assert.equal(result.status, 'rejected')
  assert.equal(entries.execute({}, exec).total, before, '拒绝后库不能变')
  approvalOutcome = 'unavailable'
})
await check('mode=commit 但确认框不可用时降级成预览、不落盘', async () => {
  approvalOutcome = 'unavailable'
  const before = entries.execute({}, exec).total
  const result = await save.execute({ cards: [{ title: '降级的卡片', body: '正文' }], mode: 'commit' }, exec)
  assert.equal(result.status, 'preview')
  assert.equal(entries.execute({}, exec).total, before, '降级也不能写盘')
})
await check('入库条目带出处类型/核实标记/适用范围', async () => {
  const entry = entries.execute({}, exec).entries[0]
  assert.equal(entry.source.type, 'file')
  assert.equal(entry.source.locator, 'p.5')
  assert.equal(entry.verified, false)
  assert.equal(entry.appliesTo, 'MySQL 8.0')
})
await check('检索命中并带出处', async () => {
  const result = await search.execute({ query: '间隙锁' }, exec)
  assert.equal(result.scope, 'mysql-进阶')
  assert.equal(result.hits[0].title, '间隙锁')
  assert.equal(result.hits[0].source.type, 'file')
  assert.equal(result.hits[0].appliesTo, 'MySQL 8.0')
})
await check('整体库检索也能命中', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'all' }, exec)
  assert.equal(result.scope, 'all')
  assert.equal(result.hits.length, 1)
})
await check('未绑定主题时仍按整体库检索（整体库这一级不跳过），并提示去绑定主题', async () => {
  const result = await search.execute({ query: '间隙锁' }, { agent: { id: 'sess-3' } })
  assert.equal(result.currentTopic, null)
  assert.equal(result.hits.length, 1, '整体库应该能查到')
  assert.match(result.note, /没绑定主题/)
})

await check('scope=auto 标出当前主题的命中', async () => {
  const result = await search.execute({ query: '间隙锁' }, exec)
  assert.equal(result.hits[0].fromCurrent, true)
  assert.equal(result.hits[0].topic, 'mysql-进阶')
})

await check('scope=topic 只查当前主题', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'topic' }, exec)
  assert.equal(result.scope, 'mysql-进阶')
  assert.equal(result.hits.length, 1)
})

await check('scope=auto 当前主题命中不够时用其它主题补齐', async () => {
  const otherExec = { agent: { id: 'sess-other' } }
  topics.execute({ action: 'create', name: '其它主题' }, otherExec)
  const otherCard = { title: '另一种锁', body: '另一种锁的机制说明。' }
  await save.execute({ cards: [otherCard] }, otherExec)
  await save.execute({ approved: true, cards: [otherCard] }, otherExec)
  const result = await search.execute({ query: '另一种锁' }, exec)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].fromCurrent, false)
  assert.equal(result.hits[0].topic, '其它主题')
})

console.log('修改与归档')
await check('更新条目并升版本（版本号 = 时间戳）', async () => {
  const before = entries.execute({}, exec).entries[0].version
  const result = update.execute({ id: entryId, verified: true }, exec)
  assert.ok(result.version >= 1e12, '版本号应该是时间戳：' + result.version)
  assert.ok(result.version > Number(before), '新版本号要比旧的大')
  const entry = entries.execute({}, exec).entries[0]
  assert.equal(entry.verified, true)
})
await check('归档后检索不再返回', async () => {
  const result = remove.execute({ id: entryId }, exec)
  assert.equal(result.mode, 'archived')
  assert.equal((await search.execute({ query: '间隙锁' }, exec)).hits.length, 0)
  assert.equal(entries.execute({ status: 'archived' }, exec).total, 1)
})
await check('归档条目可恢复（再次写入即恢复原条目）', async () => {
  const restored = [{ title: '间隙锁', body: '（恢复）间隙锁阻止插入。' }]
  await save.execute({ cards: restored }, exec) // 先预览
  const result = await save.execute({ approved: true, cards: restored }, exec)
  assert.equal(result.plan[0].action, 'restore')
  assert.equal(entries.execute({ status: 'active' }, exec).total, 1)
  assert.equal(entries.execute({ status: 'archived' }, exec).total, 0)
  assert.equal((await search.execute({ query: '间隙锁' }, exec)).hits.length, 1)
})

console.log('渲染')
await check('预览渲染标注「未写入」', async () => {
  const result = await save.execute({ cards: [{ title: '渲染测试', body: 'x' }] }, exec)
  const rendered = save.output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /预览，未写入/)
})
await check('检索渲染含命中与出处', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'all' }, exec)
  const rendered = search.output.render({}, result)
  assert.match(rendered[0].text, /间隙锁/)
  assert.match(rendered[0].text, /来源 文件/)
})

await check('设置默认主题后，新会话自动落到它', async () => {
  topics.execute({ action: 'default', name: 'MySQL 进阶' }, exec)
  const fresh = topics.execute({ action: 'current' }, { agent: { id: 'sess-brand-new' } })
  assert.equal(fresh.current.slug, 'mysql-进阶')
  assert.equal(fresh.currentFromDefault, true)
})
await check('清除默认主题', async () => {
  topics.execute({ action: 'default', name: '' }, exec)
  const fresh = topics.execute({ action: 'current' }, { agent: { id: 'sess-brand-new-2' } })
  assert.equal(fresh.current, null)
})

console.log('磁盘落盘')
await check('落盘为 JSONL 且含新字段', async () => {
  const file = path.join(root, 'topics', 'mysql-进阶', 'kb.jsonl')
  assert.ok(fs.existsSync(file))
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.source.type, 'file')
  assert.equal(entry.appliesTo, 'MySQL 8.0')
  assert.equal(entry.status, 'active')
  assert.equal(entry.verified, true)
})

console.log('同主题近似重复检测')
await check('内容相近、标题不同 → 疑似重复提示', async () => {
  const dedupeExec = { agent: { id: 'sess-dedupe' } }
  topics.execute({ action: 'create', name: '去重测试主题' }, dedupeExec)
  const first = { title: '间隙锁要点', body: '间隙锁锁住索引记录之间的间隙，阻止其他事务插入新行。' }
  await save.execute({ cards: [first] }, dedupeExec)
  await save.execute({ approved: true, cards: [first] }, dedupeExec)
  const second = { title: '间隙锁要点补充', body: '间隙锁锁住索引记录之间的间隙，阻止其他事务插入新行。' }
  const result = await save.execute({ cards: [second] }, dedupeExec)
  assert.ok(result.similar.length >= 1, "应识别出同主题的相近内容")
  assert.equal(result.similar[0].title, '间隙锁要点')
  assert.ok(Array.isArray(result.nearby), "应返回同主题相关条目清单")
})

await check('内容不相近 → 不报疑似重复', async () => {
  const dedupeExec = { agent: { id: 'sess-dedupe' } }
  const result = await save.execute({ cards: [{ title: '完全另一件事', body: '讲的是缓冲池刷脏页的机制，跟锁没有关系。' }] }, dedupeExec)
  assert.equal(result.similar.length, 0)
})

console.log('重排缓存（审计 P1-5）')
// 给 ctx 挂一个假模型：统计它被调了几次。挂上之前的用例不受影响（那时没有模型，走本地排序）。
const originalGet = ctx.get
let modelCalls = 0
let mockMatchId = ''
let lastPrompt = ''
// 按方向分批重排的用例要「每个方向各判自己池里的第一条」，这里给个开关
let fakePerDirection = false
// 贪心模型：把所有候选都判成命中/相关（用户实测「皮命中太多」的极端情况）
let fakeGreedy = false
const fakePrompts = []
ctx.get = (serviceName) => {
  if (serviceName === 'llm') {
    return {
      stream(input) {
        modelCalls++
        try {
          lastPrompt = String(input && input.messages[0] && input.messages[0].content[0].text || '')
        } catch {
          lastPrompt = ''
        }
        fakePrompts.push(lastPrompt)
        const ids = [...lastPrompt.matchAll(/id=([^\s《]+)/g)].map(match => match[1])
        const verdict = fakeGreedy
          ? { match: ids.slice(0, 4), related: ids.slice(4), drop: [] }
          : fakePerDirection
            ? { match: ids.slice(0, 1), related: ids.slice(1, 3), drop: ids.slice(3) }
            : { match: mockMatchId ? [mockMatchId] : [], related: [], drop: [] }
        return (async function* () {
          yield { type: 'text-delta', text: JSON.stringify(verdict) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  }
  return originalGet(serviceName)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await check('同一个问题连搜两次，第二次走缓存不再调模型', async () => {
  const cacheExec = { agent: { id: 'sess-cache' } }
  topics.execute({ action: 'create', name: '缓存测试主题' }, cacheExec)
  const card = { title: '缓存测试卡片', body: '这条内容专门用来测重排缓存。' }
  await save.execute({ cards: [card] }, cacheExec)
  await save.execute({ approved: true, cards: [card] }, cacheExec)
  // 假模型要能真的判出一条命中，否则会被当成「模型失败」，按设计不入缓存
  const listed = entries.execute({}, cacheExec)
  mockMatchId = (listed.entries.find(entry => entry.title === '缓存测试卡片') || {}).id || ''

  const before = modelCalls
  const first = await search.execute({ query: '缓存测试卡片', scope: 'all' }, cacheExec)
  assert.equal(modelCalls, before + 1, '第一次应该真的调一次模型')
  assert.equal(first.rerank.cached, false)
  assert.equal(first.rerank.used, true, '假模型判出了命中')

  const second = await search.execute({ query: '缓存测试卡片', scope: 'all' }, cacheExec)
  assert.equal(modelCalls, before + 1, '第二次不该再调模型')
  assert.equal(second.rerank.cached, true, '第二次应该标记为命中缓存')
  assert.equal(second.rerank.usage, null, '走缓存没有新的调用，不该再报一次用量')
  assert.equal(second.hits.length, first.hits.length, '缓存的结果要和第一次一样')
})

await check('知识库一改，缓存自动作废（会重新调模型）', async () => {
  const cacheExec = { agent: { id: 'sess-cache' } }
  // 先自己把缓存热起来，这条用例不依赖上一条的执行顺序
  await search.execute({ query: '缓存测试卡片', scope: 'all' }, cacheExec)
  const before = modelCalls
  await search.execute({ query: '缓存测试卡片', scope: 'all' }, cacheExec)
  assert.equal(modelCalls, before, '这一步应该还在缓存期内')
  // 往库里写一条 → kb.jsonl 的 mtime 变了 → 缓存键跟着变
  await sleep(30)
  const card = { title: '缓存测试卡片二', body: '又一条内容，用来让知识库变一下。' }
  await save.execute({ cards: [card] }, cacheExec)
  await save.execute({ approved: true, cards: [card] }, cacheExec)
  await search.execute({ query: '缓存测试卡片', scope: 'all' }, cacheExec)
  assert.equal(modelCalls, before + 1, '知识库改过之后应该重新调模型')
})

// ------------------------------------------------- 多方向检索：按方向分批问模型
// 2026-10-23 用户两次反馈：
//   ① 「一次调用塞 4 个方向 + 16 条候选」实测不准 —— 函数重载 / inline / this 指针被当成命中；
//   ② 「如果不只 4 个方向，那你数量永远是 16，这就不对」。
// 定案：方向有几个就调几次模型，每个方向只用用户自己的词（不改写）。
console.log('多方向检索：按方向分批问模型')
await check('四个方向 → 调四次模型，每个方向的提示词里就是那个方向的原词', async () => {
  const dirExec = { agent: { id: 'sess-dirs' } }
  topics.execute({ action: 'create', name: '方向测试' }, dirExec)
  const cards = [
    { title: 'STL 组件与容器分类', body: '容器 算法 迭代器 仿函数 适配器 分配器', appliesTo: 'C++' },
    { title: '万能引用完美转发与智能指针', body: 'shared_ptr unique_ptr 引用折叠', appliesTo: 'C++' },
    { title: 'RAII 资源管理思想', body: '构造获取资源 析构释放资源', appliesTo: 'C++' },
    { title: 'C++11新特性与左值右值', body: '右值引用 移动语义', appliesTo: 'C++' },
  ]
  await save.execute({ cards }, dirExec)
  await save.execute({ approved: true, cards }, dirExec)
  mockMatchId = ''
  fakePrompts.length = 0
  fakePerDirection = true
  const result = await search.execute(
    { query: 'STL、智能指针、RAII、C++11 新特性', topic: '方向测试', limit: 4 },
    dirExec,
  )
  fakePerDirection = false
  assert.equal(fakePrompts.length, 4, '四个方向应该各调一次模型，实际 ' + fakePrompts.length + ' 次')
  const asked = fakePrompts.map(prompt => (prompt.match(/用户问题：(.+)/) || [, ''])[1].trim())
  assert.deepEqual(asked, ['STL', '智能指针', 'RAII', 'C++11 新特性'], '每次只问一个方向，而且用原词')
  const titles = result.hits.map(hit => hit.title)
  for (const title of cards.map(card => card.title)) {
    assert.ok(titles.includes(title), '每个方向的条目都要出现在命中里：' + title)
  }
  // 逐方向结果：模型和用户都要能看出「哪个方向有、哪个没有」
  assert.ok(Array.isArray(result.directions), '要给出逐方向结果')
  assert.deepEqual(
    result.directions.map(item => item.direction),
    ['STL', '智能指针', 'RAII', 'C++11 新特性'],
  )
  for (const item of result.directions) assert.ok(item.matched >= 1, item.direction + ' 应该有命中')
})

await check('有的方向库里有、有的没有时，工具文本要逐方向说清楚（不能拿沾边的冒充）', async () => {
  // 2026-10-23 用户自己删掉两条来测的正是这个场景：混着发的时候，
  // 以前整段糊成一片，模型只能拿字面沾边的顶上。
  const mixedExec = { agent: { id: 'sess-mixed' } }
  topics.execute({ action: 'create', name: '混合测试' }, mixedExec)
  const cards = [{ title: 'RAII 资源管理思想', body: '构造获取资源 析构释放资源', appliesTo: 'C++' }]
  await save.execute({ cards }, mixedExec)
  await save.execute({ approved: true, cards }, mixedExec)
  mockMatchId = ''
  fakePrompts.length = 0
  fakePerDirection = true
  const result = await search.execute(
    { query: 'RAII、量子计算', topic: '混合测试', appliesTo: 'C++', limit: 3 },
    mixedExec,
  )
  fakePerDirection = false
  const text = search.output.render({}, result)[0].text
  assert.match(text, /RAII：命中 1 条/, '有命中的方向要报出来')
  assert.match(text, /量子计算：库里没有对应条目/, '没有的方向要如实说没有')
  assert.match(text, /不要拿"最接近的那条"冒充答案/, '要提醒模型别拿沾边的冒充')
  const raii = result.hits.find(hit => hit.title === 'RAII 资源管理思想')
  assert.ok(raii, '有的那个方向照常出卡片')
})

console.log('多方向检索：独立条目判定 / 补池 / 并行（2026-10-23 用户实测：相关只有 1 条、思考 2 分钟）')

await check('方向词只在别的条目正文里顺带提到 → 不算这个方向的独立条目', async () => {
  const indepExec = { agent: { id: 'sess-indep' } }
  topics.execute({ action: 'create', name: '独立判定' }, indepExec)
  const cards = [
    // 标题里没有 RAII，只在正文里提了一句 —— 不该被当成 RAII 的条目
    { title: 'C语言与C++的区别', body: 'C++ 标准库引入了 STL、智能指针、RAII 等特性。', appliesTo: 'C++' },
    { title: 'RAII 资源管理思想', body: '构造获取资源 析构释放资源', appliesTo: 'C++' },
  ]
  await save.execute({ cards }, indepExec)
  await save.execute({ approved: true, cards }, indepExec)
  mockMatchId = ''
  fakePrompts.length = 0
  fakePerDirection = true
  const result = await search.execute(
    { query: 'RAII、C语言与C++的区别', topic: '独立判定', appliesTo: 'C++', limit: 3 },
    indepExec,
  )
  fakePerDirection = false
  const byDirection = result.directions || []
  const raii = byDirection.find(item => item.direction === 'RAII')
  assert.ok(raii, '要逐方向给出结果')
  assert.equal(raii.independent, true, '标题里就是 RAII → 有独立条目')
})

await check('方向有独立条目时，池子里要补上同领域、标签相近的条目（相关才多起来）', async () => {
  const padExec = { agent: { id: 'sess-pad' } }
  topics.execute({ action: 'create', name: '补池测试' }, padExec)
  const cards = [
    { title: 'STL 组件与容器分类', body: '容器 算法 迭代器 仿函数 适配器 分配器', tags: ['C++', 'STL', '迭代器'], appliesTo: 'C++' },
    { title: 'vector迭代器失效问题', body: '底层空间一换，旧迭代器就失效', tags: ['C++', '迭代器'], appliesTo: 'C++' },
    { title: '完全无关的条目', body: '讲的是缓冲池刷脏页的机制', tags: ['mysql'], appliesTo: 'MySQL' },
  ]
  await save.execute({ cards }, padExec)
  await save.execute({ approved: true, cards }, padExec)
  mockMatchId = ''
  fakePrompts.length = 0
  fakePerDirection = true
  // 补池只作用在「按方向分批」这条路径上（多方向提问），单方向的具体问题不补，避免噪声
  await search.execute({ query: 'STL、智能指针', topic: '补池测试', appliesTo: 'C++', limit: 3 }, padExec)
  fakePerDirection = false
  const stlPrompt = fakePrompts.find(prompt => /用户问题：STL/.test(prompt))
  assert.ok(stlPrompt, '要有问 STL 的那次调用')
  assert.match(stlPrompt, /vector迭代器失效问题/, '同标签的同领域条目要补进池子，模型才能挑出 related')
  assert.ok(!/完全无关的条目/.test(stlPrompt), '别的领域的条目不该进来')
})

await check('多个方向是并行问模型的（串行 4 次要思考 2 分钟）', async () => {
  const parExec = { agent: { id: 'sess-par' } }
  topics.execute({ action: 'create', name: '并行测试' }, parExec)
  const cards = [
    { title: 'STL 组件与容器分类', body: '容器 算法 迭代器', tags: ['STL'], appliesTo: 'C++' },
    { title: '万能引用完美转发与智能指针', body: 'shared_ptr unique_ptr', tags: ['智能指针'], appliesTo: 'C++' },
    { title: 'RAII 资源管理思想', body: '构造获取 析构释放', tags: ['RAII'], appliesTo: 'C++' },
    { title: 'C++11新特性与左值右值', body: '右值引用 移动语义', tags: ['C++11'], appliesTo: 'C++' },
  ]
  await save.execute({ cards }, parExec)
  await save.execute({ approved: true, cards }, parExec)
  mockMatchId = ''
  fakePrompts.length = 0
  fakePerDirection = true
  const started = Date.now()
  await search.execute({ query: 'STL、智能指针、RAII、C++11 新特性', topic: '并行测试', appliesTo: 'C++', limit: 4 }, parExec)
  fakePerDirection = false
  const elapsed = Date.now() - started
  assert.equal(fakePrompts.length, 4, '四个方向各问一次')
  assert.ok(elapsed < 150, '四个方向要并行，不能串行（串行 4 次约 2 分钟），实测 ' + elapsed + 'ms')
})

// ------------------------------------------------- 具体问题要少而准（2026-10-23 用户实测）
// 「我搜索一个问题，但是他给我匹配了很多卡片，明明有一个卡片是比较合适的，完全够用，
//   他还有很多的皮命中了。很多卡片，而且还有很多相关知识点」
console.log('具体问题：命中要少而准')
await check('主题本身就是领域：条目没标 appliesTo 时用主题的 domain 兜底', async () => {
  // 2026-10-23 用户定：「不能依赖领域，不是所有的文件或者临时加的知识都能提取到领域，
  // 某种程度上来说主题就是一种领域，那么 mysql-进阶 主题的知识点的领域都是 mysql 就行了」
  const exec2 = { agent: { id: 'sess-topic-domain' } }
  topics.execute({ action: 'create', name: '主题领域测试', domain: 'MySQL' }, exec2)
  const cards = [
    { title: '间隙锁是什么', body: '锁住索引记录之间的间隙，阻止插入' },
    { title: '死锁是怎么发生的', body: '两个事务互相等对方释放锁' },
  ]
  await save.execute({ cards }, exec2)
  await save.execute({ approved: true, cards }, exec2)
  mockMatchId = ''
  fakeGreedy = true
  // 范围性问题（「MySQL 有哪些」）才该按领域收窄
  const scopeQuery = await search.execute(
    { query: 'MySQL 有哪些', topic: '主题领域测试', appliesTo: 'MySQL', limit: 5 },
    exec2,
  )
  // 具体问题不按领域收窄（领域要先猜，猜错就把答案过滤掉）
  const specific = await search.execute(
    { query: '间隙锁是什么', topic: '主题领域测试', appliesTo: 'MySQL', limit: 5 },
    exec2,
  )
  fakeGreedy = false
  assert.equal(scopeQuery.appliesToApplied, 'mysql', '范围性问题要真按领域收窄')
  assert.equal(specific.appliesToApplied, null, '具体问题不按领域收窄')
  assert.match(specific.note, /具体问题/, '要说清为什么没按领域筛')
  assert.ok(specific.hits.some(hit => hit.title === '间隙锁是什么'), '具体问题要能找到答案')

  const list = topics.execute({ action: 'list' }, exec2)
  const topic = list.topics.find(item => item.slug === '主题领域测试')
  assert.equal(topic.domain, 'MySQL', '主题列表要带上主题领域')
  assert.deepEqual(topic.domains.map(item => item.value), ['MySQL'], '领域分布要用主题领域兜底')
})

await check('领域收窄不能把当前主题清空（没标领域的条目要照样能搜到）', async () => {
  // 2026-10-23 用户实测的真凶：mysql-进阶 的条目一条都没标 appliesTo，
  // 模型传了 appliesTo="MySQL" → 当前主题被过滤成 0 条 → 检索退到别的主题的 9 条皮命中。
  // 现在：范围性问题才会走收窄；收窄后清空了就回退并在 note 里说明。
  const exec2 = { agent: { id: 'sess-fallback' } }
  topics.execute({ action: 'create', name: '没标领域的主题' }, exec2)
  const cards = [
    { title: '间隙锁是什么', body: '锁住索引记录之间的间隙，阻止插入' },
    { title: '死锁是怎么发生的', body: '两个事务互相等对方释放锁' },
  ]
  await save.execute({ cards }, exec2)
  await save.execute({ approved: true, cards }, exec2)
  mockMatchId = ''
  fakePrompts.length = 0
  fakeGreedy = true
  const result = await search.execute(
    { query: 'MySQL 有哪些', topic: '没标领域的主题', appliesTo: 'MySQL', limit: 5 },
    exec2,
  )
  fakeGreedy = false
  assert.ok(
    result.hits.some(hit => hit.title === '间隙锁是什么'),
    '没标领域的条目也要能被搜到（收窄清空主题时要回退）',
  )
  assert.equal(result.appliesToApplied, null, '收窄没生效时要如实说没生效')
  assert.match(result.note, /既没有标领域、也没设主题领域/, '并且要说清楚为什么回退')
})

await check('具体问题下命中最多 2 条、相关最多 3 条（贪心模型也不行）', async () => {
  const exec2 = { agent: { id: 'sess-exact' } }
  topics.execute({ action: 'create', name: '精确测试' }, exec2)
  const cards = [
    { title: '间隙锁是什么', body: '锁住索引记录之间的间隙，阻止插入', appliesTo: 'MySQL' },
    { title: '临键锁', body: '记录锁 + 间隙锁', appliesTo: 'MySQL' },
    { title: 'next-key lock', body: '记录锁加间隙锁', appliesTo: 'MySQL' },
    { title: '插入意向锁', body: '插入前加的锁', appliesTo: 'MySQL' },
    { title: '记录锁', body: '锁住索引记录本身', appliesTo: 'MySQL' },
    { title: '自增锁', body: 'auto_increment 相关', appliesTo: 'MySQL' },
  ]
  await save.execute({ cards }, exec2)
  await save.execute({ approved: true, cards }, exec2)
  mockMatchId = ''
  fakePrompts.length = 0
  fakeGreedy = true
  const result = await search.execute(
    { query: '间隙锁是什么', topic: '精确测试', appliesTo: 'MySQL', limit: 6 },
    exec2,
  )
  fakeGreedy = false
  assert.ok(result.hits.length <= 2, '命中最多 2 条，实际 ' + result.hits.length)
  assert.ok(result.related.length <= 3, '相关最多 3 条，实际 ' + result.related.length)
  assert.ok(result.hits.some(hit => hit.title === '间隙锁是什么'), '最直接的那条要在')
})

await check('领域补全只在「问的就是这个领域」时做，具体问题不补皮命中', async () => {
  const exec2 = { agent: { id: 'sess-pad2' } }
  topics.execute({ action: 'create', name: '补全测试' }, exec2)
  const cards = [
    { title: 'C++ 领域条目一', body: '讲 C++ 的某一点', appliesTo: 'C++' },
    { title: 'C++ 领域条目二', body: '讲 C++ 的另一点', appliesTo: 'C++' },
    { title: 'C++ 领域条目三', body: '讲 C++ 的第三点', appliesTo: 'C++' },
  ]
  await save.execute({ cards }, exec2)
  await save.execute({ approved: true, cards }, exec2)
  mockMatchId = ''
  fakeGreedy = false
  fakePerDirection = true
  const domainQuery = await search.execute({ query: 'C++', topic: '补全测试', appliesTo: 'C++', limit: 3 }, exec2)
  const specific = await search.execute({ query: '讲 C++ 的某一点是什么', topic: '补全测试', appliesTo: 'C++', limit: 3 }, exec2)
  fakePerDirection = false
  assert.ok(
    domainQuery.hits.some(hit => hit.padded),
    '问领域本身时要把该领域的条目补齐',
  )
  assert.ok(
    !specific.hits.some(hit => hit.padded),
    '具体问题不能补皮命中',
  )
})

// ------------------------------------------------- persona（预设里的行为规则）
// 2026-10-23 用户实测反馈的两点，都落在 persona 上：
//   ① 提议补条目的那行文字太不显眼 → 改用 ask_user_question 结构化提问
//   ② 「库里有」和「库里没有」的文本混在一起 → 要求分开写
// persona 改坏了这里没人会发现，所以钉两条。
console.log('persona：提议要显眼、库里有/没有要分开')
const personaText = fs.readFileSync(path.join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
await check('persona 写了「提议要用 ask_user_question 问」', async () => {
  assert.match(personaText, /ask_user_question/, 'persona 必须点名用结构化提问，别让模型只在正文里问一句')
  assert.match(personaText, /太不显眼/, '要留着这条理由，防止以后被当成多余的话删掉')
})
await check('persona 写了「库里有」和「库里没有」要分开写', async () => {
  assert.match(personaText, /「库里有」和「库里没有」要分开写/)
})
await check('persona 提醒 ask_user_question 超时不算同意', async () => {
  assert.match(personaText, /就是没同意/, '没同意就不能往下写卡片')
})
await check('预设里挂着 ask_user_question 工具行（persona 点名要用它）', async () => {
  assert.match(personaText, /@deepseek-ai\/dsh-tool-ask-user/, '预设里没有这个工具行，persona 就是空指令')
})
await check('deny 列表没有把 ask_user_question 限掉', async () => {
  assert.ok(!DENY_TOOLS.includes('ask_user_question'), '提议提问要能调用')
})

// 2026-10-23 用户实测：「文本太挤，还有各种代码块，简直看不下去」
// 根因是 markdown 单个换行会被合并成空格，模型一行一行写就坨成一块。
await check('persona 写了回答排版：靠空行分段', async () => {
  assert.match(personaText, /回答排版/, '缺排版规则')
  assert.match(personaText, /单个换行合并成空格/, '要说清为什么必须用空行')
  assert.match(personaText, /空一行/, '要给出具体的分段写法')
})
await check('persona 要求分点用列表、重点用粗体（用户要「分点 + 突出重点」）', async () => {
  assert.match(personaText, /分点用 markdown 列表/, '散文靠软换行会坨成一段，列表不会')
  assert.match(personaText, /粗体关键词/, '每条小点要粗体点出关键词')
})
await check('persona 要求「一张卡片 = 小标题 + 2-4 条小点」，不省字', async () => {
  assert.match(personaText, /一张卡片 = 一个粗体小标题/, '用户要每个卡片分小点')
  assert.match(personaText, /不用省文本/, '要写清这不是省字的场景')
  assert.match(personaText, /卡片里没有的内容单独一条小点/, '库里没有的要单独一条，别混进卡片小点')
})
await check('persona 要求工具调用做完再写回答（否则被折进过程组）', async () => {
  assert.match(personaText, /工具调用全部做完，最后写回答/)
  assert.match(personaText, /回答之后又调工具/, '要说清折叠的触发条件')
  assert.match(personaText, /折进「过程」里/, '要把机制说清楚，模型才知道为什么')
})
await check('persona 不许因为怕折叠就既不提议也不出卡片（2026-10-23 回归）', async () => {
  assert.match(personaText, /发现库里缺东西/, '缺东西要提议')
  assert.match(personaText, /别跳过这步直接说「不补」/, '不能跳过 learn_save 预览')
  assert.match(personaText, /不要因为怕折叠就既不问也不出卡片/, '这条是用户实测踩出来的')
})
await check('persona 要求出处标记跟卡片标题对上号', async () => {
  assert.match(personaText, /跟卡片对得上号/)
  assert.match(personaText, /标题照抄卡片标题/, '用户要靠标题去下面找对应那张卡')
})
await check('persona 不许回答正文套反引号 / 用代码块围栏', async () => {
  assert.match(personaText, /不要给普通词套反引号/, '不然后满屏灰底代码片')
  assert.match(personaText, /不要用代码块围栏/, '缺这条模型会用 ``` 把内容包起来')
  assert.match(personaText, /回答正文里用粗体或纯文字/, '要给出替代写法')
})
await check('persona 区分「要条目全集」和「要内容」（2026-10-23 实测 39 条噪声）', async () => {
  // 2026-10-23 之后：要内容的题也**不要**自己拆成四次检索（拆的时候会把方向改写窄），
  // 改成原句直传，由 learn_search 内部按「、」拆方向各召回再合池。
  // 规则可能落在 persona，也可能落在工具 description（同一事实只说一次）—— 两边都算。
  const promptText = personaText + '\n' + toolPromptText()
  assert.match(promptText, /别把一次检索拆成多次调用|枚举题和要内容的题都别把一次检索拆成四次/)
  assert.match(promptText, /原句一次交给 learn_search/, '要内容的题也是原句一次，不许自己改写方向')
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

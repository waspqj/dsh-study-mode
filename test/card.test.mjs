// 学习知识库 · 卡片交互自测（node test/card.test.mjs）
//
// 覆盖三块：
//   1) 纯逻辑：写入契约校验、提示词拼装、模型 JSON 解析
//   2) 存储层：写回正文（版本冲突 / 原版快照 / 核实回落）、回退、核实
//   3) 宿主接口：review / apply / ask / verify / rollback
//
// 其中最要紧的一条：**发给模型的 payload 里只有这张卡片，没有会话历史**。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { validateBody, buildReviewPrompt, parseReviewJson, buildAskPrompt, projectCard } from '../plugin/card.js'
import { createStore } from '../plugin/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-card-'))
process.env.DSH_LEARN_ROOT = root

const { createHandler, ROUTE_PREFIX } = await import('../plugin/index.js')

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

// ---------------------------------------------------------------- 写入契约
console.log('写入契约校验')
await check('合规正文通过', async () => {
  const result = validateBody('间隙锁锁住索引记录之间的间隙，阻止插入。\n- 只在 RR 隔离级别下有\n- 走索引才生效')
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})
await check('空正文不通过', async () => {
  assert.equal(validateBody('   ').ok, false)
})
await check('首行是要点时不通过', async () => {
  const result = validateBody('- 这是要点\n- 也是要点')
  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /首行必须是结论/)
})
await check('反引号不成对时不通过', async () => {
  const result = validateBody('结论。\n- 用 `innodb_page_size 设置')
  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /反引号/)
})
await check('【】不成对时不通过', async () => {
  const result = validateBody('结论。\n- 【重点没闭合')
  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /【】/)
})
await check('没有要点行只提示不拦', async () => {
  const result = validateBody('就一句话，没有要点行。')
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(w => /要点行/.test(w)))
})
await check('超长正文被拦', async () => {
  const result = validateBody('长'.repeat(2500))
  assert.equal(result.ok, false)
  assert.match(result.problems.join('；'), /超过/)
})

// ---------------------------------------------------------------- 提示词
console.log('提示词：上下文隔离')
const card = {
  id: 'k_1',
  title: '间隙锁',
  body: '间隙锁锁住索引记录之间的间隙，阻止插入。\n- 只在 RR 下生效',
  topic: 'mysql-进阶',
  topicName: 'MySQL 进阶',
  tags: ['lock'],
  verified: false,
  version: 3,
}
await check('校验提示词只含卡片本身', async () => {
  const { system, prompt } = buildReviewPrompt(card, 'both')
  assert.match(prompt, /间隙锁锁住索引记录之间的间隙/)
  assert.match(prompt, /MySQL 进阶/)
  assert.match(prompt, /lock/)
  assert.doesNotMatch(prompt, /会话历史/)
  assert.doesNotMatch(system, /会话历史/)
})
await check('校验提示词按模式切换任务描述', async () => {
  assert.match(buildReviewPrompt(card, 'verify').prompt, /只找事实性问题/)
  assert.match(buildReviewPrompt(card, 'expand').prompt, /只补充/)
  assert.match(buildReviewPrompt(card, 'both').prompt, /既找事实性问题/)
})
await check('追问提示词只含卡片 + 自己的追问历史', async () => {
  const { prompt } = buildAskPrompt(card, '为什么？', [{ q: '上一个问题', a: '上一个答案' }])
  assert.match(prompt, /间隙锁锁住索引记录之间的间隙/)
  assert.match(prompt, /上一个问题/)
  assert.match(prompt, /为什么？/)
})
// 2026-10-23 实测：思考型模型（MiniMax-M3.1-Flash）会把输出预算几乎全花在
// 思考上 —— 一次校验跑 100 秒、输出 4800~5900 token，正文只占几百字；
// 有时思考直接撞满 8000 撞出一个空回复，触发重试后耗时和花费都翻倍。
// 提示词里必须写明「不要输出思考过程」，否则用户看到的就是「卡很久、第一次失败」。
await check('校验提示词要求「不要输出思考过程」', async () => {
  const { system } = buildReviewPrompt(card, 'both')
  assert.match(system, /不要输出思考过程/)
})
await check('追问提示词要求「不要输出思考过程」', async () => {
  const { system } = buildAskPrompt(card, '为什么？', [])
  assert.match(system, /不要输出思考过程/)
})

// 2026-10-22 用户点「AI 校验补充」，模型回了整张 TCP/UDP 完整对照表 + 追问清单。
// 工作台只该补"卡里确实缺的事实点"，所以提示词里就要禁止这种输出，解析时再兜一层。
await check('校验提示词禁止对照表 / 教程式展开', async () => {
  const { system } = buildReviewPrompt(card, 'both')
  assert.match(system, /不要输出表格/)
  assert.match(system, /教程式清单/)
  assert.match(system, /最多 3 条/)
  // 2026-10-22 实测 DeepSeek 那次解析失败：JSON 写在长篇分析之后，被 maxTokens 截断。
  // 要求 JSON 写在第一行，截断也只是丢掉解释文字，不影响解析。
  assert.match(system, /第一行就是那个 JSON/)
  assert.match(system, /30 行以内/)
})
await check('补充要点最多 3 条，超长截断', async () => {
  const many = [1, 2, 3, 4, 5].map((i) => ({ text: '第' + i + '条' + 'x'.repeat(300) }))
  const parsed = parseReviewJson(JSON.stringify({ issues: [], additions: many, suggested: '' }))
  assert.equal(parsed.additions.length, 3, '一次最多采纳 3 条')
  for (const addition of parsed.additions) {
    assert.ok(addition.text.length <= 121, '单条要点要截断，实际 ' + addition.text.length)
    assert.ok(addition.text.endsWith('…'), '截断要有省略号')
  }
})

console.log('模型返回解析')
await check('解析标准 JSON', async () => {
  const parsed = parseReviewJson('{"issues":[{"text":"写错了","level":"error"}],"additions":[{"text":"补一条"}],"suggested":"新正文"}')
  assert.equal(parsed.parseError, false)
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0].level, 'error')
  assert.equal(parsed.additions[0].text, '补一条')
  assert.equal(parsed.suggested, '新正文')
})
await check('解析带代码围栏的 JSON', async () => {
  const parsed = parseReviewJson('```json\n{"issues":[],"additions":[],"suggested":""}\n```')
  assert.equal(parsed.parseError, false)
})
await check('解析前后带废话的 JSON', async () => {
  const parsed = parseReviewJson('好的，我看完了。{"issues":[],"additions":[],"suggested":"x"} 完毕。')
  assert.equal(parsed.parseError, false)
  assert.equal(parsed.suggested, 'x')
})
await check('模型返回垃圾时不炸', async () => {
  const parsed = parseReviewJson('完全不是 JSON')
  assert.equal(parsed.parseError, true)
  assert.deepEqual(parsed.issues, [])
})

// ---------------------------------------------------------------- 存储层
console.log('存储层：写回 / 回退 / 核实')
const store = createStore(root)
store.createTopic('MySQL 进阶', { description: 'InnoDB' })
const saved = store.planSave({
  topic: 'mysql-进阶',
  dryRun: false,
  cards: [{ title: '间隙锁', body: '间隙锁锁住索引记录之间的间隙，阻止插入。\n- 只在 RR 下生效', tags: ['lock'] }],
})
const entryId = saved.plan[0].id

await check('写回正文：版本 = 时间戳，并留下原版快照（含原版版本号）', async () => {
  const result = store.applyCardBody({ id: entryId, body: '间隙锁锁住索引记录之间的间隙。\n- 只在 RR 下生效\n- 走索引才生效' })
  assert.ok(result.version >= 1e12, '版本号应该是时间戳：' + result.version)
  const entry = store.locateEntry({ id: entryId }).entry
  assert.equal(entry.originalBody, '间隙锁锁住索引记录之间的间隙，阻止插入。\n- 只在 RR 下生效')
  assert.ok(entry.originalVersion !== undefined, '原版快照要连版本号一起存：回退时版本号才回得去')
  assert.match(entry.body, /走索引才生效/)
})
await check('版本对不上时拒绝写入（409）', async () => {
  let error = null
  try {
    store.applyCardBody({ id: entryId, body: 'x', expectedVersion: 1 })
  } catch (err) {
    error = err
  }
  assert.ok(error, '应抛错')
  assert.equal(error.status, 409)
  assert.equal(error.code, 'VERSION_CONFLICT')
})
await check('正文变了 → 核实状态自动回落未核实', async () => {
  store.setVerify({ id: entryId, state: 'verified', by: 'user', note: '我看过了' })
  assert.equal(store.locateEntry({ id: entryId }).entry.verified, true)
  store.applyCardBody({ id: entryId, body: '间隙锁锁住索引记录之间的间隙。\n- 新的要点' })
  const entry = store.locateEntry({ id: entryId }).entry
  assert.equal(entry.verified, false)
  assert.equal(entry.verify, undefined)
})
await check('核实不改正文、不升版本', async () => {
  const before = store.locateEntry({ id: entryId }).entry
  const result = store.setVerify({ id: entryId, state: 'verified', by: 'user', note: '课件 P32' })
  const after = store.locateEntry({ id: entryId }).entry
  assert.equal(result.version, before.version, '版本不应变化')
  assert.equal(after.body, before.body, '正文不应变化')
  assert.equal(after.verified, true)
  assert.equal(after.verify.state, 'verified')
  assert.equal(after.verify.by, 'user')
  assert.match(after.verify.note, /P32/)
})
await check('回退到原版：正文和版本号一起回去（不再累加）', async () => {
  // locateEntry 返回的是库里的活对象，回退会就地改它 —— 这里先拍个快照
  const before = { ...store.locateEntry({ id: entryId }).entry }
  const result = store.rollbackCard({ id: entryId })
  assert.equal(result.body, before.originalBody)
  const after = { ...store.locateEntry({ id: entryId }).entry }
  assert.equal(after.originalBody, before.body, '刚才那版成了新的原版')
  // 版本号回到原版那一版，而不是继续往上加（用户 2026-10-23 的要求）
  assert.equal(after.version, before.originalVersion, '回退后版本号要回到原版那一版')
  assert.ok(after.version < before.version, '回退后版本号应当比刚才那版小：' + after.version)
  assert.ok(after.version >= 1e12, '版本号仍然是时间戳：' + after.version)
})
await check('再退一次能回到刚才那版，版本号也跟着回来', async () => {
  const before = { ...store.locateEntry({ id: entryId }).entry }
  const result = store.rollbackCard({ id: entryId })
  assert.equal(result.body, before.originalBody)
  const after = { ...store.locateEntry({ id: entryId }).entry }
  assert.equal(after.version, before.originalVersion)
})
await check('卡片投影带核实信息', async () => {
  const entry = store.locateEntry({ id: entryId }).entry
  const projected = projectCard(entry, 'MySQL 进阶')
  assert.equal(projected.id, entryId)
  assert.equal(projected.topicName, 'MySQL 进阶')
  assert.equal(typeof projected.verified, 'boolean')
})

await check('GET /card/model 报出跟会话对齐的模型', async () => {
  const handler = createHandler({
    getOrigin: () => SELF_ORIGIN,
    ctx: {
      get: (name) =>
        name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
          : undefined,
    },
  })
  const res = makeRes()
  await handler(makeReq({ method: 'GET', url: ROUTE_PREFIX + '/card/model' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.provider, 'deepseek-official')
  assert.equal(res.json.model, 'deepseek-flash')
  assert.equal(res.json.source, 'session')
})

// ---------------------------------------------------------------- 宿主接口
console.log('宿主接口：review / apply / ask / verify / rollback')
const SELF_ORIGIN = 'http://127.0.0.1:49872'
const calls = []
const fakeLlm = {
  stream(options) {
    calls.push(options)
    return (async function* () {
      yield { type: 'text-delta', text: '{"issues":[],"additions":[{"text":"补充：ET 模式必须非阻塞"}],"suggested":"间隙锁锁住间隙。\\n- 只在 RR 下生效"}' }
    })()
  },
}
const ctx = { get: name => (name === 'llm' ? fakeLlm : undefined) }
const handler = createHandler({ getOrigin: () => SELF_ORIGIN, ctx })

function makeReq({ method = 'GET', url = '/', headers = {}, body }) {
  const init = { method, url, headers: { ...headers } }
  if (body === undefined) return Object.assign(Readable.from([]), init)
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return Object.assign(Readable.from([Buffer.from(payload, 'utf8')]), init)
}
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers || {}
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += chunk
      return res
    },
    get json() {
      return res.body ? JSON.parse(res.body) : null
    },
  }
  return res
}
async function call(options) {
  const res = makeRes()
  await handler(makeReq(options), res)
  return res
}
const jsonHeaders = { 'content-type': 'application/json', origin: SELF_ORIGIN }
const post = (route, body) => call({ method: 'POST', url: ROUTE_PREFIX + route, headers: jsonHeaders, body })
const get = (route) => call({ method: 'GET', url: ROUTE_PREFIX + route, headers: { origin: SELF_ORIGIN } })

console.log('主题管理（2026-11-03 用户要求：面板里要能新建/删主题）')
await check('POST /topic/create 建主题', async () => {
  const res = await post('/topic/create', { name: '面板建的主题' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.topic.name, '面板建的主题')
})

await check('POST /topic/delete 删空主题', async () => {
  const created = await post('/topic/create', { name: '待删的空主题' })
  const slug = created.json.slug
  const res = await post('/topic/delete', { slug })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.cards, 0)
  assert.ok(!res.json.topics.some(item => item.slug === slug), '主题应该没了')
})

await check('POST /topic/delete 删非空主题：先得说清卡片怎么办', async () => {
  const created = await post('/topic/create', { name: '有卡的待删主题' })
  const slug = created.json.slug
  store.planSave({ topic: slug, cards: [{ title: '一张卡', body: 'x' }], dryRun: false })
  const refused = await post('/topic/delete', { slug })
  assert.equal(refused.statusCode, 400)
  assert.match(refused.json.error, /还有 1 张卡/)
  const other = await post('/topic/create', { name: '接住卡片的主题' })
  const moved = await post('/topic/delete', { slug, mode: 'move', moveTo: other.json.slug })
  assert.equal(moved.statusCode, 200)
  assert.equal(moved.json.moved, 1)
  assert.ok(!moved.json.topics.some(item => item.slug === slug), '源主题应该没了')
})

await check('POST /topic/delete 缺主题标识要报错', async () => {
  const res = await post('/topic/delete', {})
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /缺少主题标识/)
})

console.log('列表只发摘要，正文全文另取（审计 P1-8）')
await check('/entries 里长正文只发 160 字摘要，并标出原文长度', async () => {
  const longBody = '首行结论：间隙锁锁住索引记录之间的间隙，阻止其它事务插入新行。\n' + '要点'.repeat(120)
  const plan = store.planSave({
    topic: '摘要测试',
    sessionId: 's-excerpt',
    dryRun: false,
    cards: [{ title: '摘要测试条目', body: longBody }],
  })
  const id = plan.plan[0].id
  const res = await get('/entries?topic=' + encodeURIComponent('摘要测试'))
  assert.equal(res.statusCode, 200)
  const row = res.json.entries.find(item => item.id === id)
  assert.ok(row, '列表里应该有这条')
  assert.equal(row.bodyTruncated, true, '长正文要标为已截断')
  assert.ok(row.body.length <= 161, '摘要最多 160 字（+省略号）：' + row.body.length)
  assert.equal(row.bodyLength, longBody.length, '要报出原文有多长')
})
await check('/entry?id=... 取回正文全文', async () => {
  const longBody = '首行结论：间隙锁锁住索引记录之间的间隙，阻止其它事务插入新行。\n' + '要点'.repeat(120)
  const plan = store.planSave({
    topic: '摘要测试2',
    sessionId: 's-excerpt',
    dryRun: false,
    cards: [{ title: '详情测试条目', body: longBody }],
  })
  const id = plan.plan[0].id
  const res = await get('/entry?id=' + encodeURIComponent(id))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.entry.id, id)
  assert.equal(res.json.entry.body, longBody, '详情要给全文')
  assert.equal(res.json.entry.bodyTruncated, false)
})
await check('/entry 查不到就返回 null，不报错', async () => {
  const res = await get('/entry?id=k_not_exist_at_all')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.entry, null)
})

await check('review 返回问题/补充/建议正文', async () => {
  const res = await post('/card/review', { id: entryId, mode: 'both' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.additions.length, 1)
  assert.match(res.json.suggested, /间隙锁/)
})
await check('review 发给模型的 payload 里没有会话历史、没有 sessionId', async () => {
  const last = calls[calls.length - 1]
  assert.equal(last.sessionId, undefined, '不能带 sessionId')
  assert.equal(last.tools, undefined, '不能带工具')
  const payloadText = JSON.stringify(last.messages) + String(last.system || '')
  assert.doesNotMatch(payloadText, /会话历史|sessionId|systemPrompt/)
  assert.match(payloadText, /间隙锁/)
})
await check('ask 只带这张卡片 + 自己的追问历史', async () => {
  const res = await post('/card/ask', { id: entryId, question: '为什么只在 RR 下生效？', history: [{ q: 'q1', a: 'a1' }] })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  const last = calls[calls.length - 1]
  assert.equal(last.sessionId, undefined)
  assert.match(JSON.stringify(last.messages), /为什么只在 RR 下生效/)
})
await check('ask 缺问题报 400', async () => {
  const res = await post('/card/ask', { id: entryId, question: '  ' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /问题不能为空/)
})
await check('apply 契约不过不写库', async () => {
  const before = store.locateEntry({ id: entryId }).entry.body
  const res = await post('/card/apply', { id: entryId, body: '- 只有要点没有结论' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json.code, 'CONTRACT_VIOLATION')
  assert.equal(store.locateEntry({ id: entryId }).entry.body, before)
})
await check('apply 写回成功并升版本（版本号 = 时间戳）', async () => {
  const before = store.locateEntry({ id: entryId }).entry.version
  const res = await post('/card/apply', { id: entryId, body: '间隙锁锁住间隙。\n- 只在 RR 下生效\n- 走索引才生效' })
  assert.equal(res.statusCode, 200)
  assert.ok(res.json.version >= 1e12, '版本号应该是时间戳：' + res.json.version)
  assert.ok(res.json.version > Number(before), '新版本号要比旧的大')
})
await check('apply 版本冲突返回 409', async () => {
  const res = await post('/card/apply', { id: entryId, body: '间隙锁锁住间隙。\n- 冲突', expectedVersion: 1 })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json.code, 'VERSION_CONFLICT')
})
await check('verify 改核实状态且不升版本', async () => {
  const before = store.locateEntry({ id: entryId }).entry.version
  const res = await post('/card/verify', { id: entryId, state: 'verified', by: 'user', note: '课件 P32' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.verified, true)
  assert.equal(res.json.version, before)
})
await check('rollback 回到原版', async () => {
  const before = store.locateEntry({ id: entryId }).entry.body
  const res = await post('/card/rollback', { id: entryId })
  assert.equal(res.statusCode, 200)
  assert.notEqual(res.json.body, before)
})
await check('找不到条目报 400', async () => {
  const res = await post('/card/review', { id: 'k_not_exist' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /找不到条目/)
})

console.log('批量核实')
await check('批量标为已核实：只动核实状态，不改正文不升版本', async () => {
  const second = store.planSave({
    topic: 'mysql-进阶',
    dryRun: false,
    cards: [{ title: 'ReadView 字段', body: '四个字段。\n- creator_trx_id 等' }],
  })
  const secondId = second.plan[0].id
  const before = { ...store.locateEntry({ id: entryId }).entry }
  const res = await post('/card/verify-batch', { ids: [entryId, secondId], by: 'user' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.count, 2)
  const after = { ...store.locateEntry({ id: entryId }).entry }
  assert.equal(after.verified, true)
  assert.equal(after.version, before.version, '版本不应变化')
  assert.equal(after.body, before.body, '正文不应变化')
  assert.equal(store.locateEntry({ id: secondId }).entry.verified, true)
})
await check('批量核实时空列表报 400', async () => {
  const res = await post('/card/verify-batch', { ids: [] })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /没有要核实的条目/)
})

console.log('模型不可用时的降级')
{
  const brokenCtx = { get: () => undefined }
  const brokenHandler = createHandler({ getOrigin: () => SELF_ORIGIN, ctx: brokenCtx })
  const res = makeRes()
  await brokenHandler(
    makeReq({ method: 'POST', url: ROUTE_PREFIX + '/card/review', headers: jsonHeaders, body: { id: entryId } }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, false)
  assert.match(res.json.reason, /没有可用的模型服务/)
  console.log('  ok  没有模型服务时降级为「校验不可用」而不是报错')
  passed++
}

// 2026-10-22 实测：DeepSeek 回了非 JSON 的解释文字，旧代码把「解析失败」
// 显示成「AI 没发现问题」。校验功能最不能出的就是这种假阳性。
await check('模型不按 JSON 回答时带补救指令重试一次', async () => {
  let count = 0
  const flaky = {
    stream() {
      count++
      const text = count === 1 ? '这张卡片看起来没有问题。' : '{"issues":[{"text":"补一条"}],"additions":[],"suggested":""}'
      return (async function* () {
        yield { type: 'text-delta', text }
      })()
    },
  }
  const retryHandler = createHandler({ getOrigin: () => SELF_ORIGIN, ctx: { get: (n) => (n === 'llm' ? flaky : undefined) } })
  const res = makeRes()
  await retryHandler(
    makeReq({ method: 'POST', url: ROUTE_PREFIX + '/card/review', headers: jsonHeaders, body: { id: entryId, mode: 'both' } }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.attempts, 2, '第一次不是 JSON，应该重试')
  assert.equal(count, 2)
  assert.equal(res.json.parseError, false)
  assert.equal(res.json.issues.length, 1)
})

await check('两次都不是 JSON 时明确报 parseError 并带回原文', async () => {
  const bad = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '还是不对，我觉得这张卡挺好的' }
      })()
    },
  }
  const badHandler = createHandler({ getOrigin: () => SELF_ORIGIN, ctx: { get: (n) => (n === 'llm' ? bad : undefined) } })
  const res = makeRes()
  await badHandler(
    makeReq({ method: 'POST', url: ROUTE_PREFIX + '/card/review', headers: jsonHeaders, body: { id: entryId, mode: 'both' } }),
    res,
  )
  assert.equal(res.json.ok, true)
  assert.equal(res.json.parseError, true, '解析失败必须如实报出来')
  assert.match(res.json.rawPreview, /还是不对/, '要把模型原文带回去')
  assert.equal(res.json.attempts, 2)
})

console.log('插件 AI 模型切换（2026-10-23「模型要能切换」）')
await check('GET /ai-model 默认跟随会话；枚举不到模型时目录为空也不报错', async () => {
  const res = await get('/ai-model')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.aiModel.mode, 'session')
  // 测试用的假 llm 没有 listProviders，枚举能力缺失时退回空目录而不是抛错
  assert.deepEqual(res.json.catalog, [])
})

await check('GET /ai-model 枚举宿主的模型目录（含思考档位与上下文）', async () => {
  const catalogLlm = {
    async listProviders() {
      return [{ id: 'deepseek-official', name: 'DeepSeek 官方' }]
    },
    async listModels(provider) {
      return provider === 'deepseek-official' ? [{ id: 'deepseek-flash', name: 'deepseek-flash' }] : []
    },
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 128000 },
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }
    },
  }
  const handler = createHandler({
    getOrigin: () => SELF_ORIGIN,
    ctx: { get: name => (name === 'llm' ? catalogLlm : undefined) },
  })
  const res = makeRes()
  await handler(makeReq({ method: 'GET', url: ROUTE_PREFIX + '/ai-model', headers: { origin: SELF_ORIGIN } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.catalog.length, 1, '应该枚举出一个模型')
  const entry = res.json.catalog[0]
  assert.equal(entry.provider, 'deepseek-official')
  assert.equal(entry.id, 'deepseek-flash')
  assert.deepEqual(entry.efforts.map(item => item.id), ['low', 'high'], '档位要一并带出来')
  assert.equal(entry.defaultEffort, 'high')
  assert.equal(entry.contextWindow, 128000)
})

await check('POST /ai-model 固定模型 → /card/model 报 plugin 来源；改回 session 恢复', async () => {
  const saved = await post('/ai-model', {
    aiModel: { mode: 'fixed', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json.aiModel.mode, 'fixed')

  const fixedModel = await get('/card/model')
  assert.equal(fixedModel.json.source, 'plugin', '固定后来源要标成 plugin')
  assert.equal(fixedModel.json.provider, 'deepseek-official')
  assert.equal(fixedModel.json.model, 'deepseek-flash')
  assert.equal(fixedModel.json.reasoningEffort, 'low')

  const reset = await post('/ai-model', { aiModel: { mode: 'session' } })
  assert.equal(reset.json.aiModel.mode, 'session')
  const back = await get('/card/model')
  assert.equal(back.json.source, 'default', '改回 session 后不再走插件设置（本测试没有会话模型）')
})

await check('POST /ai-model 给个残缺设置要 400，不能存半截', async () => {
  const res = await post('/ai-model', { aiModel: { mode: 'fixed', provider: 'p' } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /必须同时给出/)
})

// ---------------------------------------------------------------- 改名接口
// 2026-10-26 用户要求「主题和知识卡片的名字，都可以在 ui 随意编辑」。
console.log('改名：主题 / 卡片')
await check('POST /topic/update 改主题名：卡片不丢，旧名进别名', async () => {
  const slug = store.createTopic('改名主题', { description: '改名前的说明' })
  store.planSave({ topic: slug, cards: [{ title: '卡片甲', body: '正文甲' }], dryRun: false })
  const res = await post('/topic/update', {
    slug,
    name: '改名后的主题',
    description: '改名后的说明',
    keywords: ['甲', '乙'],
    domain: '测试域',
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.slug, slug, 'slug 是内部 ID，不该变')
  assert.equal(res.json.name, '改名后的主题')
  assert.equal(res.json.renamed, true)
  assert.deepEqual(res.json.topic.aliases, ['改名主题'])
  assert.equal(res.json.topic.description, '改名后的说明')
  assert.deepEqual(res.json.topic.keywords, ['甲', '乙'])
  assert.equal(res.json.topic.domain, '测试域')
  const entries = store.listEntries({ topic: slug }).entries
  assert.equal(entries.length, 1, '改名不能丢卡片')
  assert.equal(entries[0].title, '卡片甲')
})

await check('GET /overview 要带上领域和旧名字（编辑弹窗要显示）', async () => {
  const slug = store.createTopic('概览主题')
  await post('/topic/update', { slug, name: '概览主题改名', domain: '某领域' })
  const res = await get('/overview')
  const topic = res.json.topics.find(item => item.slug === slug)
  assert.ok(topic, '主题要出现在列表里')
  assert.equal(topic.domain, '某领域')
  assert.ok(Array.isArray(topic.aliases), '旧名字要能给界面显示')
  assert.ok(topic.aliases.includes('概览主题'))
})

await check('GET /overview 要带上主题颜色（面板圆点/卡片色条全靠它）', async () => {
  // 2026-10-30 用户实测「不同主题的颜色不同，怎么颜色撞了」。
  // 这个字段漏过一次：store 里有了，/overview 逐字段拼的时候漏了 →
  // 界面拿不到颜色就退回哈希取模 → 还是撞色。
  const res = await get('/overview')
  assert.ok(res.json.topics.length > 0)
  const colors = res.json.topics.map(item => item.color)
  for (const color of colors) assert.ok(color, '每个主题都要带颜色：' + JSON.stringify(res.json.topics))
  assert.equal(new Set(colors).size, colors.length, '不同主题不能撞色：' + colors.join(' '))
})

await check('POST /topic/update 缺参数要报错', async () => {
  const res = await post('/topic/update', {})
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /缺少主题标识/)
})

await check('POST /topic/update 改不存在的主题要报错', async () => {
  const res = await post('/topic/update', { slug: '压根不存在的主题', name: 'x' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /不存在/)
})

await check('POST /update 改卡片标题：标题变了、正文没动', async () => {
  const slug = store.createTopic('卡片改名主题')
  const saved = store.planSave({
    topic: slug,
    cards: [{ title: '旧标题', body: '正文不动' }],
    dryRun: false,
  })
  const id = saved.plan[0].id
  const res = await post('/update', { id, topic: slug, fields: { title: '新标题' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.title, '新标题')
  const entry = store.locateEntry({ id, topic: slug }).entry
  assert.equal(entry.title, '新标题')
  assert.equal(entry.body, '正文不动', '改名不该动正文')
})

await check('POST /update 标题为空要报错', async () => {
  const slug = store.createTopic('空标题主题')
  const saved = store.planSave({ topic: slug, cards: [{ title: '有标题', body: 'x' }], dryRun: false })
  const res = await post('/update', { id: saved.plan[0].id, topic: slug, fields: { title: '   ' } })
  // 空标题要挡住：卡片没名字在列表里没法看
  assert.ok(res.statusCode >= 400, '空标题应该被拒绝')
})

// ---------------------------------------------------------------- 预览卡片（还没入库）
// 2026-10-26 用户反馈：「新建卡片没有 ai 校验补充和问一下大模型的功能，
// 这里刚要入库不正是需要这些功能的时候吗」。
//
// 评审和追问都是**只读**操作：提示词只用这张卡的标题/正文/标签，
// 库里有没有这条条目无所谓 → 允许把卡片内容直接传进来。
console.log('预览卡片（还没入库）也能校验 / 追问')
// llm.stream 的入参里，正文在 messages[0].content[0].text
const promptOf = (call) => String((call && call.messages && call.messages[0] && call.messages[0].content && call.messages[0].content[0] && call.messages[0].content[0].text) || '')
await check('POST /card/review 传内联卡片（没有 id）→ 能校验', async () => {
  const before = calls.length
  const res = await post('/card/review', {
    card: {
      title: '还没入库的卡',
      body: '首行结论：这是一条还没写进库的知识。\n- 要点一',
      topic: 'mysql-进阶',
      topicName: 'MySQL 进阶',
      tags: ['预览'],
      kind: 'point',
    },
    mode: 'both',
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.ok(calls.length > before, '应该真的调了模型')
  // 提示词里要能看到这张卡的内容
  const prompt = promptOf(calls[calls.length - 1])
  assert.match(prompt, /还没入库的卡/, '提示词里要有卡片标题')
  assert.match(prompt, /这是一条还没写进库的知识/, '提示词里要有卡片正文')
})

await check('POST /card/ask 传内联卡片（没有 id）→ 能追问', async () => {
  const before = calls.length
  const res = await post('/card/ask', {
    card: {
      title: '还没入库的卡',
      body: '首行结论：这是一条还没写进库的知识。\n- 要点一',
      topic: 'mysql-进阶',
      topicName: 'MySQL 进阶',
      tags: ['预览'],
    },
    question: '这条讲的是啥？',
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.ok(calls.length > before, '应该真的调了模型')
  const prompt = promptOf(calls[calls.length - 1])
  assert.match(prompt, /还没入库的卡/)
  assert.match(prompt, /这条讲的是啥/, '问题要进提示词')
})

await check('没有 id 也没有内联卡片 → 报错要说清', async () => {
  const res = await post('/card/review', { mode: 'both' })
  assert.ok(res.statusCode >= 400, '应该报错')
})

await check('有 id 时仍然走库里那条（内联卡片不抢）', async () => {
  const slug = store.createTopic('内联不抢主题')
  const saved = store.planSave({ topic: slug, cards: [{ title: '库里那条', body: '库里的正文' }], dryRun: false })
  const id = saved.plan[0].id
  const res = await post('/card/review', {
    id,
    topic: slug,
    card: { title: '传进来的假卡片', body: '假正文' },
    mode: 'both',
  })
  assert.equal(res.statusCode, 200)
  const prompt = promptOf(calls[calls.length - 1])
  assert.match(prompt, /库里那条/, '有 id 就该用库里那条')
  assert.ok(!prompt.includes('传进来的假卡片'), '有 id 时不能被内联卡片顶掉')
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

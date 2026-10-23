// 学习知识库 Web UI · 宿主接口自测（node test/ui.test.mjs）
//
// 不起 HTTP 服务器：直接拿 createHandler 当函数调，塞假的 req/res。
// 覆盖：总览 → 手动录入 → 列表 → 检索 → 归档 → 恢复 → 改 → 删，
// 以及三道边界：跨站写、非 JSON 写、未知路由。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-ui-'))
process.env.DSH_LEARN_ROOT = root

const { createHandler, ROUTE_PREFIX, name, inject, resolveRoot } = await import('../plugin/index.js')
const { registerSaveBatch, registerProposal, createStore, slugify } = await import('../plugin/store.js')

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

const SELF_ORIGIN = 'http://127.0.0.1:49872'
const handler = createHandler({ getOrigin: () => SELF_ORIGIN })

function makeReq({ method = 'GET', url = '/', headers = {}, body = undefined }) {
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
const get = (route, query = '') => call({ method: 'GET', url: ROUTE_PREFIX + route + query })
const post = (route, body, headers = jsonHeaders) =>
  call({ method: 'POST', url: ROUTE_PREFIX + route, headers, body })

console.log('插件元信息')
await check('导出 name / inject / 工厂', async () => {
  assert.equal(name, 'learning-kb-ui')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(typeof createHandler, 'function')
  assert.equal(ROUTE_PREFIX, '/kb/api')
  assert.equal(resolveRoot(), root)
})

console.log('读接口')
await check('空库总览', async () => {
  const res = await get('/overview')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.json.total, 0)
  assert.deepEqual(res.json.topics, [])
  assert.equal(res.json.root, root)
})

await check('空库检索不报错', async () => {
  const res = await get('/search', '?q=ReadView')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.hits, [])
})

await check('未知读接口 404', async () => {
  const res = await get('/nope')
  assert.equal(res.statusCode, 404)
  assert.match(res.json.error, /未知接口/)
})

console.log('写接口：录入')
let addedId = null
await check('手动录入一条知识', async () => {
  const res = await post('/add', {
    topic: 'mysql-进阶',
    title: 'ReadView 的四个字段',
    body: 'm_ids / min_trx_id / max_trx_id / creator_trx_id。',
    tags: 'MVCC,事务',
    q: 'ReadView 有哪些字段？',
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.topic, 'mysql-进阶')
  assert.equal(res.json.plan[0].action, 'create')
  assert.equal(res.json.plan[0].verified, true)
  assert.equal(res.json.total, 1)
})

await check('录入后总览有计数', async () => {
  const res = await get('/overview')
  assert.equal(res.json.total, 1)
  assert.equal(res.json.activeTotal, 1)
  assert.equal(res.json.topics[0].slug, 'mysql-进阶')
  assert.equal(res.json.topics[0].activeCount, 1)
})

await check('列表能拿到正文与标签', async () => {
  const res = await get('/entries', '?topic=mysql-进阶')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.total, 1)
  const entry = res.json.entries[0]
  addedId = entry.id
  assert.equal(entry.title, 'ReadView 的四个字段')
  assert.match(entry.body, /creator_trx_id/)
  assert.deepEqual(entry.tags, ['MVCC', '事务'])
  assert.equal(entry.kind, 'point')
  assert.equal(entry.status, 'active')
  assert.equal(entry.verified, true)
  assert.equal(entry.topicName, 'mysql-进阶')
})

await check('缺主题的录入被拒', async () => {
  const res = await post('/add', { title: 'x', body: 'y' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /缺少主题/)
})

await check('缺正文的录入被拒', async () => {
  const res = await post('/add', { topic: 'mysql-进阶', title: 'x' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /正文不能为空/)
})

console.log('读接口：检索')
await check('同主题内检索命中', async () => {
  const res = await get('/search', '?q=' + encodeURIComponent('ReadView 字段'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.hits.length, 1)
  assert.equal(res.json.hits[0].title, 'ReadView 的四个字段')
  assert.equal(res.json.hits[0].topicName, 'mysql-进阶')
  assert.equal(res.json.poolSize, 1)
})

await check('检索可按主题限定 scope', async () => {
  const res = await get('/search', '?q=ReadView&topic=不存在的主题')
  assert.equal(res.json.hits.length, 0)
  assert.equal(res.json.scope, '不存在的主题')
})

await check('空查询返回空 hits', async () => {
  const res = await get('/search', '?q=%20')
  assert.deepEqual(res.json.hits, [])
})

console.log('写接口：改 / 归档 / 恢复 / 删')
await check('改标题会升版本号（版本号 = 时间戳）', async () => {
  const before = (await get('/entries', '?topic=mysql-进阶')).json.entries.find((item) => item.id === addedId).version
  const res = await post('/update', {
    topic: 'mysql-进阶',
    id: addedId,
    fields: { title: 'ReadView 的 4 个字段' },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.ok(res.json.version >= 1e12, '版本号应该是时间戳：' + res.json.version)
  assert.ok(res.json.version > Number(before), '新版本号要比旧的大')
  const list = await get('/entries', '?topic=mysql-进阶')
  assert.equal(list.json.entries[0].title, 'ReadView 的 4 个字段')
})

await check('归档后从活跃列表消失', async () => {
  const res = await post('/archive', { topic: 'mysql-进阶', id: addedId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.mode, 'archived')
  const active = await get('/entries', '?topic=mysql-进阶')
  assert.equal(active.json.total, 0)
  const archived = await get('/entries', '?topic=mysql-进阶&status=archived')
  assert.equal(archived.json.total, 1)
  assert.ok(archived.json.entries[0].archivedAt)
  const all = await get('/entries', '?topic=mysql-进阶&status=all')
  assert.equal(all.json.total, 1)
})

await check('归档条目不再进检索池', async () => {
  const res = await get('/search', '?q=ReadView')
  assert.equal(res.json.hits.length, 0)
})

await check('恢复回活跃', async () => {
  const res = await post('/restore', { topic: 'mysql-进阶', id: addedId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.mode, 'restored')
  const active = await get('/entries', '?topic=mysql-进阶')
  assert.equal(active.json.total, 1)
  assert.equal(active.json.entries[0].status, 'active')
  assert.equal(active.json.entries[0].archivedAt, null)
})

await check('重复恢复是幂等的', async () => {
  const res = await post('/restore', { topic: 'mysql-进阶', id: addedId })
  assert.equal(res.json.mode, 'already-active')
})

await check('硬删之后彻底没了', async () => {
  const res = await post('/delete', { topic: 'mysql-进阶', id: addedId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.mode, 'deleted')
  const all = await get('/entries', '?topic=mysql-进阶&status=all')
  assert.equal(all.json.total, 0)
})

await check('不存在的 id 报错可读', async () => {
  const res = await post('/archive', { topic: 'mysql-进阶', id: 'k_不存在' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /找不到条目/)
})

await check('缺 id 直接说缺 id', async () => {
  const res = await post('/archive', { topic: 'mysql-进阶' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /缺少条目 id/)
})

console.log('边界：跨站与协议')
await check('跨站 Origin 被拒', async () => {
  const res = await post(
    '/add',
    { topic: 'x', title: 'a', body: 'b' },
    { 'content-type': 'application/json', origin: 'https://evil.example' },
  )
  assert.equal(res.statusCode, 403)
  assert.match(res.json.error, /跨站/)
  const list = await get('/entries', '?topic=x&status=all')
  assert.equal(list.json.total, 0, '被拒的写入不该落盘')
})

await check('同源 Origin 放行', async () => {
  const res = await post(
    '/add',
    { topic: 'x', title: '同源可写', body: 'ok' },
    { 'content-type': 'application/json', origin: SELF_ORIGIN },
  )
  assert.equal(res.statusCode, 200, res.body)
})

await check('无 Origin 的本机脚本放行', async () => {
  const res = await post('/add', { topic: 'x', title: '无 Origin', body: 'ok' }, { 'content-type': 'application/json' })
  assert.equal(res.statusCode, 200, res.body)
})

await check('非 JSON 写被拒', async () => {
  const res = await post('/add', 'title=a', { 'content-type': 'application/x-www-form-urlencoded' })
  assert.equal(res.statusCode, 403)
  assert.match(res.json.error, /application\/json/)
})

await check('非法 JSON 报 400', async () => {
  const res = await post('/add', '{不是 json', jsonHeaders)
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /合法 JSON/)
})

await check('未知写接口 404', async () => {
  const res = await post('/nope', {}, jsonHeaders)
  assert.equal(res.statusCode, 404)
})

await check('GET 打写接口 404', async () => {
  const res = await get('/add')
  assert.equal(res.statusCode, 404)
})

await check('PUT 报 405', async () => {
  const res = await call({ method: 'PUT', url: ROUTE_PREFIX + '/overview', headers: jsonHeaders })
  assert.equal(res.statusCode, 405)
  assert.match(res.json.error, /不支持的请求方法/)
})

console.log('边界：连续写不丢条目')
await check('连点两次录入两条独立知识', async () => {
  // 界面里点两次「保存」是同源连续请求：读-改-写全程同步，不该相互覆盖
  for (const title of ['连续写入 A', '连续写入 B']) {
    const res = await post('/add', { topic: 'x', title, body: '正文 ' + title })
    assert.equal(res.statusCode, 200, res.body)
  }
  const list = await get('/entries', '?topic=x')
  const titles = list.json.entries.map(entry => entry.title)
  for (const title of ['连续写入 A', '连续写入 B']) assert.ok(titles.includes(title), '缺少 ' + title)
})

await check('同名标题按更新处理而不是重复新建', async () => {
  const res = await post('/add', { topic: 'x', title: '连续写入 A', body: '改过的正文' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.plan[0].action, 'update')
  const list = await get('/entries', '?topic=x&status=all')
  const hits = list.json.entries.filter(entry => entry.title === '连续写入 A')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].body, '改过的正文')
})

console.log('写接口：确认写入（预览先行的落盘）')
// 2026-10-23：learn_save 默认只预览，界面上的「确认写入 N 条」按钮走这个接口落盘。
// 批次本身是进程级内存表，工具半侧登记、UI 半侧按 batchId 取回 —— 这里直接登记再打接口。
await check('待写入批次能按 batchId 落盘', async () => {
  const topicName = '先预览再写'
  const cards = [{ title: '确认写入样例', body: '这一条是通过「先预览再写」流程写进来的。', tags: ['流程'] }]
  const slug = slugify(topicName)
  // 指纹闸门：这批内容必须真的预览过
  createStore(root).markPreviewed(slug, cards)
  const batchId = registerSaveBatch({
    topicArg: topicName,
    slug,
    cards,
    sessionId: null,
    similarCount: 0,
    bypassDuplicate: false,
  })
  const res = await post('/save', { batchId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.status, 'written')
  assert.equal(res.json.total, 1)
  const list = await get('/entries', '?topic=' + topicName)
  assert.equal(list.json.total, 1)
  assert.equal(list.json.entries[0].title, '确认写入样例')
})
await check('同一个 batchId 不能写第二次', async () => {
  const topicName = '先预览再写'
  const cards = [{ title: '只写一次', body: '正文' }]
  const slug = slugify(topicName)
  createStore(root).markPreviewed(slug, cards)
  const batchId = registerSaveBatch({ topicArg: topicName, slug, cards, sessionId: null, similarCount: 0 })
  const first = await post('/save', { batchId })
  assert.equal(first.statusCode, 200, first.body)
  const second = await post('/save', { batchId })
  assert.equal(second.statusCode, 404, '批次是一次性的')
  assert.match(second.json.error, /过期/)
})
await check('没预览过的批次不能写', async () => {
  const topicName = '没预览过的批次'
  const cards = [{ title: '没预览过', body: '正文' }]
  const batchId = registerSaveBatch({
    topicArg: topicName,
    slug: slugify(topicName),
    cards,
    sessionId: null,
    similarCount: 0,
  })
  const res = await post('/save', { batchId })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /还没有预览过/)
})
await check('不存在的 batchId 报 404 并说清怎么办', async () => {
  const res = await post('/save', { batchId: 'b_根本没有这个批次' })
  assert.equal(res.statusCode, 404)
  assert.match(res.json.error, /过期/)
})
await check('缺 batchId 说清缺什么', async () => {
  const res = await post('/save', {})
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /batchId/)
})

console.log('写接口：提议补条目 → 生成预览（2026-10-23 方案 A）')
// 点「同意，出卡片预览」时由宿主调插件模型写正文；这里塞一个假模型。
const fakeLlm = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: 'RAII 把资源生命周期绑到对象上。' + String.fromCharCode(10) + '- 构造获取、析构释放' }
    })()
  },
}
const proposalHandler = createHandler({
  getOrigin: () => SELF_ORIGIN,
  ctx: { get: (name) => (name === 'llm' ? fakeLlm : undefined) },
})
const postTo = async (fn, route, body) => {
  const res = makeRes()
  await fn(makeReq({ method: 'POST', url: ROUTE_PREFIX + route, headers: jsonHeaders, body }), res)
  return res
}

await check('同意提议 → 生成正文并给出待写入批次', async () => {
  const topicName = '提议测试'
  const proposalId = registerProposal({
    topicArg: topicName,
    slug: slugify(topicName),
    topicName,
    items: [{ title: 'RAII 资源管理', why: '库里没有独立条目' }],
    sessionId: null,
  })
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.cards.length, 1)
  assert.match(res.json.cards[0].body, /RAII/, '正文要用模型写出来的那份')
  assert.ok(res.json.batchId, '要给出待写入批次，界面才能渲染「确认写入」')
})

await check('生成的卡片能按批次写进库', async () => {
  const topicName = '提议测试2'
  const proposalId = registerProposal({
    topicArg: topicName,
    slug: slugify(topicName),
    topicName,
    items: [{ title: 'STL 容器与迭代器体系', why: '只散在 vector 几条里' }],
    sessionId: null,
  })
  const made = await postTo(proposalHandler, '/propose/accept', { proposalId })
  const written = await postTo(proposalHandler, '/save', { batchId: made.json.batchId })
  assert.equal(written.statusCode, 200, written.body)
  assert.equal(written.json.status, 'written')
  const list = await get('/entries', '?topic=' + topicName)
  assert.equal(list.json.total, 1)
})

await check('可以只写入其中一张，其余留在批次里（2026-10-24 用户：审批不能只能批量）', async () => {
  const topicName = '单条审批测试'
  const cards = [
    { title: '第一条要写', body: '正文一，内容足够过校验。' + '详细说明'.repeat(5) },
    { title: '第二条先不写', body: '正文二，内容足够过校验。' + '详细说明'.repeat(5) },
  ]
  // 预览指纹闸门：真实流程里 learn_save 预览时就登记了，这里直接建批次得自己登
  createStore(root).markPreviewed(slugify(topicName), cards)
  const batchId = registerSaveBatch({
    topicArg: topicName,
    slug: slugify(topicName),
    cards,
    sessionId: null,
    similarCount: 0,
    bypassDuplicate: true,
  })
  // 先按标题只写第一条
  const first = await postTo(proposalHandler, '/save', { batchId, titles: ['第一条要写'] })
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json.written, 1)
  assert.equal(first.json.remaining, 1, '还剩一条等确认')
  let list = await get('/entries', '?topic=' + topicName)
  assert.equal(list.json.total, 1, '只写进去一条')

  // 批次还在 → 再写剩下那条
  const second = await postTo(proposalHandler, '/save', { batchId, titles: ['第二条先不写'] })
  assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json.remaining, 0, '写完全部就没剩余了')
  list = await get('/entries', '?topic=' + topicName)
  assert.equal(list.json.total, 2, '两条都进去了')
})

await check('单条审批没选中任何一条时报 400', async () => {
  const topicName = '单条审批空选'
  const cards = [{ title: '一条', body: '正文，内容足够过校验。' + '详细说明'.repeat(5) }]
  createStore(root).markPreviewed(slugify(topicName), cards)
  const batchId = registerSaveBatch({
    topicArg: topicName,
    slug: slugify(topicName),
    cards,
    sessionId: null,
    similarCount: 0,
    bypassDuplicate: true,
  })
  const res = await postTo(proposalHandler, '/save', { batchId, titles: ['根本不存在'] })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /至少/)
})

await check('不存在的提议 id 报 404 并说清怎么办', async () => {
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId: 'p_没有这个' })
  assert.equal(res.statusCode, 404)
  assert.match(res.json.error, /过期|重启/)
})

await check('没有模型服务时如实报「没能写出正文」', async () => {
  const proposalId = registerProposal({
    topicArg: '无模型主题',
    slug: slugify('无模型主题'),
    topicName: '无模型主题',
    items: [{ title: 'X', why: 'y' }],
    sessionId: null,
  })
  // 用不带 llm 的 handler
  const noModel = createHandler({ getOrigin: () => SELF_ORIGIN, ctx: { get: () => undefined } })
  const res = await postTo(noModel, '/propose/accept', { proposalId })
  assert.equal(res.statusCode, 502)
  assert.match(res.json.error, /没能写出卡片正文/)
})

await check('模型 429 失败时不作废提议，能直接再点一次（2026-10-23 实测）', async () => {
  const brokenLlm = {
    stream() {
      throw new Error('429 rate_limit_error: 已达到 Token Plan 用量上限')
    },
  }
  const broken = createHandler({ getOrigin: () => SELF_ORIGIN, ctx: { get: (name) => (name === 'llm' ? brokenLlm : undefined) } })
  const proposalId = registerProposal({
    topicArg: '额度测试',
    slug: slugify('额度测试'),
    topicName: '额度测试',
    items: [{ title: 'RAII 的原理与应用', why: '库里没有独立条目' }],
    sessionId: null,
  })
  const first = await postTo(broken, '/propose/accept', { proposalId })
  assert.equal(first.statusCode, 502)
  assert.match(first.json.error, /429|额度/, '要把「额度用完了」说出来，不能只甩 JSON')
  assert.match(first.json.error, /再点一次/, '要告诉用户可以直接重试')
  // 关键：提议没被作废 —— 第二次仍然是 502（模型还是坏的），而不是 404（过期）
  const second = await postTo(broken, '/propose/accept', { proposalId })
  assert.equal(second.statusCode, 502, '第二次不该报已过期（旧代码失败一次就 dropProposal）')
})

await check('模型只返回思考过程、没有正文时，要加预算重试（2026-10-23 实测 4212 字思考）', async () => {
  // 根因：maxTokens=1200 全被思考吃掉 → 正文为空。
  // 修法：预算放大 + 「不要思考」提示 + 第一次没正文就加预算重试。
  let calls = 0
  const budgets = []
  const thinkingOnlyLlm = {
    stream(input) {
      calls++
      budgets.push(input && input.maxTokens)
      return (async function* () {
        if (calls === 1) {
          // 第一次：只有思考过程，没有正文
          yield { type: 'reasoning-delta', text: '想了一堆'.repeat(300) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: 'TIME_WAIT 等 2MSL 是为了保证最后的 ACK 能重传。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const handler = createHandler({
    getOrigin: () => SELF_ORIGIN,
    ctx: {
      get: (name) => {
        if (name === 'llm') return thinkingOnlyLlm
        // 固定模型（source=session → 不再试兜底模型），这样调用次数和预算才是可预期的
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
        }
        return undefined
      },
    },
  })
  const proposalId = registerProposal({
    topicArg: '思考测试',
    slug: slugify('思考测试'),
    topicName: '思考测试',
    items: [{ title: 'TIME_WAIT 为什么等 2MSL', why: '库里没有独立条目' }],
    sessionId: null,
  })
  const res = await postTo(handler, '/propose/accept', { proposalId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(calls, 2, '第一次只有思考 → 应该重试一次')
  assert.ok(budgets[0] >= 3000, '第一次的预算要够思考型模型用，实际 ' + budgets[0])
  assert.ok(budgets[1] > budgets[0], '重试要加预算，实际 ' + budgets.join('/'))
  assert.match(res.json.cards[0].body, /TIME_WAIT/, '重试后要拿到正文')
})

await check('正文在提议时就写好 → 点「同意」不再调模型（2026-10-23 实测：等了几分钟没出来）', async () => {
  let called = 0
  const countingLlm = {
    stream() {
      called++
      return (async function* () {
        yield { type: 'text-delta', text: '模型不该被调用' }
      })()
    },
  }
  const handler = createHandler({
    getOrigin: () => SELF_ORIGIN,
    ctx: { get: (name) => (name === 'llm' ? countingLlm : undefined) },
  })
  const proposalId = registerProposal({
    topicArg: '预写正文测试',
    slug: slugify('预写正文测试'),
    topicName: '预写正文测试',
    items: [
      {
        title: '为什么挥手需要四次',
        why: '库里没有独立条目',
        body:
          '因为被动方收到 FIN 后还要把自己的数据发完。' +
          String.fromCharCode(10) +
          '- 主动方 FIN → 被动方 ACK',
      },
    ],
    sessionId: null,
  })
  const res = await postTo(handler, '/propose/accept', { proposalId })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(called, 0, '提议里已经有正文，不该再调模型')
  assert.match(res.json.cards[0].body, /被动方收到 FIN/, '要用提议时写好的那正文')
})

await check('只补选中的那几条（用户只想补其中几条）', async () => {
  const topicName = '选几条测试'
  const proposalId = registerProposal({
    topicArg: topicName,
    slug: slugify(topicName),
    topicName,
    items: [
      { title: '选中的那条', why: '要补' },
      { title: '没选的那条', why: '不要补' },
      { title: '也没选的那条', why: '不要补' },
    ],
    sessionId: null,
  })
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId, items: [0] })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.cards.length, 1, '只生成选中的那一条')
  assert.equal(res.json.cards[0].title, '选中的那条')
  // 没全选完 → 提议要留着，用户还能改选择再点一次
  const again = await postTo(proposalHandler, '/propose/accept', { proposalId, items: [1] })
  assert.equal(again.statusCode, 200, '提议要还在：' + again.body)
  assert.equal(again.json.cards[0].title, '没选的那条')
})

await check('一条都没选就点同意 → 说清要选至少一条', async () => {
  const topicName = '没选测试'
  const proposalId = registerProposal({
    topicArg: topicName,
    slug: slugify(topicName),
    topicName,
    items: [{ title: '随便一条', why: 'x' }],
    sessionId: null,
  })
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId, items: [] })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /至少/)
})

await check('可以选补到哪个主题（用户要求「加入到哪个主题也要可以选」）', async () => {
  const from = '提议来源主题'
  const to = '提议目标主题'
  createStore(root).createTopic(to)
  const proposalId = registerProposal({
    topicArg: from,
    slug: slugify(from),
    topicName: from,
    items: [{ title: '换个主题补的条目', why: 'y' }],
    sessionId: null,
  })
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId, topic: to })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json.topicName, to, '要按用户选的主题写入')
  const written = await postTo(proposalHandler, '/save', { batchId: res.json.batchId })
  assert.equal(written.statusCode, 200, written.body)
  const list = await get('/entries', '?topic=' + to)
  assert.equal(list.json.total, 1, '条目要落在选中的主题里')
})

await check('选了不存在的主题要说清（400）', async () => {
  const proposalId = registerProposal({
    topicArg: '主题不存在测试',
    slug: slugify('主题不存在测试'),
    topicName: '主题不存在测试',
    items: [{ title: '一条', why: 'z' }],
    sessionId: null,
  })
  const res = await postTo(proposalHandler, '/propose/accept', { proposalId, topic: '根本没有这个主题' })
  assert.equal(res.statusCode, 400)
  assert.match(res.json.error, /不存在/)
})

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')

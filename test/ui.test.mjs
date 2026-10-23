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

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')

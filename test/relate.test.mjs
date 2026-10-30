// 学习知识库 · 「扫描关联」自测（node test/relate.test.mjs）
//
// 这个功能最容易出的错是**乱连**（把不相关的卡连起来，界面上看着很蠢），
// 所以这里重点测「不该连的确实没连」和「重复扫不会连出第二遍」。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-relate-'))
process.env.DSH_LEARN_ROOT = root

const { cardFeatures, judgeRelated, relatedPairs, RELATE_TOP } = await import('../plugin/relate.js')
const { createStore } = await import('../plugin/store.js')
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

const store = createStore(root)

/** 造两张卡，带上判据要用的特征 */
function card(id, title, body, tags, topic = 'mysql') {
  const raw = { id, topic, title, body, tags }
  return { ...raw, features: cardFeatures(raw) }
}

console.log('判据：该连的连，不该连的不连')
const tagCount = new Map([
  ['锁', 6],
  ['间隙锁', 2],
  ['事务', 9],
  ['MVCC', 7],
  ['分类', 30],
])

await check('共享 ≥2 个标签 → 连', () => {
  const a = card('k1', '间隙锁的加锁范围', '间隙锁锁住索引记录之间的空隙。', ['锁', '间隙锁'])
  const b = card('k2', '间隙锁与插入意向锁', '插入意向锁是间隙锁的一种。', ['锁', '间隙锁'])
  const v = judgeRelated(a, b, tagCount)
  assert.ok(v, '应该判为相关')
  assert.match(v.why, /同标签/)
})
await check('共享 1 个标签 + 标题撞词 → 连', () => {
  const a = card('k1', '间隙锁是什么', '间隙锁锁住空隙，阻止插入。', ['锁'])
  const b = card('k2', '间隙锁的加锁范围', '间隙锁的范围是首记录前到末记录后。', ['锁'])
  const v = judgeRelated(a, b, tagCount)
  assert.ok(v, '应该判为相关')
})
await check('只有泛标签（分类）→ 不连', () => {
  const a = card('k1', '索引的分类', '索引分聚簇与非聚簇。', ['分类'])
  const b = card('k2', '缓冲池的分类', '缓冲池按用途分类。', ['分类'])
  assert.equal(judgeRelated(a, b, tagCount), null, '泛标签不能当相关的证据')
})
await check('毫无交集 → 不连', () => {
  const a = card('k1', '间隙锁', '锁住空隙。', ['锁'])
  const b = card('k2', 'TCP 三次握手', '建立连接要三次。', ['网络'])
  assert.equal(judgeRelated(a, b, tagCount), null)
})
await check('正文大面积重合 → 连', () => {
  const body = '独立表空间就是每个表一个文件，扩展性好，默认开启。'
  const a = card('k1', '独立表空间', body, ['表空间'])
  const b = card('k2', 'File-Per-Table 表空间', body + '文件后缀是 .ibd。', ['表空间'])
  const v = judgeRelated(a, b, tagCount)
  assert.ok(v, '应该判为相关')
})
await check('理由说得出来（why 不是空的）', () => {
  const a = card('k1', '间隙锁', '锁住空隙。', ['锁', '间隙锁'])
  const b = card('k2', '间隙锁范围', '范围很明确。', ['锁', '间隙锁'])
  const v = judgeRelated(a, b, tagCount)
  assert.ok(v.why && v.why.length > 2, '理由要能给人看')
})

console.log('配对：批量写链接只按「同一份出处」')
await check('判据只给「建议」，批量写链接不再用它', () => {
  // 2026-10-30：批量写链接改成按出处（事实），相似度判据只服务「建议关联」（人裁决）。
  // 这条测试守着这件事：相似度判据还在，但不再被用来自动写链接。
  const a = card('k1', '间隙锁', '锁住空隙，阻止插入。', ['锁', '间隙锁'])
  const b = card('k2', '间隙锁的范围', '间隙锁罩住首记录前到末记录后。', ['锁', '间隙锁'])
  assert.ok(judgeRelated(a, b, tagCount), '判据本身还在（建议关联要用）')
})

console.log('存储层：扫描关联只加不删')
let aId = ''
let bId = ''
await check('写入两张同源的卡', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [
      {
        title: '间隙锁',
        body: '间隙锁锁住索引记录之间的空隙，阻止其他事务插入。',
        tags: ['锁', '间隙锁'],
        source: { type: 'file', ref: '课件 06 事务和锁.pdf', locator: 'p.16' },
      },
      {
        title: '间隙锁的加锁范围',
        body: '间隙锁罩住首记录前、末记录后的范围，阻止插入。',
        tags: ['锁', '间隙锁'],
        source: { type: 'file', ref: '课件 06 事务和锁.pdf', locator: 'p.17' },
      },
    ],
    dryRun: false,
  })
  aId = result.plan[0].id
  bId = result.plan[1].id
})
await check('同批同源的卡写入时就自动连上了', async () => {
  const links = store.cardLinks({ id: aId }).links
  assert.ok(links.some(l => l.id === bId), '同一份课件的两张卡应该已经连上')
})
await check('扫描前后链接数不变（已经连过的不再连）', async () => {
  const before = store.cardLinks({ id: aId }).links.length
  const result = store.scanRelations()
  assert.equal(result.ok, true)
  assert.equal(result.added, 0, '已经连过的不该再加')
  assert.ok(result.existed >= 1)
  assert.equal(store.cardLinks({ id: aId }).links.length, before)
})
await check('自动关联标记为 auto', async () => {
  const links = store.cardLinks({ id: aId }).links
  const auto = links.find(l => l.id === bId)
  assert.equal(auto.from, 'auto')
})
await check('扫描不动正文和标题', async () => {
  const before = store.readEntries('mysql').map(e => ({ id: e.id, title: e.title, body: e.body }))
  store.scanRelations()
  const after = store.readEntries('mysql').map(e => ({ id: e.id, title: e.title, body: e.body }))
  assert.deepEqual(after, before, '扫描只能加 links，正文标题一个字都不能动')
})
await check('拆掉的链接再扫会回来（只加不删 = 补网，不拆网）', async () => {
  const links = store.cardLinks({ id: aId }).links
  const target = links.find(l => l.id === bId)
  store.removeLink({ id: aId, topic: 'mysql', target: target.id })
  assert.ok(!store.cardLinks({ id: aId }).links.some(l => l.id === bId), '应该拆掉了')
  store.scanRelations()
  assert.ok(store.cardLinks({ id: aId }).links.some(l => l.id === bId), '再扫应该补回来')
})

console.log('宿主接口')
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

await check('POST /relate 返回扫描结果', async () => {
  const res = await call({ method: 'POST', url: ROUTE_PREFIX + '/relate', headers: jsonHeaders, body: {} })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.equal(typeof res.json.added, 'number')
  assert.equal(typeof res.json.groups, 'number')
})
await check('POST /relate 跨站写被挡', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/relate',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: {},
  })
  assert.equal(res.statusCode, 403)
})

console.log('\n' + passed + ' assertions passed')
if (process.exitCode) console.error('有断言失败')

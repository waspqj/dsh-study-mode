// 学习知识库 · 「按出处分组 + 建议关联」自测（node test/groups.test.mjs）
//
// 这一组功能解决的是用户 2026-10-29 提的真实场景：
// 「我刚刚建立一个知识卡片，接着问更深入的问题，
//   生成后面这个问题的卡片预览时，能不能建议它跟上一个建立关联」
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-groups-'))
process.env.DSH_LEARN_ROOT = root

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
const source = (ref, locator) => ({ type: 'file', ref, locator })

console.log('出处分组')
await check('同一份出处的卡归一组', async () => {
  store.planSave({
    topic: 'mysql',
    cards: [
      { title: '什么是事务', body: '一组操作要么全成功要么全失败。', tags: ['事务'], source: source('课件 06.pdf', 'p.10') },
      { title: '事务的 ACID', body: '原子一致性隔离持久。', tags: ['事务'], source: source('课件 06.pdf', 'p.11') },
      { title: '独立表空间', body: '每个表一个文件。', tags: ['表空间'], source: source('课件 05.pdf', 'p.3') },
    ],
    dryRun: false,
  })
  const groups = store.sourceGroups()
  assert.equal(groups.length, 2)
  const big = groups.find(group => group.ref === '课件 06.pdf')
  assert.equal(big.count, 2)
})
await check('组内按页码排序（= 课件的顺序）', async () => {
  const groups = store.sourceGroups()
  const big = groups.find(group => group.ref === '课件 06.pdf')
  assert.equal(big.cards[0].title, '什么是事务')
  assert.equal(big.cards[1].title, '事务的 ACID')
})
await check('某张卡属于哪个组能查到', async () => {
  const entry = store.readEntries('mysql').find(item => item.title === '什么是事务')
  const group = store.sourceGroupOf(entry.id)
  assert.ok(group, '查不到组')
  assert.equal(group.ref, '课件 06.pdf')
})

console.log('连成一组')
await check('组内按页码连成链', async () => {
  // 这两张卡在同一次写入时就自动连上了（同源同批）→ 这里补的是老卡
  const first = store.readEntries('mysql').find(item => item.title === '什么是事务')
  assert.equal(first.links.length, 1)
  assert.equal(first.links[0].title, '事务的 ACID')
  assert.equal(first.links[0].from, 'auto')
  assert.match(first.links[0].why || '', /同一份/)
  const result = store.linkSourceGroups()
  assert.equal(result.ok, true)
  assert.equal(result.linked, 0, '已经连过的不能再连一遍')
})
await check('重复连不会连出第二遍（幂等）', async () => {
  const result = store.linkSourceGroups()
  assert.equal(result.linked, 0)
  const first = store.readEntries('mysql').find(item => item.title === '什么是事务')
  assert.equal(first.links.length, 1)
})
await check('连组不动正文和标题', async () => {
  const before = store.readEntries('mysql').map(e => ({ id: e.id, title: e.title, body: e.body }))
  store.linkSourceGroups()
  const after = store.readEntries('mysql').map(e => ({ id: e.id, title: e.title, body: e.body }))
  assert.deepEqual(after, before)
})

console.log('同一批写入：自动连成链')
await check('同批次同源的卡自动连上，并给出分组摘要', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [
      { title: '缓冲池的作用', body: '缓存磁盘页。', tags: ['缓冲池'], source: source('课件 05.pdf', 'p.20') },
      { title: '缓冲池的三层组织', body: 'LRU、LRU链表、middle区。', tags: ['缓冲池'], source: source('课件 05.pdf', 'p.21') },
    ],
    dryRun: false,
  })
  assert.equal(result.batchSources.length, 1)
  assert.equal(result.batchSources[0].count, 2)
  const first = store.readEntries('mysql').find(item => item.title === '缓冲池的作用')
  assert.equal(first.links.length, 1)
  assert.equal(first.links[0].title, '缓冲池的三层组织')
})

console.log('模型知识的出处（2026-10-30 用户实测：3 张 C# 卡各成一组、连不起来）')
await check('模型来源的卡归到「模型知识」一组（哪怕 ref 各不相同）', async () => {
  // 模型写卡时常常把「为什么值得单独成条」写进 source.ref，
  // 每张卡一句不同的话 → 按 ref 分组就每张自成一组，永远连不起来。
  const model = reason => ({ type: 'model', ref: reason })
  store.planSave({
    topic: 'mysql',
    cards: [
      { title: '模型卡甲', body: '甲。', tags: ['x'], source: model('模型知识展开（库里只有运算符层面的对比，缺少整体差异）') },
      { title: '模型卡乙', body: '乙。', tags: ['x'], source: model('模型知识展开（库里只有整体差异，缺少关键字对照）') },
    ],
    dryRun: false,
  })
  const group = store.sourceGroups().find(item => item.ref === '模型知识')
  assert.ok(group, '没有「模型知识」这一组')
  assert.equal(group.count, 2, '两张模型卡应该在同一组')
})
await check('模型卡同批写入 → 有「自动连成一组」的摘要，也真的连上了', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [
      { title: '模型卡丙', body: '丙。', tags: ['x'], source: { type: 'model', ref: '模型知识展开（丙的理由）' } },
      { title: '模型卡丁', body: '丁。', tags: ['x'], source: { type: 'model', ref: '模型知识展开（丁的理由）' } },
    ],
    dryRun: false,
  })
  assert.equal(result.batchSources.length, 1, '写入条上该出现「这批会自动连成一组」')
  assert.equal(result.batchSources[0].ref, '模型知识')
  assert.equal(result.batchSources[0].count, 2)
  const card = store.readEntries('mysql').find(item => item.title === '模型卡丙')
  assert.equal(card.links.length, 1, '同批的模型卡应该自动连上')
})
await check('链不跨主题（同一组里不同主题的卡不串成一条链）', async () => {
  store.planSave({
    topic: 'mysql',
    cards: [{ title: '模型卡戊', body: '戊。', tags: ['x'], source: { type: 'model', ref: '模型知识展开（戊的理由）' } }],
    dryRun: false,
  })
  store.planSave({
    topic: 'redis',
    cards: [{ title: '模型卡己', body: '己。', tags: ['x'], source: { type: 'model', ref: '模型知识展开（己的理由）' } }],
    dryRun: false,
  })
  store.linkSourceGroups()
  const mysqlCard = store.readEntries('mysql').find(item => item.title === '模型卡戊')
  const redisCard = store.readEntries('redis').find(item => item.title === '模型卡己')
  const mysqlTargets = (mysqlCard.links || []).map(link => link.title)
  const redisTargets = (redisCard.links || []).map(link => link.title)
  assert.ok(!mysqlTargets.includes('模型卡己'), 'mysql 的卡不该连到 redis 的卡')
  assert.ok(!redisTargets.includes('模型卡戊'), 'redis 的卡不该连到 mysql 的卡')
})
await check('没有页码的组按写入顺序排（不按标题排）', async () => {
  const group = store.sourceGroups().find(item => item.ref === '模型知识')
  const titles = group.cards.map(card => card.title)
  const written = ['模型卡甲', '模型卡乙', '模型卡丙', '模型卡丁', '模型卡戊']
  const positions = written.map(title => titles.indexOf(title)).filter(index => index >= 0)
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], '组内顺序跟写入顺序不一致：' + titles.join(' / '))
  }
})

console.log('建议关联（用户提的场景：刚建完卡，接着问更深的问题）')
await check('会话里刚写过的卡会被建议连上', async () => {
  // 先在 session-a 里建一张卡（用户刚建立的知识卡片）
  store.planSave({
    topic: 'mysql',
    cards: [
      { title: '间隙锁(Gap Lock)', body: '间隙锁锁住索引记录之间的空隙，阻止其他事务插入。', tags: ['锁', '间隙锁'] },
    ],
    sessionId: 'session-a',
    dryRun: false,
  })
  // 接着问一个更深的问题 → 新卡的预览应该建议它跟刚建的那张连上
  const result = store.planSave({
    topic: 'mysql',
    cards: [
      { title: '间隙锁与临键锁的区别', body: '间隙锁只锁空隙，临键锁是记录锁加间隙锁。', tags: ['锁'] },
    ],
    sessionId: 'session-a',
    dryRun: true,
  })
  const suggestion = result.suggestions.find(item => item.title === '间隙锁与临键锁的区别')
  assert.ok(suggestion, '没有给出任何建议')
  assert.ok(suggestion.candidates.length >= 1)
  const candidate = suggestion.candidates[0]
  assert.equal(candidate.title, '间隙锁(Gap Lock)')
  assert.match(candidate.why, /跟刚建的那张/, '建议必须说清为什么：' + candidate.why)
  assert.equal(candidate.confidence, 'high', '刚建的那张应该默认勾上')
})
await check('别的会话不该看到这份建议', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [{ title: '完全不相干的一张卡', body: '讲的是完全另一件事。', tags: ['别的'] }],
    sessionId: 'session-b',
    dryRun: true,
  })
  const suggestion = result.suggestions.find(item => item.title === '完全不相干的一张卡')
  assert.ok(!suggestion || !suggestion.candidates.some(c => c.why && c.why.includes('跟刚建的那张')), '不该把别的会话的卡当建议')
})
await check('会话最近卡被记住了', async () => {
  store.planSave({
    topic: 'mysql',
    cards: [{ title: '记住我', body: '这张卡用来验证会话记账。', tags: ['测试'] }],
    sessionId: 'session-c',
    dryRun: false,
  })
  const recent = store.recentCards('session-c')
  assert.equal(recent.length, 1)
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

await check('GET /groups 返回分组和组内卡片', async () => {
  const res = await call({ method: 'GET', url: ROUTE_PREFIX + '/groups?topic=all', headers: jsonHeaders })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.ok(res.json.groups.length >= 2)
  const group = res.json.groups.find(item => item.ref === '课件 06.pdf')
  assert.ok(group, '没找到那个组')
  assert.equal(group.count, 2)
  assert.equal(group.cards.length, 2)
})
await check('POST /relate/group 把指定组连上', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/relate/group',
    headers: jsonHeaders,
    body: { key: 'file|课件 05.pdf' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
})
await check('POST /relate/group 跨站写被挡', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/relate/group',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: {},
  })
  assert.equal(res.statusCode, 403)
})

console.log('\n' + passed + ' assertions passed')
if (process.exitCode) console.error('有断言失败')

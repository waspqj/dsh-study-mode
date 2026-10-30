// 学习知识库 · 卡片互链自测（node test/links.test.mjs）
//
// 互链要成立，靠的是三条不变量：
//   1. 正文里的 [[某某]] 认得出指的是谁 —— 认不出就老实标「没解析」，绝不瞎猜；
//   2. 卡片改名之后链接还指对人（靠 id，不是靠标题）；
//   3. 谁引用了这条，界面能列出来（反向链接）。
//
// 覆盖：解析规则、悬空链接、改名不指错、后建卡片自动接上、
//       手动链接的挂/拆、宿主接口 GET /links 与 POST /link。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-links-'))
process.env.DSH_LEARN_ROOT = root

const { parseLinkRefs, normalizeLinkTitle, buildLinkIndex, resolveRef, resolveEntryLinks, backlinksOf } =
  await import('../plugin/links.js')
const { createStore } = await import('../plugin/store.js')
const { createHandler, ROUTE_PREFIX } = await import('../plugin/index.js')
const { apply: applyTools } = await import('../plugin/tools.js')

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

console.log('引用解析')
await check('抽出正文里的 [[引用]]，保序去重', () => {
  const refs = parseLinkRefs('看 [[索引失效]] 和 [[MVCC]]，[[索引失效]] 再说')
  assert.deepEqual(refs.map(item => item.raw), ['索引失效', 'MVCC'])
})
await check('标题归一化：全角空格、连续空格、大小写', () => {
  assert.equal(normalizeLinkTitle('MySQL  索引'), normalizeLinkTitle('mysql 索引'))
  assert.equal(normalizeLinkTitle('　索引　'), '索引')
})
await check('没有方括号就没有引用', () => {
  assert.deepEqual(parseLinkRefs('普通正文'), [])
  assert.deepEqual(parseLinkRefs(''), [])
})
await check('方括号里还有方括号不当引用', () => {
  assert.deepEqual(parseLinkRefs('[[a[b]]'), [])
})
await check('按 id 优先命中', () => {
  const entry = { id: 'k_1', title: '事务', topic: 'mysql' }
  const index = buildLinkIndex([entry])
  assert.equal(resolveRef('k_1', index), entry)
})
await check('标题精确命中', () => {
  const entry = { id: 'k_2', title: 'MVCC', topic: 'mysql' }
  const index = buildLinkIndex([entry])
  assert.equal(resolveRef('MVCC', index), entry)
})
await check('同名且分不清 → 不猜（返回 null）', () => {
  const a = { id: 'k_3', title: '索引', topic: 't1' }
  const b = { id: 'k_4', title: '索引', topic: 't2' }
  const index = buildLinkIndex([a, b])
  assert.equal(resolveRef('索引', index), null)
  assert.equal(resolveRef('索引', index, { topic: 't1' }), a)
})
await check('找不到就是找不到', () => {
  assert.equal(resolveRef('根本没有这张卡', buildLinkIndex([])), null)
})

console.log('链接的活与死')
await check('正文里的引用是活的：改了正文，链接跟着变', () => {
  const target = { id: 'k_10', title: '旧标题', topic: 'mysql' }
  const index = buildLinkIndex([target])
  const entry = { id: 'k_11', title: '引用方', topic: 'mysql', body: '见 [[旧标题]]' }
  const links = resolveEntryLinks(entry, index)
  assert.equal(links.length, 1)
  assert.equal(links[0].id, 'k_10')
  assert.equal(links[0].from, 'body')
  assert.equal(links[0].resolved, true)
})
await check('悬空引用：那张卡还不存在 → resolved=false，但看得见', () => {
  const index = buildLinkIndex([])
  const links = resolveEntryLinks({ id: 'k_12', title: 'x', topic: 'mysql', body: '见 [[还没建的卡]]' }, index)
  assert.equal(links.length, 1)
  assert.equal(links[0].resolved, false)
  assert.equal(links[0].title, '还没建的卡')
})
await check('反向链接：谁引用了我', () => {
  const target = { id: 'k_20', title: '目标', topic: 'mysql' }
  const source = { id: 'k_21', title: '来源', topic: 'mysql', body: '见 [[目标]]' }
  const index = buildLinkIndex([target, source])
  const back = backlinksOf('k_20', [target, source], index)
  assert.equal(back.length, 1)
  assert.equal(back[0].id, 'k_21')
})
await check('自己不引用自己（反向链接里不含自己）', () => {
  const entry = { id: 'k_30', title: '自指', topic: 'mysql', body: '见 [[自指]]' }
  const index = buildLinkIndex([entry])
  assert.deepEqual(backlinksOf('k_30', [entry], index), [])
})

console.log('落库：正文引用与手动链接')
let indexId = ''
let mvccId = ''
await check('写入带 [[引用]] 的卡片', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [
      { title: '索引失效', body: '索引建好了也可能用不上。' },
      { title: 'MVCC', body: '多版本并发控制，见 [[索引失效]]。' },
    ],
    dryRun: false,
  })
  assert.equal(result.plan.length, 2)
  indexId = result.plan[0].id
  mvccId = result.plan[1].id
  assert.ok(indexId && mvccId)
})
await check('正文引用落库时记下目标 id（改名也不会指错人）', async () => {
  const entry = store.readEntries('mysql').find(item => item.id === mvccId)
  assert.ok(Array.isArray(entry.links))
  assert.equal(entry.links.length, 1)
  assert.equal(entry.links[0].id, indexId)
  assert.equal(entry.links[0].from, 'body')
  assert.equal(entry.links[0].raw, '索引失效')
})
await check('cardLinks 给出正向链接', async () => {
  const result = store.cardLinks({ id: mvccId })
  assert.equal(result.links.length, 1)
  assert.equal(result.links[0].id, indexId)
  assert.equal(result.links[0].title, '索引失效')
  assert.equal(result.links[0].from, 'body')
})
await check('反向链接：索引失效那张卡被 MVCC 引用', async () => {
  const result = store.cardLinks({ id: indexId })
  assert.equal(result.backlinks.length, 1)
  assert.equal(result.backlinks[0].id, mvccId)
})
await check('改名之后链接还指对人（标题变、id 不变）', async () => {
  store.updateEntry({ id: indexId, topic: 'mysql', fields: { title: '索引失效（改名后）' } })
  const result = store.cardLinks({ id: mvccId })
  assert.equal(result.links.length, 1, '不该因为改名多出一条重复链接')
  assert.equal(result.links[0].id, indexId)
  assert.equal(result.links[0].title, '索引失效（改名后）')
  assert.equal(result.links[0].resolved, true)
})
await check('后建的同名卡片能把悬空链接接上', async () => {
  const result = store.planSave({
    topic: 'mysql',
    cards: [{ title: '等待被引用', body: '见 [[后来才建的卡]]。' }],
    dryRun: false,
  })
  const waitingId = result.plan[0].id
  let links = store.cardLinks({ id: waitingId }).links
  assert.equal(links[0].resolved, false, '那张卡还不该解析得出来')
  const created = store.planSave({
    topic: 'mysql',
    cards: [{ title: '后来才建的卡', body: '我来了。' }],
    dryRun: false,
  })
  links = store.cardLinks({ id: waitingId }).links
  assert.equal(links.length, 1)
  assert.equal(links[0].resolved, true)
  assert.equal(links[0].id, created.plan[0].id)
})
await check('手动链接：挂上后能拆掉', async () => {
  const added = store.addLink({ id: mvccId, topic: 'mysql', target: '等待被引用' })
  assert.ok(added.ok)
  const links = store.cardLinks({ id: mvccId }).links
  assert.ok(links.some(item => item.from === 'manual'))
  store.removeLink({ id: mvccId, topic: 'mysql', target: added.target.id })
  const after = store.cardLinks({ id: mvccId }).links
  assert.ok(!after.some(item => item.from === 'manual'))
})
await check('不能链接到自己', async () => {
  assert.throws(() => store.addLink({ id: mvccId, topic: 'mysql', target: 'MVCC' }), /不能链接到卡片自己/)
})
await check('链接到不存在的卡片要报错', async () => {
  assert.throws(() => store.addLink({ id: mvccId, topic: 'mysql', target: '压根没有这张卡' }), /找不到要链接的卡片/)
})
await check('模型重写卡片时，没给 links 就沿用原来的手动链接', async () => {
  store.addLink({ id: mvccId, topic: 'mysql', target: '等待被引用' })
  const before = store.cardLinks({ id: mvccId }).links.filter(item => item.from === 'manual')
  assert.equal(before.length, 1)
  store.planSave({
    topic: 'mysql',
    cards: [{ title: 'MVCC', body: '重写后的正文。' }],
    dryRun: false,
  })
  const after = store.cardLinks({ id: mvccId }).links.filter(item => item.from === 'manual')
  assert.equal(after.length, 1, '手动链接不该被模型顺手抹掉')
})
await check('正文里的引用没了，链接也跟着没（正文才是活的）', async () => {
  const made = store.planSave({
    topic: 'mysql',
    cards: [{ title: '正文活链接', body: '见 [[索引失效（改名后）]]。' }],
    dryRun: false,
  })
  const liveId = made.plan[0].id
  assert.equal(store.cardLinks({ id: liveId }).links.filter(item => item.from === 'body').length, 1)
  store.planSave({
    topic: 'mysql',
    cards: [{ title: '正文活链接', body: '正文里不再提索引失效了。' }],
    dryRun: false,
  })
  assert.equal(store.cardLinks({ id: liveId }).links.filter(item => item.from === 'body').length, 0)
})
await check('已经连上的卡不重复加一行（回报 already）', async () => {
  const again = store.addLink({ id: mvccId, topic: 'mysql', target: '等待被引用' })
  assert.equal(again.already, true)
  const manual = store.cardLinks({ id: mvccId }).links.filter(item => item.from === 'manual')
  assert.equal(manual.length, 1)
})
await check('模型显式给 links 时按给的来', async () => {
  store.planSave({
    topic: 'mysql',
    cards: [{ title: 'MVCC', body: '重写后的正文。', links: ['索引失效（改名后）'] }],
    dryRun: false,
  })
  const manual = store.cardLinks({ id: mvccId }).links.filter(item => item.from === 'manual')
  assert.equal(manual.length, 1)
  assert.equal(manual[0].title, '索引失效（改名后）')
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

await check('GET /links 返回正向与反向链接', async () => {
  const res = await call({ method: 'GET', url: ROUTE_PREFIX + '/links?id=' + mvccId + '&topic=mysql' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  assert.ok(Array.isArray(res.json.links))
  assert.ok(Array.isArray(res.json.backlinks))
})
await check('GET /links 缺 id 要报错', async () => {
  const res = await call({ method: 'GET', url: ROUTE_PREFIX + '/links' })
  assert.equal(res.json.ok, false)
})
await check('POST /link 挂上一条链接', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/link',
    headers: jsonHeaders,
    body: { id: mvccId, topic: 'mysql', target: '等待被引用' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.ok, true)
  const links = store.cardLinks({ id: mvccId }).links
  assert.ok(links.some(item => item.from === 'manual'))
})
await check('POST /link remove 拆掉这条链接', async () => {
  const before = store.cardLinks({ id: mvccId }).links
  const target = before.find(item => item.from === 'manual')
  assert.ok(target, '前置条件：先有一条手动链接')
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/link',
    headers: jsonHeaders,
    body: { id: mvccId, topic: 'mysql', target: target.id || target.title, remove: true },
  })
  assert.equal(res.json.ok, true)
  const after = store.cardLinks({ id: mvccId }).links
  assert.ok(!after.some(item => item.id === target.id), '这条手动链接应该被拆掉了')
})
await check('POST /link 缺 target 要报错', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/link',
    headers: jsonHeaders,
    body: { id: mvccId, topic: 'mysql' },
  })
  assert.equal(res.json.ok, false)
})
await check('POST /link 跨站写被挡', async () => {
  const res = await call({
    method: 'POST',
    url: ROUTE_PREFIX + '/link',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: { id: mvccId, topic: 'mysql', target: '索引失效' },
  })
  assert.equal(res.statusCode, 403)
})

console.log('关联喂给模型（抄 dsh-eli-mode 的 kb_read：返回里带「关联 / 反向关联」）')
await check('learn_search 的返回里有「关联」和「被引用」', async () => {
  const registered = new Map()
  applyTools(
    {
      tools: {
        register(def) {
          registered.set(def.name, def)
          return () => registered.delete(def.name)
        },
      },
      on() {},
      get() {
        return undefined
      },
    },
    {},
  )
  const search = registered.get('learn_search')
  assert.ok(search, '没有注册 learn_search')
  const render = async query => {
    const value = await search.execute({ query, scope: 'all' }, { sessionId: 'demo' })
    const rendered = search.output.render({ query }, value)
    return Array.isArray(rendered) ? rendered.map(part => part.text || '').join('\n') : String(rendered)
  }
  // MVCC 连着谁，就该在返回里看到谁（对着库里的实际链接断言，不写死标题）
  const linked = store.cardLinks({ id: mvccId }).links.filter(link => link.resolved).map(link => link.title)
  assert.ok(linked.length > 0, 'MVCC 应该至少有一条关联')
  const mvccText = await render('MVCC')
  assert.match(mvccText, /关联：/, '工具返回里没有「关联」')
  assert.ok(mvccText.includes('关联：' + linked[0]), '关联行里没有真正连着的那张卡')
  // 那张卡反过来应该看到「被引用：MVCC」
  const targetText = await render(linked[0])
  assert.match(targetText, /被引用：/, '工具返回里没有「被引用」')
})
await check('没有关联的卡片不占地方（不出现空的「关联：」）', async () => {
  const registered = new Map()
  applyTools(
    {
      tools: {
        register(def) {
          registered.set(def.name, def)
          return () => registered.delete(def.name)
        },
      },
      on() {},
      get() {
        return undefined
      },
    },
    {},
  )
  const search = registered.get('learn_search')
  const value = await search.execute({ query: '完全不存在的词xyz', scope: 'all' }, { sessionId: 'demo' })
  const rendered = search.output.render({ query: 'x' }, value)
  const text = Array.isArray(rendered) ? rendered.map(part => part.text || '').join('\n') : String(rendered)
  assert.ok(!/关联：\s*$/.test(text), '不该出现空的关联行')
})

console.log('\n' + passed + ' assertions passed')
if (process.exitCode) console.error('有断言失败')

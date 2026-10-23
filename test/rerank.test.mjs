// 学习知识库 · 大模型重排自测（node test/rerank.test.mjs）
//
// 这一层最容易出的问题不是"算错"，而是"模型抽风时把卡片搞没了"。
// 所以重点覆盖降级路径：返回不是 JSON、返回空、返回全 drop、调用抛错、
// 模型不可用 —— 每一种都必须退回本地排序，卡片照常出。

import assert from 'node:assert/strict'

import {
  MAX_RELATED,
  RERANK_CANDIDATES,
  RERANK_MAX_TOKENS,
  RERANK_RETRY_MAX_TOKENS,
  applyRerankText,
  buildRerankPrompt,
  fallbackSplit,
  normalizeVerdict,
  parseRerankJson,
  rerankHits,
  splitByVerdict,
} from '../plugin/rerank.js'

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

const hit = (id, title, body = '正文') => ({
  id,
  title,
  body,
  tags: ['tag'],
  topic: 'mysql-进阶',
  score: 10,
})

const HITS = [
  hit('a', '什么是LRU cache', 'LRU 用哈希表加双向链表。'),
  hit('b', '什么是protobuf', 'protobuf 是二进制序列化格式。'),
  hit('c', '缓冲池的 LRU 变体算法', 'midpoint insertion 与 LRU 链表。'),
  hit('d', '什么是事务', '事务有 ACID。'),
]

console.log('提示词')
await check('带上问题、每条 id 与标题、正文摘要', () => {
  const prompt = buildRerankPrompt('LRU 是怎么实现的', HITS)
  assert.match(prompt, /LRU 是怎么实现的/)
  assert.match(prompt, /id=a/)
  assert.match(prompt, /什么是LRU cache/)
  assert.match(prompt, /摘要：/)
  assert.match(prompt, /"match"/)
  assert.match(prompt, /"related"/)
  assert.match(prompt, /"drop"/)
})

await check('正文摘要会截断，不把整篇塞进提示词', () => {
  const long = [hit('x', '长正文', 'x'.repeat(5000))]
  const prompt = buildRerankPrompt('q', long)
  assert.ok(prompt.length < 1200, '提示词被长正文撑爆了：' + prompt.length)
})

await check('候选上限常量合理（不然每次检索都烧一大段上下文）', () => {
  assert.ok(RERANK_CANDIDATES >= 3 && RERANK_CANDIDATES <= 20)
  assert.ok(MAX_RELATED >= 1 && MAX_RELATED <= 5)
})

console.log('解析')
await check('纯 JSON', () => {
  const parsed = parseRerankJson('{"match":["a"],"related":[],"drop":[]}')
  assert.deepEqual(parsed.match, ['a'])
})

await check('```json 围栏', () => {
  const parsed = parseRerankJson('好的，结果如下：\n```json\n{"match":["b"]}\n```\n以上。')
  assert.deepEqual(parsed.match, ['b'])
})

await check('前后带解释文字也能抠出来', () => {
  const parsed = parseRerankJson('我认为：{"match":["a"],"related":["c"]} 就这样。')
  assert.deepEqual(parsed.related, ['c'])
})

await check('不是 JSON 就返回 null，不抛错', () => {
  assert.equal(parseRerankJson('我觉得 a 挺相关的'), null)
  assert.equal(parseRerankJson(''), null)
  assert.equal(parseRerankJson(null), null)
  assert.equal(parseRerankJson('{坏掉的'), null)
})

console.log('归类整理')
await check('丢掉模型编出来的 id', () => {
  const verdict = normalizeVerdict(
    { match: ['a', '幽灵'], related: ['c'], drop: ['b'] },
    new Set(['a', 'b', 'c', 'd']),
  )
  assert.deepEqual([...verdict.match], ['a'])
  assert.ok(!verdict.match.has('幽灵'))
})

await check('同一个 id 出现在两类里，以先出现的为准', () => {
  const verdict = normalizeVerdict({ match: ['a'], related: ['a'] }, new Set(['a']))
  assert.deepEqual([...verdict.match], ['a'])
  assert.equal(verdict.related.size, 0)
})

await check('允许值是单个字符串或对象数组', () => {
  const one = normalizeVerdict({ match: 'a' }, new Set(['a']))
  assert.deepEqual([...one.match], ['a'])
  const objects = normalizeVerdict({ match: [{ id: 'b' }] }, new Set(['a', 'b']))
  assert.deepEqual([...objects.match], ['b'])
})

await check('三类都空 → null（没有信息量，别覆盖本地排序）', () => {
  assert.equal(normalizeVerdict({}, new Set(['a'])), null)
  assert.equal(normalizeVerdict({ match: ['幽灵'] }, new Set(['a'])), null)
  assert.equal(normalizeVerdict(null, new Set(['a'])), null)
})

console.log('切分')
await check('两组都保持本地分数顺序，不重排', () => {
  const verdict = normalizeVerdict(
    { match: ['c', 'a'], related: ['d'] },
    new Set(['a', 'b', 'c', 'd']),
  )
  const split = splitByVerdict(HITS, verdict, { limit: 3 })
  assert.deepEqual(split.matched.map(item => item.id), ['a', 'c'])
  assert.deepEqual(split.related.map(item => item.id), ['d'])
})

await check('命中条数受 limit 限制，相关补充受 MAX_RELATED 限制', () => {
  const verdict = normalizeVerdict({ match: ['a', 'b', 'c'], related: ['d'] }, new Set(['a', 'b', 'c', 'd']))
  const split = splitByVerdict(HITS, verdict, { limit: 2, maxRelated: 0 })
  assert.deepEqual(split.matched.map(item => item.id), ['a', 'b'])
  assert.equal(split.related.length, 0)
})

await check('模型没提到的条目一律不进任何一组（精度优先）', () => {
  const verdict = normalizeVerdict({ match: ['a'] }, new Set(['a', 'b', 'c', 'd']))
  const split = splitByVerdict(HITS, verdict, { limit: 3 })
  assert.deepEqual(split.matched.map(item => item.id), ['a'])
  assert.equal(split.related.length, 0)
})

console.log('降级（最关键的部分）')
await check('返回垃圾文本 → 退回本地排序，卡片照常出', () => {
  const split = applyRerankText('模型今天不想输出 JSON', HITS, { limit: 2 })
  assert.equal(split.used, false)
  assert.deepEqual(split.matched.map(item => item.id), ['a', 'b'])
  assert.equal(split.related.length, 0)
  assert.ok(split.reason.length > 0, '降级要留下原因')
})

await check('返回全 drop → 退回本地排序，不能一张卡片都没有', () => {
  const split = applyRerankText('{"match":[],"related":[],"drop":["a","b","c","d"]}', HITS, { limit: 3 })
  assert.equal(split.used, false)
  assert.equal(split.matched.length, 3)
})

await check('全判成 related → 把最有希望的那条提到命中', () => {
  const split = applyRerankText('{"match":[],"related":["c","d"],"drop":[]}', HITS, { limit: 3 })
  assert.equal(split.used, true)
  assert.deepEqual(split.matched.map(item => item.id), ['c'])
  assert.deepEqual(split.related.map(item => item.id), ['d'])
})

await check('正常结果：命中与相关分开，无关丢掉', () => {
  const split = applyRerankText(
    '{"match":["a"],"related":["c"],"drop":["b","d"]}',
    HITS,
    { limit: 3 },
  )
  assert.equal(split.used, true)
  assert.deepEqual(split.matched.map(item => item.id), ['a'])
  assert.deepEqual(split.related.map(item => item.id), ['c'])
})

await check('fallbackSplit 的条数受 limit 约束', () => {
  const split = fallbackSplit(HITS, 1, '测试')
  assert.equal(split.matched.length, 1)
  assert.equal(split.used, false)
})

console.log('调用编排')
const ctxNoLlm = { get: () => undefined }

await check('候选为空时一次模型都不调', async () => {
  let called = 0
  const out = await rerankHits({ ctx: {}, query: 'q', hits: [], call: () => { called++; return { ok: true, text: '{}' } } })
  assert.equal(called, 0)
  assert.equal(out.matched.length, 0)
})

await check('模型返回分类 → 用模型的分类', async () => {
  const out = await rerankHits({
    ctx: {},
    query: 'LRU 怎么实现',
    hits: HITS,
    limits: { limit: 3 },
    call: async () => ({ ok: true, text: '{"match":["a"],"related":["c"],"drop":[]}', model: 'fake' }),
  })
  assert.equal(out.used, true)
  assert.deepEqual(out.matched.map(item => item.id), ['a'])
  assert.deepEqual(out.related.map(item => item.id), ['c'])
  assert.equal(out.model, 'fake')
})

await check('模型不可用（没配 llm）→ 退回本地排序', async () => {
  const out = await rerankHits({ ctx: ctxNoLlm, query: 'LRU', hits: HITS, limits: { limit: 2 } })
  assert.equal(out.used, false)
  assert.equal(out.matched.length, 2)
  assert.match(out.reason, /模型|不可用|本机/)
})

await check('调用抛错 → 退回本地排序，不往上抛', async () => {
  const out = await rerankHits({
    ctx: {},
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
    call: async () => { throw new Error('网络断了') },
  })
  assert.equal(out.used, false)
  assert.equal(out.matched.length, 2)
  assert.match(out.reason, /网络断了/)
})

await check('DSH_KB_RERANK=0 时直接本地排序，一次模型都不调', async () => {
  const previous = process.env.DSH_KB_RERANK
  process.env.DSH_KB_RERANK = '0'
  let called = 0
  try {
    const out = await rerankHits({
      ctx: {},
      query: 'q',
      hits: HITS,
      limits: { limit: 2 },
      call: () => { called++; return { ok: true, text: '{}' } },
    })
    assert.equal(called, 0)
    assert.equal(out.used, false)
    assert.equal(out.matched.length, 2)
  } finally {
    if (previous === undefined) delete process.env.DSH_KB_RERANK
    else process.env.DSH_KB_RERANK = previous
  }
})

await check('正文为空（只有思考）→ 加倍预算重试一次，用重试的结果', async () => {
  const budgets = []
  const out = await rerankHits({
    ctx: {},
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
    call: async (ctx, input) => {
      budgets.push(input.maxTokens)
      if (budgets.length === 1) return { ok: false, text: '', noText: true, reason: '只有思考没有正文' }
      return { ok: true, text: '{"match":["a"],"related":["c"],"drop":[]}', model: 'fake' }
    },
  })
  assert.deepEqual(budgets, [RERANK_MAX_TOKENS, RERANK_RETRY_MAX_TOKENS], '重试应该加倍预算')
  assert.equal(out.used, true, '重试成功后要用模型结果，不能退回本地排序')
  assert.deepEqual(out.matched.map(item => item.id), ['a'])
})

await check('重试也失败 → 退回本地排序，不抛错', async () => {
  let calls = 0
  const out = await rerankHits({
    ctx: {},
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
    call: async () => {
      calls++
      return { ok: false, text: '', noText: true, reason: '还是没有正文' }
    },
  })
  assert.equal(calls, 2, '最多重试一次')
  assert.equal(out.used, false)
  assert.equal(out.matched.length, 2, '卡片照常出')
})

await check('正常返回时不会多调一次模型', async () => {
  let calls = 0
  await rerankHits({
    ctx: {},
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
    call: async () => {
      calls++
      return { ok: true, text: '{"match":["a"]}', model: 'fake' }
    },
  })
  assert.equal(calls, 1)
})

await check('重试那次的用量也记进总账（两次调用都花了钱）', async () => {
  const out = await rerankHits({
    ctx: {},
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
    call: async (ctx, input) => {
      if (input.maxTokens === RERANK_MAX_TOKENS) {
        return { ok: false, text: '', noText: true, reason: '空', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      }
      return { ok: true, text: '{"match":["a"]}', model: 'fake', usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } }
    },
  })
  assert.equal(out.usage.inputTokens, 20, '两次调用的输入 token 要加起来')
  assert.equal(out.usage.outputTokens, 12, '两次调用的输出 token 要加起来')
})

await check('输出预算别再是 2000：思考型模型需要更多空间', () => {
  assert.ok(RERANK_MAX_TOKENS >= 3000, '首次预算至少 3000')
  assert.ok(RERANK_RETRY_MAX_TOKENS > RERANK_MAX_TOKENS, '重试预算要比首次大')
})

// 这两条走真实的 callModel（不注入 call），验证 rerank.js 与 llm.js 之间的接缝：
// 宿主 llm.stream 返回的是 AsyncIterable<StreamChunk>，分片是 text-delta。
const llmStreaming = (chunks) => ({
  stream() {
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  },
})

await check('真实 callModel + 分片流：text-delta 能拼成分类结果', async () => {
  const llm = llmStreaming([
    { type: 'text-delta', text: '{"match":["a"],' },
    { type: 'text-delta', text: '"related":["c"],"drop":["b"]}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const out = await rerankHits({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    query: 'LRU 怎么实现',
    hits: HITS,
    limits: { limit: 3 },
  })
  assert.equal(out.used, true)
  assert.deepEqual(out.matched.map(item => item.id), ['a'])
  assert.deepEqual(out.related.map(item => item.id), ['c'])
})

await check('真实 callModel + 流里报错：退回本地排序，不抛错', async () => {
  const llm = llmStreaming([
    { type: 'text-delta', text: '{"match":["a"]' },
    { type: 'finish', reason: { kind: 'error', failure: { message: '上游 500', code: 'upstream' } } },
  ])
  const out = await rerankHits({
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    query: 'q',
    hits: HITS,
    limits: { limit: 2 },
  })
  assert.equal(out.used, false)
  assert.equal(out.matched.length, 2, '模型报错时卡片照常出')
})

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')

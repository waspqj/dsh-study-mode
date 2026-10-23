// 学习知识库 · 隔离模型调用自测（node test/llm.test.mjs）
//
// 这里钉住两件事：
//   1. 上下文隔离：调用里**没有 sessionId**，模型看不到会话历史；
//   2. 模型选择跟当前会话实时对齐 —— 读宿主 agentDefaultModel，而不是写死一个模型名。
//      用户切到 DeepSeek，校验就得用 DeepSeek；那个模型挂了就如实报错，不能偷偷换。

import assert from 'node:assert/strict'

import { callModel, resolveLlm, resolveSelection, normalizeUsage, mergeUsage } from '../plugin/llm.js'

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

/** 假 llm：记录每次调用的入参，按脚本返回成功或抛错。 */
function makeLlm(script = []) {
  const seen = []
  return {
    seen,
    stream(input) {
      seen.push(input)
      const step = script[seen.length - 1] || { text: '好' }
      return (async function* () {
        if (step.throw) throw new Error(step.throw)
        if (step.text !== undefined) yield { type: 'text-delta', text: step.text }
        if (step.usage !== undefined) yield { type: 'usage', usage: step.usage }
        yield { type: 'finish', reason: { kind: step.error ? 'error' : 'stop', ...(step.error ? { failure: { message: step.error, code: 'x' } } : {}) } }
      })()
    },
  }
}

/** 假 ctx：按名字给服务。 */
function makeCtx(services) {
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
  }
}

const selectionOf = (selection) => ({
  agentDefaultModel: { currentSelection: () => selection },
})

console.log('模型选择')
await check('读宿主的 agentDefaultModel，不用写死的模型名', () => {
  const ctx = makeCtx(selectionOf({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  const selection = resolveSelection(ctx)
  assert.equal(selection.provider, 'deepseek-official')
  assert.equal(selection.model, 'deepseek-flash')
  assert.equal(selection.source, 'session')
})

await check('reasoningEffort 一起带过来', () => {
  const ctx = makeCtx(selectionOf({ provider: 'p', model: 'm', reasoningEffort: 'high' }))
  assert.equal(resolveSelection(ctx).reasoningEffort, 'high')
})

await check('宿主没这个服务 → 回落兜底线', () => {
  const selection = resolveSelection(makeCtx({}))
  assert.equal(selection.source, 'default')
  assert.ok(selection.provider)
  assert.ok(selection.model)
})

await check('服务抛错也不炸，回落兜底', () => {
  const ctx = makeCtx({ agentDefaultModel: { currentSelection: () => { throw new Error('boom') } } })
  const selection = resolveSelection(ctx)
  assert.equal(selection.source, 'default')
})

await check('选择不完整（缺 model）→ 回落兜底', () => {
  assert.equal(resolveSelection(makeCtx(selectionOf({ provider: 'p' }))).source, 'default')
  assert.equal(resolveSelection(makeCtx({ agentDefaultModel: {} })).source, 'default')
})

console.log('调用')
await check('用当前会话选的 provider + model 发请求', async () => {
  const llm = makeLlm()
  const ctx = makeCtx({ ...selectionOf({ provider: 'deepseek-official', model: 'deepseek-flash' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, true)
  assert.equal(llm.seen.length, 1)
  assert.equal(llm.seen[0].provider, 'deepseek-official')
  assert.equal(llm.seen[0].model, 'deepseek-flash')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.source, 'session')
})

await check('选择里的 reasoningEffort 会透传给 llm.stream', async () => {
  const llm = makeLlm()
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm', reasoningEffort: 'high' }), llm })
  await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(llm.seen[0].reasoningEffort, 'high')
})

await check('会话选的模型失败时不偷偷换模型，如实报错', async () => {
  const llm = makeLlm([{ throw: '上游 500' }])
  const ctx = makeCtx({ ...selectionOf({ provider: 'deepseek-official', model: 'deepseek-flash' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, false)
  assert.equal(llm.seen.length, 1, '只该试一次：换模型等于背着用户换 AI')
  assert.match(result.reason, /上游 500/)
  assert.equal(result.model, 'deepseek-flash', '失败也要报出用的是哪个模型')
})

await check('走兜底线路时才尝试备选模型', async () => {
  const llm = makeLlm([{ throw: '不可用' }, { text: '备选成功' }])
  const ctx = makeCtx({ llm }) // 没有 agentDefaultModel
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, true)
  assert.equal(llm.seen.length, 2, '兜底线路允许换备选模型')
  assert.equal(result.source, 'default')
})

await check('显式传 model 时只用这个模型', async () => {
  const llm = makeLlm()
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  await callModel(ctx, { system: 's', prompt: 'p', model: '指定模型' })
  assert.equal(llm.seen.length, 1)
  assert.equal(llm.seen[0].model, '指定模型')
})

console.log('上下文隔离')
await check('调用里没有 sessionId —— 模型看不到会话历史', async () => {
  const llm = makeLlm()
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  await callModel(ctx, { system: 's', prompt: '只有卡片正文' })
  const input = llm.seen[0]
  assert.equal(input.sessionId, undefined, '带上 sessionId 就等于把整段会话喂给了模型')
  assert.equal(input.messages.length, 1)
  assert.equal(input.messages[0].content[0].text, '只有卡片正文')
  assert.equal(input.system, 's')
})

await check('没有 llm 服务时是「不可用」不是抛错', async () => {
  assert.equal(resolveLlm(makeCtx({})), null)
  const result = await callModel(makeCtx({}), { system: 's', prompt: 'p' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有可用的模型服务/)
})

await check('模型返回空内容时算失败，不是静默成功', async () => {
  const llm = makeLlm([{ text: '' }, { text: '' }])
  const ctx = makeCtx({ llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /没有返回内容/)
})

console.log('token 用量')
await check('流里的 usage chunk 被收集成 input / output / total', async () => {
  const llm = makeLlm([{ text: '好', usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } }])
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, true)
  assert.equal(result.usage.inputTokens, 1200)
  assert.equal(result.usage.outputTokens, 340)
  assert.equal(result.usage.totalTokens, 1540)
})

await check('没有 usage chunk 时不编数字（usage 为 null）', async () => {
  const llm = makeLlm([{ text: '好' }])
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.usage, null)
})

await check('整块交付的正文也认（block-end，没有 text-delta）', async () => {
  // 2026-10-23 实测：pi-ai 适配器（MiniMax 走的这条）有时只给整块正文。
  // 只认 text-delta 的话，换模型后就是「模型没有返回内容」。
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"issues":[]}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '{"issues":[]}')
})

await check('分片和整块同时到达时，正文不重复一遍', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'abc' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'abc' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.text, 'abc')
})

await check('只有思考、没有正文 → 说清是「思考吃光了输出预算」', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'reasoning-delta', index: 0, text: '让我想想…' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, false)
  assert.equal(result.noText, true)
  assert.match(result.reason, /思考/)
  assert.match(result.reason, /maxTokens/)
})

await check('连分片都没有 → 报错里带上收到的分片类型（便于排查协议差异）', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = makeCtx({ ...selectionOf({ provider: 'p', model: 'm' }), llm })
  const result = await callModel(ctx, { system: 's', prompt: 'p' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /block-start/)
})

await check('字段名不统一也能认（input/output、prompt/completion tokens）', () => {
  assert.equal(normalizeUsage({ input: 10, output: 5 }).totalTokens, 15)
  assert.equal(normalizeUsage({ promptTokens: 20, completionTokens: 7 }).totalTokens, 27)
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({ totalTokens: 0 }), null)
})

await check('两次调用的用量能相加（校验重试那一次也算钱）', () => {
  const merged = mergeUsage({ totalTokens: 100, inputTokens: 80, outputTokens: 20 }, { totalTokens: 50, inputTokens: 40, outputTokens: 10 })
  assert.equal(merged.totalTokens, 150)
  assert.equal(merged.inputTokens, 120)
  assert.equal(merged.outputTokens, 30)
  assert.equal(mergeUsage(null, { totalTokens: 7 }).totalTokens, 7)
  assert.equal(mergeUsage({ totalTokens: 7 }, null).totalTokens, 7)
})

console.log('')
console.log(passed + ' assertions passed')
if (process.exitCode) console.error('有失败用例')

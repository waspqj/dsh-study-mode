// 学习知识库 · 隔离的模型调用
//
// 这个文件是「AI 校验补充 / 问一下 / 检索重排」能成立的唯一前提：它调模型时
// **不带 sessionId**，所以模型看不到当前会话的任何历史，只有我们显式拼进去的
// 那一张卡片正文（或那一批检索候选）。
//
// 为什么不用 ctx.get('llm') 之外的写法：
//   llm 服务是根作用域的，但万一哪天没挂上，我们希望的是「校验不可用」这种
//   温和降级，而不是整块插件起不来。所以这里用 ctx.get('llm') 软探测，
//   不把它写进 inject 的硬依赖。
//
// 用哪个模型（2026-10-22 用户要求「和当前会话实时对齐」）：
//   不是写死一个模型名，而是每次调用时去问宿主的 `agentDefaultModel` 服务。
//   界面切模型走 session-controller 的 model-select，它同时调
//   `agents.selectForNextRequest()` 和 `agentDefaultModel.saveSelection()`，
//   所以这里读到的就是用户刚选的那个 —— 切完立刻生效，不用重启。

/** 兜底线路：取不到宿主选择时用。 */
const DEFAULT_PROVIDER = process.env.DSH_KB_LLM_PROVIDER || 'minimax'
const DEFAULT_MODEL = process.env.DSH_KB_LLM_PROVIDER_MODEL || process.env.DSH_KB_LLM_MODEL || 'MiniMax-M3.1-Flash'

/** 同一线路的备选模型：**只在兜底线路上**依次尝试；用户选定的模型不偷偷换。 */
const FALLBACK_MODELS = ['MiniMax-M3']

/** 单次调用的超时（毫秒）。校验不该让界面一直转圈。 */
const DEFAULT_TIMEOUT_MS = 90_000

/** 模型不可用这类可预期的错误：调用方要能区分它和"程序出错"。 */
export class CardLlmError extends Error {
  constructor(message, reason) {
    super(message)
    this.name = 'CardLlmError'
    this.reason = reason || 'unavailable'
  }
}

/**
 * 取宿主上的 llm 服务。
 * @param {object} ctx 插件上下文
 * @returns {object|null} llm 服务，取不到就返回 null
 */
export function resolveLlm(ctx) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get('llm') || null : null
  } catch {
    return null
  }
}

/**
 * 插件自己的模型偏好：校验 / 追问 / 检索重排用哪个模型。
 *
 * 由 plugin/index.js 在装配时注入一个读取函数（读 store 里的 aiModel 设置）。
 * 返回 `{mode:'session'}` 或 null = 跟随当前会话（2026-10-22 用户定的规则）；
 * 返回 `{mode:'fixed', provider, model, reasoningEffort}` = 固定用这个。
 *
 * 为什么需要：为了绕开「某个模型一次校验要 100 秒」而切会话模型时，
 * 会把主对话的模型一起换掉 —— 有了这个设置就能只换插件这几条一次性调用。
 */
let modelPreference = () => null

/**
 * 注入模型偏好读取函数（插件装配时调一次）。
 * @param {() => (object|null)} read 每次调用都重新读，改了设置立刻生效
 */
export function setModelPreference(read) {
  modelPreference = typeof read === 'function' ? read : () => null
}

/**
 * 解析这次调用该用哪个模型。
 *
 * 优先顺序：
 *   1. 插件自己固定的模型（`source: 'plugin'`）—— 用户明确指定了就用它，绝不偷偷换；
 *   2. 宿主 `agentDefaultModel.currentSelection()` —— 用户在界面上选的那个（`source: 'session'`）；
 *   3. 环境变量 / 内置兜底（`source: 'default'`）。
 *
 * @param {object} ctx 插件上下文
 * @returns {{provider: string, model: string, reasoningEffort: (string|null), source: ('plugin'|'session'|'default')}}
 */
export function resolveSelection(ctx) {
  // ① 插件固定了模型
  try {
    const pref = modelPreference()
    if (pref && pref.mode === 'fixed' && pref.provider && pref.model) {
      return {
        provider: String(pref.provider),
        model: String(pref.model),
        reasoningEffort: pref.reasoningEffort ? String(pref.reasoningEffort) : null,
        source: 'plugin',
      }
    }
  } catch {
    // 设置读不出来就当没设，继续走会话
  }
  // ② 跟会话走
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    const current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    if (current && current.provider && current.model) {
      return {
        provider: String(current.provider),
        model: String(current.model),
        reasoningEffort: current.reasoningEffort ? String(current.reasoningEffort) : null,
        source: 'session',
      }
    }
  } catch {
    // 服务没挂 / 接口变了：安静回落，不能让校验整块挂掉
  }
  return {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    reasoningEffort: null,
    source: 'default',
  }
}

/**
 * 把 usage chunk 归一成固定形状。
 *
 * 宿主的 usage chunk 是 `{ type: 'usage', usage }`，字段按 pi-ai 的映射：
 * inputTokens / outputTokens / totalTokens（可能带 cacheRead/cacheWrite）。
 * 各家网关字段名不完全统一，这里几种写法都认。
 *
 * @param {any} raw
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number, reasoningTokens: number}|null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const input = Number(raw.inputTokens ?? raw.input ?? raw.promptTokens ?? 0)
  const output = Number(raw.outputTokens ?? raw.output ?? raw.completionTokens ?? 0)
  const given = Number(raw.totalTokens ?? raw.total ?? NaN)
  // 思考 token：宿主的 TokenUsage 本来就带 reasoningTokens，以前被丢了 ——
  // 而它正是「一次校验为什么记了 4862 个输出、正文却只有 600」的答案。
  const reasoning = Number(raw.reasoningTokens ?? raw.reasoning ?? 0)
  const sum = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
  const total = Number.isFinite(given) && given > 0 ? given : sum
  if (!Number.isFinite(total) || total <= 0) return null
  return {
    inputTokens: Number.isFinite(input) ? Math.max(0, Math.round(input)) : 0,
    outputTokens: Number.isFinite(output) ? Math.max(0, Math.round(output)) : 0,
    totalTokens: Math.max(1, Math.round(total)),
    reasoningTokens: Number.isFinite(reasoning) ? Math.max(0, Math.round(reasoning)) : 0,
  }
}

/** 两次调用的用量相加：校验首次解析失败会重试一次，两次都花了钱。 */
export function mergeUsage(a, b) {
  const left = normalizeUsage(a)
  const right = normalizeUsage(b)
  if (!left) return right
  if (!right) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0),
  }
}

/**
 * 把流里的 chunk 拼成纯文本 + 用量；失败时抛 CardLlmError。
 *
 * 两种文本交付方式都要认（2026-10-23 实测踩坑）：
 *   · 增量：`text-delta`（DeepSeek 官方适配器走这条）
 *   · 整块：`block-end` 里带 `block: {type:'text', text}`（pi-ai 适配器在
 *     某些模型上只给整块，不给分片）—— 只认 text-delta 的话，
 *     换模型后就会一直「模型没有返回内容」。
 * 同一个 block 两种都来时以分片为准，避免正文重复一遍。
 */
async function collectStream(stream) {
  const blocks = new Map()
  let usage = null
  let reasoningChars = 0
  const chunkTypes = []
  const slot = (index) => {
    const key = index === undefined || index === null ? 0 : index
    let record = blocks.get(key)
    if (!record) {
      record = { delta: '', block: '' }
      blocks.set(key, record)
    }
    return record
  }
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunkTypes.length < 24) chunkTypes.push(String(chunk.type || '?'))
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      slot(chunk.index).delta += chunk.text
      continue
    }
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
      slot(chunk.index).block = chunk.block.text
      continue
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoningChars += chunk.text.length
      continue
    }
    // usage 可能出现在流末尾，也可能分片到达：累加起来
    if (chunk.type === 'usage') {
      usage = mergeUsage(usage, chunk.usage)
      continue
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason && reason.kind === 'error') {
        const failure = reason.failure || {}
        throw new CardLlmError(failure.message || '模型调用失败', failure.code || 'error')
      }
      if (reason && reason.kind === 'aborted') {
        throw new CardLlmError('模型调用被中止', 'aborted')
      }
    }
  }
  const parts = []
  for (const record of blocks.values()) parts.push(record.delta || record.block)
  return { text: parts.join(''), usage, reasoningChars, chunkTypes }
}

/**
 * 发起一次隔离的模型调用。
 *
 * @param {object} ctx 插件上下文
 * @param {object} input
 * @param {string} input.system 系统提示词
 * @param {string} input.prompt 用户提示词（只有这里的内容会进模型）
 * @param {number} [input.maxTokens] 输出上限
 * @param {number} [input.timeoutMs] 超时
 * @returns {Promise<{ok: boolean, text: string, model: string, provider: string, reason?: string}>}
 */
export async function callModel(ctx, input) {
  const llm = resolveLlm(ctx)
  if (!llm) {
    return { ok: false, text: '', provider: '', model: '', reason: '本机没有可用的模型服务' }
  }

  // 每次调用都重新读一次选择：用户在界面上切了模型，下一次校验就该用新的。
  const selection = resolveSelection(ctx)
  const provider = String(input.provider || selection.provider)
  // 用户选定的模型**不偷偷换**：它失败就如实报错，让用户自己决定要不要换。
  // 只有走兜底线路时才尝试备选模型（那条线路本来就是我们自己猜的）。
  // 用户明确指定过的模型（会话选的 / 插件固定的）**绝不偷偷换**：
  // 它失败就如实报错，让用户自己决定要不要换。只有走兜底线路时才试备选
  // （那条线路本来就是我们自己猜的）。
  // 'plugin' 是插件自己固定模型的情况，同样只认这一个 —— 否则用户特意为了
  // 「让校验快一点」选定的模型会被悄悄换成别的，那就白设了。
  const primary = String(input.model || selection.model)
  const pinned = Boolean(input.model) || selection.source === 'session' || selection.source === 'plugin'
  const models = pinned ? [primary] : [primary, ...FALLBACK_MODELS.filter(model => model !== primary)]
  const reasoningEffort = input.reasoningEffort || selection.reasoningEffort
  let lastReason = ''
  let lastNoText = false

  for (const model of models) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs || DEFAULT_TIMEOUT_MS)
    try {
      const stream = llm.stream({
        provider,
        model,
        system: input.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(input.prompt || '') }] }],
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
        signal: controller.signal,
      })
      const collected = await collectStream(stream)
      const text = collected.text
      if (!text.trim()) {
        // 空正文要说清楚是哪一种空：只有思考过程（多半是 maxTokens 被思考吃掉了），
        // 还是压根没分片（换了个模型 / 适配器，协议不一样）。不能只说「没有返回内容」。
        lastReason = collected.reasoningChars > 0
          ? `模型只返回了思考过程（${collected.reasoningChars} 字），没有正文——多半是 maxTokens 被思考吃掉了`
          : `模型没有返回内容（收到的分片类型：${collected.chunkTypes.join(',') || '无'}）`
        lastNoText = true
        continue
      }
      return {
        ok: true,
        text,
        provider,
        model,
        source: selection.source,
        usage: collected.usage,
        reasoningChars: collected.reasoningChars,
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
      // 兜底线路上换模型再试一次；用户选定的模型只试一次，失败就走降级
    } finally {
      clearTimeout(timeout)
    }
  }

  return { ok: false, text: '', provider, model: primary, reason: lastReason || '模型调用失败', noText: lastNoText }
}


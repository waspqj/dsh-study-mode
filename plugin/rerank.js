// 学习模式知识库 · 大模型重排
//
// 为什么需要这一层：
//   rank.js 是**纯文字匹配**（BM25 + 中文 bigram）。它能保证「字面上像」的排在
//   前面，但不懂语义 —— 问「缓存淘汰算法」命中不了标题是「LRU cache」的条目，
//   反过来一个通用词又能带进一堆不相关的条目。加门槛只能压噪声，解决不了同义词。
//   所以这里让模型看一遍候选，做两件事：
//     1. 判断每条和问题的关系（直接命中 / 相关补充 / 无关）；
//     2. 把"相关但那不是答案"的单独标出来，交给界面折叠显示。
//
// 纪律：
//   - 模型只做**分类**，不生成新内容。卡片正文永远来自知识库，不会因为重排被改写。
//   - 任何失败（没配模型 / 超时 / 返回不是合法 JSON / id 对不上）都**退回本地排序**，
//     把候选当成全部命中。宁可卡片多几张，也不能因为重排挂了就没有卡片。

import { callModel, mergeUsage } from './llm.js'

/** 送进模型的候选上限：再多就不划算了，本地排名已经够靠前。 */
export const RERANK_CANDIDATES = 8

/** 每条候选在提示词里的正文摘要长度。太长会把提示词撑爆，也不利于模型抓重点。 */
const EXCERPT = 160

/** 相关补充最多保留几条（卡片区默认折叠，但也不能无限长）。 */
export const MAX_RELATED = 3

/**
 * 单次重排的超时：卡在这一步会拖慢整个回答，所以给得比校验短。
 * 2026-10-23：思考型模型要先把预算花在思考上，20 秒经常不够 —— 放宽到 35 秒，
 * 超时仍然退回本地排序（宁可慢一点，也别让搜索质量因为思考而掉档）。
 */
export const RERANK_TIMEOUT_MS = 35_000

/** 提示词里的输出格式约定，解析和提示词共用一份，避免两边写漂。 */
export const RERANK_KEYS = ['match', 'related', 'drop']

/**
 * 重排的输出预算。
 *
 * 2026-10-23 审计 P1-4：原来只给 2000。思考型模型（MiniMax-M3 这类）会把
 * 输出预算先花在思考上，2000 经常不够写正文 —— 表现是「模型没有返回内容」，
 * 于是重排整个失效、悄悄退回本地排序，用户只感觉到"搜得不准"。
 * 现在首次给 3000；万一还是空（见下面的重试），加到 6000 再试一次。
 */
export const RERANK_MAX_TOKENS = 3000
export const RERANK_RETRY_MAX_TOKENS = 6000

/**
 * 思考型模型把预算吃光时的补救指令（和主校验那条一个思路）：
 * 明确要求别输出思考过程，只给最终结果。
 */
const NO_THINK_RULE = [
  '',
  '重要：不要输出思考过程，不要解释，直接给最终结果。',
  '先在内部想清楚，然后只输出最终答案本身。',
].join('\n')

const SYSTEM_PROMPT = [
  '你是知识库检索的相关性判定器。',
  '用户会给你一个问题，和若干条候选知识点。',
  '你的任务只有一个：判断每条候选与问题的关系，然后输出 JSON。',
  '不要解释，不要补充知识点内容，不要输出 JSON 以外的任何文字。',
  '不要输出思考过程：先想清楚，然后只输出 JSON。',
].join('\n')

/**
 * 把一条命中压成提示词里的一行摘要。
 * @param {object} hit 命中条目
 * @returns {string} 摘要文本
 */
function excerpt(hit) {
  const raw = String(hit.body || hit.q || '')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.length > EXCERPT ? raw.slice(0, EXCERPT) + '…' : raw
}

/**
 * 构造重排提示词。
 * @param {string} query 用户问题
 * @param {object[]} hits 候选命中（已按本地分排序）
 * @returns {string} 提示词
 */
export function buildRerankPrompt(query, hits) {
  const lines = []
  lines.push('用户问题：' + String(query || '').trim())
  lines.push('')
  lines.push('候选知识点（共 ' + hits.length + ' 条，按本地文字匹配分数从高到低）：')
  hits.forEach((hit, index) => {
    const tags = Array.isArray(hit.tags) && hit.tags.length ? ' 标签 ' + hit.tags.join('/') : ''
    const topic = hit.topic ? ' 主题 ' + hit.topic : ''
    lines.push(
      index + 1 + '. id=' + String(hit.id) + ' 《' + String(hit.title || '') + '》' + topic + tags,
    )
    const body = excerpt(hit)
    if (body) lines.push('   摘要：' + body)
  })
  lines.push('')
  lines.push('请把每个 id 归入且只归入一类，输出：')
  lines.push(
    '{"match":["id",...],"related":["id",...],"drop":["id",...]}',
  )
  lines.push('- match：直接回答了用户的问题，是答案本身；')
  lines.push('- related：不是答案，但属于同一知识领域，能作为背景补充；')
  lines.push('- drop：和问题无关，或者只有字面巧合。')
  lines.push('match 最多 ' + Math.min(hits.length, 5) + ' 条，related 最多 ' + MAX_RELATED + ' 条。')
  lines.push('宁可 drop，也不要把只是字面沾边的条目放进 match。')
  return lines.join('\n')
}

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 模型经常带 ```json 围栏、前置说明或尾随解释，所以不用 JSON.parse 直接硬解：
 * 先剥围栏，再找第一个 { 到最后一个 } 之间那段。
 * @param {string} text 模型输出
 * @returns {object|null} 解析出的对象，失败返回 null
 */
export function parseRerankJson(text) {
  if (typeof text !== 'string') return null
  let body = text.trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = body.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把模型给的分类结果整理成 id 集合。
 *
 * 容错：值可能是数组、单个字符串、或者带 id 字段的对象；重复出现的 id 以前一次为准；
 * 不在候选里的 id 一律丢掉（模型偶尔会编 id）。
 * @param {object|null} verdict 解析后的 JSON
 * @param {Set<string>} known 候选 id 集合
 * @returns {{match: Set<string>, related: Set<string>, drop: Set<string>}|null}
 *   三类都为空时返回 null（说明这份结果没有任何信息量）
 */
export function normalizeVerdict(verdict, known) {
  if (!verdict || typeof verdict !== 'object') return null
  const out = { match: new Set(), related: new Set(), drop: new Set() }
  const seen = new Set()

  const take = (raw, bucket) => {
    const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
    for (const item of list) {
      const id = String(
        item && typeof item === 'object' ? (item.id ?? item.title ?? '') : item ?? '',
      ).trim()
      if (!id || !known.has(id) || seen.has(id)) continue
      seen.add(id)
      out[bucket].add(id)
    }
  }

  take(verdict.match, 'match')
  take(verdict.related, 'related')
  take(verdict.drop, 'drop')

  if (!out.match.size && !out.related.size && !out.drop.size) return null
  return out
}

/**
 * 按分类结果把候选切成「命中 / 相关补充」两组。
 *
 * 保序：两组内部都保持本地分数顺序，不重排 —— 本地分仍然是有用的一阶信号。
 * 没被模型提到的候选按「无关」处理（不塞进任何一组），这是精度优先的选择。
 * @param {object[]} hits 候选
 * @param {{match: Set<string>, related: Set<string>}} verdict 分类结果
 * @param {{limit?: number, maxRelated?: number}} [limits] 上限
 * @returns {{matched: object[], related: object[]}}
 */
export function splitByVerdict(hits, verdict, limits = {}) {
  const limit = Math.max(1, Number(limits.limit) || 3)
  const maxRelated = Math.max(0, Number(limits.maxRelated ?? MAX_RELATED) || 0)
  const matched = []
  const related = []
  for (const hit of hits) {
    const id = String(hit.id ?? '')
    if (verdict.match.has(id)) {
      if (matched.length < limit) matched.push(hit)
    } else if (verdict.related.has(id)) {
      if (related.length < maxRelated) related.push(hit)
    }
  }
  return { matched, related }
}

/**
 * 本地排序的降级结果：全部候选按分数取前 limit 条当命中，没有相关补充。
 *
 * 这就是「重排没生效」时的行为，和加这一层之前完全一致 —— 用户不会因为模型挂了
 * 就看不到卡片。
 * @param {object[]} hits 候选
 * @param {number} limit 命中条数上限
 * @returns {{matched: object[], related: object[], used: boolean, reason: string}}
 */
export function fallbackSplit(hits, limit, reason) {
  return {
    matched: hits.slice(0, Math.max(1, Number(limit) || 3)),
    related: [],
    used: false,
    reason: String(reason || ''),
  }
}

/**
 * 判定模型输出是否可用，可用就切分。
 * @param {string} text 模型输出
 * @param {object[]} hits 候选
 * @param {{limit?: number, maxRelated?: number}} limits 上限
 * @returns {{matched: object[], related: object[], used: boolean, reason: string}}
 */
export function applyRerankText(text, hits, limits = {}) {
  const known = new Set(hits.map(hit => String(hit.id ?? '')))
  const verdict = normalizeVerdict(parseRerankJson(text), known)
  if (!verdict) return fallbackSplit(hits, limits.limit, '模型返回的不是可用的分类结果')
  const split = splitByVerdict(hits, verdict, limits)
  if (!split.matched.length && !split.related.length) {
    return fallbackSplit(hits, limits.limit, '模型把所有候选都判为无关')
  }
  // 模型把答案都判成 related、match 一条没留：把分数最高的那条提到命中，
  // 否则界面上一张"命中"卡片都没有，用户会以为库里没这东西。
  if (!split.matched.length) {
    return { matched: split.related.slice(0, 1), related: split.related.slice(1), used: true, reason: '' }
  }
  return { matched: split.matched, related: split.related, used: true, reason: '' }
}

/**
 * 走一次模型，把候选分成「命中 / 相关补充」。
 *
 * 这是唯一会真的发请求的入口，其余都是纯函数，方便单测。
 * @param {object} input
 * @param {object} input.ctx 插件上下文（取 llm 服务用）
 * @param {string} input.query 用户问题
 * @param {object[]} input.hits 本地排序后的候选
 * @param {{limit?: number, maxRelated?: number}} [input.limits] 上限
 * @param {Function} [input.call] 模型调用函数（测试注入用）
 * @returns {Promise<{matched: object[], related: object[], used: boolean, reason: string}>}
 */
export async function rerankHits(input) {
  const { ctx, query, hits, limits = {}, call = callModel } = input || {}
  const list = Array.isArray(hits) ? hits : []
  if (!list.length) return { matched: [], related: [], used: false, reason: '' }

  // 关掉重排的开关：调试、离线、或者用户嫌慢时用
  if (process.env.DSH_KB_RERANK === '0') {
    return fallbackSplit(list, limits.limit, 'DSH_KB_RERANK=0')
  }

  const candidates = list.slice(0, RERANK_CANDIDATES)
  const prompt = buildRerankPrompt(query, candidates)
  let result
  try {
    result = await call(ctx, {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: RERANK_MAX_TOKENS,
      timeoutMs: RERANK_TIMEOUT_MS,
    })
  } catch (error) {
    return fallbackSplit(candidates, limits.limit, '重排调用异常：' + (error && error.message ? error.message : String(error)))
  }

  // 正文为空（多半是思考把输出预算吃光了）→ 加倍预算、明确别思考，再试一次。
  // 和「AI 校验补充」用的是同一套补救（审计 P1-4）：宁可多花一次调用，
  // 也不要因为思考型模型预算不够就悄悄退回到本地排序。
  let usage = result && result.usage ? result.usage : null
  if (result && !result.ok && result.noText) {
    try {
      const retry = await call(ctx, {
        system: SYSTEM_PROMPT + NO_THINK_RULE,
        prompt,
        maxTokens: RERANK_RETRY_MAX_TOKENS,
        timeoutMs: RERANK_TIMEOUT_MS,
      })
      // 两次调用都花了钱，用量要合并
      usage = mergeUsage(usage, retry ? retry.usage : null)
      if (retry && retry.ok) result = retry
    } catch {
      // 重试也炸了：保留第一次的失败原因，照样退回本地排序
    }
  }

  if (!result || !result.ok) {
    return fallbackSplit(candidates, limits.limit, (result && result.reason) || '模型不可用')
  }
  const split = applyRerankText(result.text, candidates, limits)
  // 用量一起带出去：检索重排也是一次真实的模型调用，得让用户看得见花了多少
  return { ...split, model: result.model || '', usage }
}

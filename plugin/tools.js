// 学习模式 · 知识库插件（v2）· 工具半侧（挂在 './tools' 子路径上）
//
// 注意：包的裸名 '.' 入口让给了 UI/路由半侧（plugin/index.js），因为宿主扫描
// 浏览器半侧只认裸包名；这一半只被预设里的工具行引用，不需要浏览器半侧。
//
// 工具：
//   learn_topics   列出/新建/切换/查找主题
//   learn_search   检索主题库或全部主题库
//   learn_save     写入知识卡片（默认只预览 dryRun，确认后才落盘）
//   learn_update   修改既有条目
//   learn_delete   归档/删除条目
//   learn_entries  列出条目（可按状态/类型/标签过滤）
//
// 存储位置：~/.dsh/learn（可用环境变量 DSH_LEARN_ROOT 覆盖）
//
// 本插件不依赖任何外部包：宿主对插件包做依赖解析，从工作区 link 进来的插件
// 拿不到 DSH 自带包的依赖树，所以这里只用 Node 内置模块 + 纯函数。

import os from 'node:os'
import path from 'node:path'

import { createStore, slugify, normalizeTitle, registerSaveBatch, registerProposal } from './store.js'
import { rankDocs, splitQuerySegments, tokenize, CANDIDATE_RELATIVE, MIN_RELATIVE } from './rank.js'
import { rerankHits, MATCH_MODE } from './rerank.js'
import { resolveSelection, setModelPreference, mergeUsage } from './llm.js'

export const name = 'learning-kb'

export const inject = ['tools']

function resolveRoot() {
  const override = process.env.DSH_LEARN_ROOT
  if (override && override.trim()) return path.resolve(override.trim())
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'learn')
}

function sessionIdOf(exec) {
  const id = exec?.agent?.id
  return id ? String(id) : null
}

/**
 * 重排结果缓存。
 *
 * 2026-10-23 审计 P1-5：重排是一次真实的模型调用，要 2~10 秒。同一轮对话里
 * 换个说法问同一个问题、或模型先自己搜一遍再让我搜一遍，都会重复付这个钱。
 * 这里按「查询 + 检索范围 + 知识库版本 + 用的哪个模型」做键，10 分钟内复用。
 *
 * 知识库版本 = 被检索到的每个主题 kb.jsonl 的最后修改时刻（毫秒）。
 * 知识库一改，时刻就变，缓存自动作废 —— 不会拿旧结果糊弄新内容。
 */
const RERANK_CACHE_TTL_MS = 10 * 60 * 1000
const RERANK_CACHE_MAX = 50
const rerankCache = new Map()

/** 取缓存；过期或没有就返回 null。 */
function readRerankCache(key) {
  const hit = rerankCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > RERANK_CACHE_TTL_MS) {
    rerankCache.delete(key)
    return null
  }
  return hit
}

/** 写缓存；顺手把过期的清掉，条数超了就丢最老的一条。 */
function writeRerankCache(key, value) {
  const now = Date.now()
  for (const [k, v] of rerankCache) {
    if (now - v.at > RERANK_CACHE_TTL_MS) rerankCache.delete(k)
  }
  rerankCache.set(key, { at: now, value })
  while (rerankCache.size > RERANK_CACHE_MAX) {
    const oldest = rerankCache.keys().next().value
    rerankCache.delete(oldest)
  }
}

function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * 按方向分批重排：一句 `query` 点名了几个方向，就每个方向各召回一池、各问一次模型。
 *
 * 为什么不用「一次调用 + 大候选池」（2026-10-23 用户实测两次）：
 *   ① 4 个方向塞进一次提示词时，模型会把「函数重载 / inline / this 指针」当成命中，
 *      而点名的 STL 组件、RAII 反而一条都没留；
 *   ② 候选池是固定条数，方向多于 4 个时总数永远撞天花板（用户：「你数量永远是 16，这就不对」）。
 * 每个方向单独问一次，条数随方向数自然增长，而且每个方向只用**用户自己的词**（不改写）。
 *
 * 降级：某个方向的重排没跑起来，就对该方向用本地严格门槛取前几条，其它方向不受影响。
 *
 * @param {object} input
 * @param {object} input.ctx 插件上下文
 * @param {string[]} input.directions 用户点名的方向（原词）
 * @param {object[]} input.docs 已按主题/领域过滤过的条目
 * @param {number} input.depth 每个方向的候选深度
 * @returns {Promise<{matched: object[], related: object[], used: boolean, reason: string, usage: object|null}>}
 */
async function rerankByDirections({ ctx, directions, docs, depth }) {
  const matched = []
  const related = []
  const seenMatched = new Set()
  const seenRelated = new Set()
  const reasons = []
  // 每个方向各自的结果——工具文本要按方向交代「有没有、最接近的是哪条」。
  // 2026-10-23 用户实测的场景：一个提问里**有的方向库里有、有的没有**，
  // 结果全被糊成一片，模型只能拿字面沾边的顶上，用户也没法判断哪条是「库里真没有」。
  const byDirection = []
  let used = false
  let usage = null
  // 每个方向的候选深度：比总 depth 小，够模型判断就行（单方向 8 条，方向多了也不炸提示词）
  const perDirection = Math.max(4, Math.min(8, Math.ceil(depth / 2)))

  // 1) 每个方向先召回自己的字面命中，并判断「这个方向在库里有没有独立条目」
  const plans = directions.map(direction => {
    const lexical = rankDocs(docs, direction, perDirection, { minRelative: CANDIDATE_RELATIVE }).map(hit => ({
      ...hit,
      verified: hit.verified ?? false,
      appliesTo: hit.appliesTo || null,
    }))
    return { direction, lexical, independent: hasIndependentEntry(direction, lexical) }
  })

  // 2) 并行问模型。串行 4 次要思考 2 分钟（2026-10-23 用户实测），
  //    并行后墙钟时间 ≈ 一次调用；某个方向失败只影响它自己（rerankHits 内部会退回本地排序）。
  const parts = await Promise.all(
    plans.map(async plan => {
      // 方向在库里有独立条目 → 把同领域、标签相近的条目也放进池子，
      // 让模型能挑出「同一方向的相邻知识点」放进 related（否则相关只有 1 条）。
      // 方向没有独立条目 → 不补池，照实报「库里没有」。
      const pool = plan.independent ? padPoolWithNeighbors(plan.lexical, docs, perDirection + 4) : plan.lexical
      // 广度档：命中这个方向上最直接的一两条，相关不限条数（用户点名多个方向时要「自然有很多」）
      const part = await rerankHits({
        ctx,
        query: plan.direction,
        hits: pool,
        limits: { ...MATCH_MODE.breadth, mode: 'breadth' },
      })
      return { plan, pool, part }
    }),
  )

  for (const { plan, pool, part } of parts) {
    const direction = plan.direction
    if (!pool.length) {
      byDirection.push({ direction, matched: 0, related: 0, closest: null, used: false, independent: false })
      continue
    }
    if (part.used) {
      used = true
      if (part.usage) usage = mergeUsage(usage, part.usage)
    } else {
      reasons.push(direction + '：' + (part.reason || '重排没跑起来'))
    }
    // 这个方向没跑起来就本地兜底，别把整个检索拖下水
    const best = pool[0]?.score || 0
    const partMatched = part.used
      ? part.matched
      : pool.filter(hit => hit.score >= best * MIN_RELATIVE).slice(0, 3)
    const partRelated = part.used ? part.related : []
    byDirection.push({
      direction,
      matched: partMatched.length,
      related: partRelated.length,
      // 库里确实没有时，把"最接近的那条"报出来，模型才能说清「没有独立条目，最接近的是 X」
      closest: pool[0] ? { title: pool[0].title, score: pool[0].score } : null,
      used: !!part.used,
      // 这个方向在库里有没有自己的条目（标题/标签里就是它，而不是别的条目顺带提一句）
      independent: plan.independent,
    })
    for (const hit of partMatched) {
      // 别的方向先判成 related 的，这里升级成命中
      if (seenRelated.delete(hit.id)) {
        const index = related.findIndex(item => item.id === hit.id)
        if (index >= 0) related.splice(index, 1)
      }
      if (seenMatched.has(hit.id)) continue
      seenMatched.add(hit.id)
      matched.push(hit)
    }
    for (const hit of partRelated) {
      if (seenMatched.has(hit.id) || seenRelated.has(hit.id)) continue
      seenRelated.add(hit.id)
      related.push(hit)
    }
  }
  return { matched, related, used, reason: reasons.join('；'), usage, byDirection }
}

/**
 * 问的是不是「这个领域本身」而不是一个具体问题。
 *
 * 「C++」「C++ 有哪些」「C++ 相关知识点」→ 是领域本身，命中不足时可以把该领域的条目补齐。
 * 「什么是 LRU cache」「间隙锁是什么」→ 具体问题，按领域收窄会先猜领域，猜错就把答案过滤掉。
 *
 * 做法：把问句里的套话剥掉，剩下的应当就是领域名本身。
 */
const DOMAIN_QUERY_FILLER =
  /(都有哪些|有哪些|有什么|包括哪些|相关的?知识点|相关的内容|相关的?条目|相关|知识点|内容|条目|清单|汇总|盘点|介绍|概览|是什么|怎么|如何|为什么|请|帮我|列出|全部|所有|的|了|吗|呢|都|是)/g

function isDomainOnlyQuery(query, needles) {
  if (!needles.length) return false
  // 统一小写：领域针在 store.domainNeedles 里已经归一成小写（"C++" → "c++"），
  // 这里不跟着小写就永远比不相等。
  const strip = value => String(value ?? '').toLowerCase().replace(/[?？!！。，,、/\\\s]/g, '')
  const cleaned = strip(query).replace(DOMAIN_QUERY_FILLER, '')
  if (!cleaned) return false
  const domains = needles.map(strip).filter(Boolean)
  return domains.some(domain => {
    if (cleaned === domain) return true
    // 「C++14」「MySQL 8.0」这种：领域名后面只跟着版本号，仍然算问领域本身。
    // 不能放宽成 includes —— 否则「讲 C++ 的某一点是什么」也会被当成问领域（实测踩过）。
    if (!cleaned.startsWith(domain)) return false
    const rest = cleaned.slice(domain.length)
    return /^[\d.+-]*$/.test(rest)
  })
}

/**
 * 这个方向在库里有没有「自己的条目」：方向词出现在某条候选的标题或标签里。
 * 2026-10-23 用户实测：问「RAII」时，库里只有「内存泄漏的定义与常见对象」在正文末尾
 * 顺带提了一句 RAII —— 那种不算这个方向的条目（模型差点把它当成 RAII 的答案）。
 * 用方向里最长的那个词做判断（「RAII」→ 'raii'，标题里有才算数）。
 */
function hasIndependentEntry(direction, hits) {
  const tokens = tokenize(direction).filter(token => token.length >= 2)
  if (!tokens.length) return false
  const key = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), '')
  return hits.some(hit => {
    const fields = String(hit.title || '') + ' ' + (hit.tags || []).join(' ')
    return tokenize(fields).includes(key)
  })
}

/**
 * 给某个方向补一批「同领域、标签相近」的候选，让模型有东西可以放进 related。
 *
 * 优先补与该方向命中条目**共享标签**的条目（问 STL → vector / 模板 / 迭代器 那几条），
 * 不够再补同领域的其它条目。补进来的条目由模型自己分档：命中 / 相关 / 无关。
 */
function padPoolWithNeighbors(lexical, docs, max) {
  if (lexical.length >= max) return lexical
  const seen = new Set(lexical.map(hit => hit.id))
  const tags = new Set()
  for (const hit of lexical) for (const tag of hit.tags || []) tags.add(tag)
  const rest = docs.filter(doc => !seen.has(doc.id))
  const neighbors = rest.filter(doc => (doc.tags || []).some(tag => tags.has(tag)))
  const others = rest.filter(doc => !(doc.tags || []).some(tag => tags.has(tag)))
  const picked = [...neighbors, ...others].slice(0, max - lexical.length)
  return [
    ...lexical,
    ...picked.map(doc => ({
      id: doc.id,
      topic: doc.topicSlug || doc.topic || null,
      kind: doc.kind || 'point',
      title: doc.title,
      q: doc.q || null,
      body: String(doc.body || '').slice(0, 400),
      tags: doc.tags || [],
      source: doc.source || null,
      verified: doc.verified ?? false,
      appliesTo: doc.appliesTo || null,
      version: doc.version || 1,
      updatedAt: doc.updatedAt || null,
      score: 0,
      coverage: 0,
      strength: 'weak',
      matched: [],
    })),
  ]
}

/**
 * 工具参数必须写成标准 JSON Schema：{type:'object', properties:{...}, required:[...]}。
 * 早先用的是私有 DSL（参数名直接摊在顶层、required 是布尔值），宿主投影给模型时
 * properties 为空 —— 模型看不见参数名，调用时参数被丢掉，表现为「cards 不能为空」。
 */
function toolSchema(properties, required = []) {
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/**
 * 卡片入参归一化：数组 / 单个对象 / JSON 字符串都接受。
 * 报错要直接说清正确形状，避免模型换着花样重试同一个错。
 */
function normalizeCards(raw) {
  let value = raw
  if (typeof value === 'string') {
    const rawText = value.trim()
    if (!rawText) {
      value = []
    } else {
      try {
        value = JSON.parse(rawText)
      } catch {
        throw new Error(
          'cards 是字符串但不是合法 JSON。正确形状：cards=[{"title":"知识点标题","body":"正文"}]',
        )
      }
    }
  }
  if (!Array.isArray(value)) value = value ? [value] : []
  const cards = value.filter(card => card && typeof card === 'object')
  if (!cards.length) {
    throw new Error(
      'cards 不能为空。正确形状：cards=[{"title":"知识点标题","body":"正文","tags":["标签1","标签2"]}]，至少一张卡片。',
    )
  }
  for (const card of cards) {
    const title = String(card.title ?? '').trim()
    if (!title) throw new Error('每张卡片都必须有非空 title')
    if (!String(card.body ?? '').trim()) throw new Error(`卡片「${title}」缺少 body`)
  }
  return cards
}

function sourceLabel(source) {
  if (!source) return null
  const type = source.type || 'unknown'
  const map = { user: '用户', file: '文件', web: '网络', model: '模型', unknown: '未标注' }
  const label = map[type] || type
  const locator = source.locator ? ` ${source.locator}` : ''
  return source.ref ? `${label}：${source.ref}${locator}` : `${label}${locator}`
}

function renderSource(source) {
  const label = sourceLabel(source)
  return label ? `来源 ${label}` : '来源 未标注'
}

/**
 * 这个话题是不是已经被库里某条条目的正文讲到了？
 *
 * 判据（宁可漏判，不要误判）：把提议标题拆成**实词**（去掉「为什么 / 是什么 / 需要 / 的」这类
 * 问法词与虚词），如果这些实词**全部**出现在同一条条目的标题或正文里、并且至少有一个实词
 * 出现在那条的**标题**里 → 说明那块内容库里已经有了，不该再提议补一条。
 *
 * 2026-10-23 用户实测：库里有《TCP三次握手与四次挥手》，模型却提议补「为什么挥手需要四次」
 * —— 挥手、四次这两个实词那条卡片都讲了 → 该拦。同一批里的「TIME_WAIT 为什么等 2MSL」
 * 则不该拦（2MSL 那条卡片里没有，是真的缺）。
 *
 * @param {string} title 提议标题
 * @param {object[]} entries 候选条目（当前主题的）
 * @returns {object|null} 覆盖它的那条条目，没有则 null
 */
function findCoveringEntry(title, entries) {
  const words = coverKeywords(title)
  if (words.length < 2) return null
  for (const entry of entries || []) {
    if ((entry.status || 'active') !== 'active') continue
    const body = String(entry.body || '').toLowerCase()
    const entryTitle = String(entry.title || '').toLowerCase()
    const hay = entryTitle + ' ' + body
    if (!hay.trim()) continue
    if (!words.every(word => hay.includes(word))) continue
    if (words.some(word => entryTitle.includes(word))) return entry
  }
  return null
}

/** 问法词、虚词、通用动词：出现在提议标题里不代表内容本身。 */
const COVER_STOPWORDS = new Set([
  '为什么', '是什么', '什么', '怎么', '如何', '哪些', '需要', '使用', '用于', '可以', '应该',
  '的', '了', '吗', '呢', '和', '与', '及', '或', '在', '中', '要', '会', '有', '是', '对', '把',
  'the', 'a', 'an', 'of', 'to', 'is', 'and', 'or', 'in', 'on', 'for', 'how', 'why', 'what',
])

/**
 * 从提议标题里取实词。
 *
 * 做法：中文按**停用词切段**（为什么 / 是什么 / 需要 / 的 / 和 / 与 …），
 * 剩下的每一段就是一个实词（「为什么挥手需要四次」→ 挥手、四次）；
 * 英文与数字整词保留。不用 2 字滑窗 —— 滑窗会把「手需」「要四」这种碎片也算成词，
 * 「全部命中」的判据就永远不成立。
 */
function coverKeywords(title) {
  const text = String(title || '').toLowerCase()
  const words = []
  for (const match of text.matchAll(/[a-z][a-z0-9_+-]{1,}|\d{2,}/g)) {
    if (!COVER_STOPWORDS.has(match[0])) words.push(match[0])
  }
  // 中文：按停用词切段，剩下的段就是实词
  const splitter = new RegExp(
    Array.from(COVER_STOPWORDS)
      .filter(word => /[一-鿿]/.test(word))
      .sort((a, b) => b.length - a.length)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  )
  const cjk = text.replace(/[^一-鿿]+/g, ' ')
  for (const segment of cjk.split(splitter)) {
    const word = segment.trim()
    if (word.length >= 2) words.push(word)
  }
  return Array.from(new Set(words))
}

/**
 * 主题画像的文本版：领域分布 + 标签分布。
 *
 * 为什么要有：模型不知道库里有哪些领域值，只能拿一个标签去猜 —— 猜 "C++" 就
 * 只拿到 34 条，另 17 条 C++ 相关条目（C++11、智能指针、C 语言基础）全被过滤掉。
 * 把清单摊在它面前，它自己就能判断 "C语言 13" 要不要一起捞。
 *
 * 标签只列前 8 个：252 个标签全列出来会把这条工具输出撑得比正文还长。
 */
function renderFacets(facets) {
  if (!facets) return ''
  const list = (items, max) =>
    (items || [])
      .slice(0, max)
      .map(item => `${item.value} ${item.count}`)
      .join(' / ')
  const parts = []
  const domains = list(facets.appliesTo, 10)
  if (domains) parts.push(`领域：${domains}`)
  if (!domains && facets.unscoped) parts.push(`领域：全部未标注（${facets.unscoped} 条）`)
  const tags = list(facets.tags, 8)
  if (tags) parts.push(`标签：${tags}`)
  return parts.join('\n')
}

function renderHitBlock(hit) {
  const lines = []
  lines.push(`${hit.strength} [${hit.score}] ${hit.fromCurrent ? '★' : ''}${hit.title}${hit.verified ? ' ✓已核实' : ' ⚠未核实'}${hit.padded ? '（按领域补全，非文字命中）' : ''}`)
  if (hit.q) lines.push(`问：${hit.q}`)
  lines.push(hit.body || '(空)')
  const meta = []
  if (hit.tags?.length) meta.push(`标签 ${hit.tags.join('/')}`)
  if (hit.appliesTo) meta.push(`适用 ${hit.appliesTo}`)
  if (hit.source) meta.push(renderSource(hit.source))
  if (hit.topic) meta.push('主题 ' + hit.topic)
  if (meta.length) lines.push(meta.join(' · '))
  return lines
}

/**
 * 卡片角色。界面靠它把「库中已有的」和「这次要加的」分开显示。
 *
 * 为什么加：用户 2026-10-23 反馈「卡片之间没有区分」。根因不是配色，是卡片
 * 根本没有来源信息 —— 一律按主题色上色，同主题同色，看起来就是同一批东西。
 *   existing 库中已有（检索命中、清单列出）
 *   new      本次新增（写入计划里的 create）
 *   update   本次更新（写入计划里的 update / restore）
 *   preview  待写入（还没有落盘，也没有可更新的既有条目）
 */
export const CARD_ROLES = ['existing', 'new', 'update', 'preview']

/** 写入计划的一项 → 卡片角色。 */
export function roleOfPlanItem(item) {
  if (!item || !item.action) return 'preview'
  if (item.action === 'create') return 'new'
  if (item.action === 'update' || item.action === 'restore') return 'update'
  return 'preview'
}

/**
 * 把一条命中投影成界面卡片。
 * 命中和相关补充共用同一份形状，界面只是把后者排在后面并默认折叠。
 * @param {object} hit 命中条目
 * @returns {object} 卡片数据
 */
function projectHitCard(hit) {
  return {
    id: hit.id || null,
    title: String(hit.title || ''),
    body: String(hit.body || ''),
    topic: hit.topic || '',
    topicName: hit.topicName || hit.topic || '',
    kind: hit.kind || 'point',
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    verified: hit.verified ?? false,
    version: hit.version || 1,
    source: hit.source || null,
    appliesTo: hit.appliesTo || null,
    updatedAt: hit.updatedAt || null,
    score: typeof hit.score === 'number' ? hit.score : null,
    // 角色：检索/清单一律「库中已有」，写入另算（见 roleOfPlanItem）。
    role: CARD_ROLES.includes(hit.role) ? hit.role : 'existing',
  }
}

function renderHits(value) {
  if (value.needTopic) {
    return `没有绑定主题，无法检索主题库。${value.note || ''}`
  }
  const related = Array.isArray(value.related) ? value.related : []
  const lines = [
    `检索 "${value.query}" → 范围 ${value.scope}，库内 ${value.total} 条，命中 ${value.hits.length} 条`
      + (related.length ? `，相关补充 ${related.length} 条` : '')
      + (value.appliesToApplied ? `（已按领域 ${value.appliesToApplied} 收窄；要列全该领域请用 learn_entries(appliesTo)）` : ''),
  ]
  if (value.note) {
    lines.push('（' + String(value.note) + '）')
  }
  // 按方向分批检索时，逐方向交代结果：哪个方向有、哪个方向库里根本没有。
  // 2026-10-23 用户实测：一个提问里有的方向库里有、有的没有，全糊在一起时模型只能拿
  // 字面沾边的条目顶上，用户也看不出「这条其实库里没有」。
  if (Array.isArray(value.directions) && value.directions.length) {
    lines.push('')
    lines.push(`按方向分开检索（${value.directions.length} 个方向，每个方向单独问一次模型）：`)
    for (const item of value.directions) {
      if (item.matched > 0) {
        lines.push(
          `- ${item.direction}：命中 ${item.matched} 条` +
            (item.related ? `，相关 ${item.related} 条` : '') +
            (item.independent === false ? '（库里没有这个方向的独立条目，命中的是别的条目里顺带提到的）' : ''),
        )
      } else if (item.related > 0) {
        lines.push(`- ${item.direction}：没有直接命中，相关补充 ${item.related} 条`)
      } else {
        lines.push(
          `- ${item.direction}：库里没有对应条目` +
            (item.closest ? `（最接近的是「${item.closest.title}」，只是字面沾边，不是答案）` : ''),
        )
      }
    }
    lines.push(
      '标「库里没有」的方向要如实告诉用户库里没有（可以补一句你能从自己的知识讲什么），不要拿"最接近的那条"冒充答案。',
    )
  }
  for (const hit of value.hits) {
    lines.push('')
    lines.push(...renderHitBlock(hit))
  }
  // 重排跑起来了但一条都没留：要说清是「没命中」而不是「没检索」，
  // 否则模型会再搜一遍（2026-10-23：全无关不再硬塞本地前 3 条）。
  if (!value.hits.length && !related.length && value.rerank?.used) {
    lines.push('')
    lines.push('（模型把这些候选都判为无关 —— 不是没检索，是没命中。可以换个说法再试，或者如实告诉用户库里没有对应条目。）')
  }
  // 相关补充：不是答案，但同领域。单独一段，模型能当作背景参考，界面里折叠显示。
  //
  // 这里只给标题和一行摘要，不给正文（2026-10-23 成本实测）：相关条目本来就不是答案，
  // 模型只需要知道「还有这么几条可以顺带说」，正文全量发过去是白烧 token；
  // 界面上卡片仍然是全文（presentationMeta 那条路没动）。
  if (related.length) {
    lines.push('')
    lines.push('—— 相关补充（不是答案，仅供参考）——')
    for (const hit of related) {
      const firstLine = String(hit.body || '')
        .split('\n')
        .map(line => line.trim())
        .find(Boolean)
      lines.push(`- ${hit.title}${firstLine ? '：' + firstLine.slice(0, 60) : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * 宿主不变量：dsh-ops 的 hide-official 开启时，会检查它接管的官方文件工具是否都有
 * OPS 替身。少了下面任何一个，宿主判定 READINESS_BLOCKED，agent 直接不可用
 *（2026-10-22 实测踩过：一发消息就挂）。这些工具永远不能被限制掉。
 */
/** 当前主题的命中在排序里加权的系数：只用来压同分档，不能盖过高分答案。 */
const CURRENT_TOPIC_BOOST = 1.15

export const MUST_KEEP = [
  'ops_replace',
  'ops_write_file',
  'ops_edit_file',
  'ops_diff',
  'ops_stat',
  'ops_copy',
  'ops_move',
  'ops_remove',
]

/**
 * 学习模式不想要的全局工具。
 *
 * 用 deny 而不是 allow：allow 少写一个名字就整份失效，而且会踩宿主接管面；
 * deny 是「默认保留、点名去掉」，以后新增的宿主工具默认可见，坏不了。
 * ops_* 与 pwsh 属于 dsh-ops 的接管面，一律不列进来。
 * 作用域内注册的工具（web_search / learn_* / todo_write）也不列 —— restrict 遇到
 * scope-local 名字会让整次调用失败。
 */
export const DENY_TOOLS = [
  'workflow',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_list',
  'plugin_manager',
  'generate_image',
  'edit_image',
  'generate_video',
  'generate_video_from_image',
  'cancel_image_generation_task',
  'cancel_video_generation_task',
  'get_image_generation_task',
  'get_video_generation_task',
  'subagent',
  'subagent_fork',
  'get_goal',
  'create_goal',
  'update_goal',
  'engram_store',
  'engram_recall',
  'engram_detail',
  'esr_task',
  'esr_claim',
  'esr_unclaim',
  'esr_close',
  'esr_link',
  'esr_dep',
  'esr_node',
  'esr_model',
  'esr_ready',
  'esr_status',
  'esr_gc',
]

/** 审批等待上限：用户一直没点就当取消，避免工具调用挂死。 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** 写入结果渲染：状态 + 计划 + 查重提示。 */
function renderSave(value) {
  const lines = []
  if (value.status === 'written') {
    lines.push(`【已写入】主题「${value.topic}」，该主题现有 ${value.total} 条`)
  } else if (value.status === 'rejected') {
    lines.push('【未写入】用户拒绝了这次写入，库里没有改动。')
  } else if (value.status === 'cancelled') {
    lines.push('【未写入】写入被取消，库里没有改动。')
  } else {
    lines.push(`【预览，未写入】主题「${value.topic}」，将变更 ${value.plan.length} 条：`)
  }
  for (const p of value.plan || []) {
    const verb = p.action === 'create' ? '新增' : p.action === 'restore' ? '恢复' : '更新'
    lines.push(`- ${verb} ${p.title}${p.version > 1 ? ' (v' + p.version + ')' : ''}${p.verified === false ? ' ⚠未核实' : ''}${p.appliesTo ? ' 适用:' + p.appliesTo : ''}`)
  }
  if (value.similar?.length) {
    lines.push('⚠ 疑似重复（同主题已有相近内容，标题不同所以没走更新）：')
    for (const s of value.similar) {
      lines.push(`- 《${s.title}》 标题相似 ${s.titleScore} / 正文相似 ${s.bodyScore}`)
    }
  }
  if (value.nearby?.length) {
    lines.push('同主题相关条目（供参照）：')
    for (const n of value.nearby) lines.push(`- 《${n.title}》`)
  }
  if (value.related?.length) {
    lines.push('相似/冲突提示：')
    for (const r of value.related) {
      lines.push(`- [${r.topic}] ${r.title}${r.conflict ? ' ⚠可能是冲突：' + r.note : '（' + r.note + '）'}`)
    }
  }
  if (value.message) lines.push(value.message)
  return lines.join('\n')
}

/**
 * 正文首行摘要：给确认框看。
 *
 * 为什么要有：2026-10-23 用户反馈「不会先给我预览卡片效果和内容」——
 * 确认框里只有标题，用户看不到写进去的是什么，就只能拒绝。
 * 首行本来就是卡片正文的结论行（body 格式：首行结论），拿来当摘要正合适。
 * 截到 60 字，够判断对不对，又不至于把确认框撑爆。
 */
export function firstLine(body, max = 60) {
  const line = String(body || '')
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean)
  if (!line) return ''
  return line.length > max ? line.slice(0, max) + '…' : line
}

/** 确认框里给用户看的内容（中文）。 */
function buildApprovalText(plan, cards = []) {
  const lines = []
  const verb = plan.plan.length > 1 ? '写入' : '写入'
  lines.push(`将向主题「${plan.topic}」${verb} ${plan.plan.length} 条知识：`)
  for (const [index, p] of plan.plan.entries()) {
    const act = p.action === 'create' ? '新增' : p.action === 'restore' ? '恢复' : '更新'
    lines.push(`- ${act}《${p.title}》${p.version > 1 ? '（→ v' + p.version + '）' : ''}`)
    const preview = firstLine(cards[index]?.body)
    if (preview) lines.push(`  正文：${preview}`)
  }
  if (plan.similar?.length) {
    lines.push('⚠ 疑似重复：同主题已有相近内容（标题不同所以没走更新）')
    for (const s of plan.similar) lines.push(`  · 《${s.title}》 标题相似 ${s.titleScore} / 正文相似 ${s.bodyScore}`)
  }
  if (plan.related?.length) {
    lines.push('相似/冲突提示：')
    for (const r of plan.related) {
      lines.push(`  · [${r.topic}] ${r.title}${r.conflict ? ' ⚠可能是冲突' : ''}`)
    }
  }
  if (plan.nearby?.length) {
    lines.push('同主题相关条目：' + plan.nearby.map(n => `《${n.title}》`).join('、'))
  }
  return lines.join('\n')
}

/** 确认框里给用户看的内容（英文，displayReason.en 必填）。 */
function buildApprovalTextEn(plan, cards = []) {
  const lines = [`Write ${plan.plan.length} knowledge card(s) to topic «${plan.topic}»:`]
  for (const [index, p] of plan.plan.entries()) {
    const act = p.action === 'create' ? 'add' : p.action === 'restore' ? 'restore' : 'update'
    lines.push(`- ${act} «${p.title}»${p.version > 1 ? ' (→ v' + p.version + ')' : ''}`)
    const preview = firstLine(cards[index]?.body)
    if (preview) lines.push(`  body: ${preview}`)
  }
  if (plan.similar?.length) {
    lines.push('⚠ Looks like a near-duplicate: ' + plan.similar.map(s => `«${s.title}»`).join(', '))
  }
  if (plan.related?.length) {
    lines.push('Related/conflict: ' + plan.related.map(r => `«${r.title}»`).join(', '))
  }
  return lines.join('\n')
}

/**
 * 调宿主的审批通道弹确认框。
 * 返回 allowed-once / rejected / cancelled / unavailable。
 * unavailable = 宿主没提供审批通道或调用失败 → 调用方降级成两步流程。
 */
async function requestApproval({ ctx, exec, plan, cards = [] }) {
  const approval = ctx?.get?.('approval')
  if (!approval || typeof approval.request !== 'function') return 'unavailable'
  const agent = exec?.agent
  if (!agent) return 'unavailable'
  const zh = buildApprovalText(plan, cards)
  const en = buildApprovalTextEn(plan, cards)
  let timer = null
  try {
    const outcome = await Promise.race([
      approval.request({
        agent,
        toolName: 'learn_save',
        callId: exec?.callId,
        reason: zh,
        displayReason: { en, 'zh-CN': zh, zh },
        signal: exec?.signal,
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve('cancelled'), APPROVAL_TIMEOUT_MS) }),
    ])
    return typeof outcome === 'string' ? outcome : 'unavailable'
  } catch {
    return 'unavailable'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 真正落盘（指纹闸门在这里再查一次）。 */
function writeNow({ store, topic, cards, sessionId }) {
  const checkSlug = topic
    ? store.findTopic(topic)?.slug ?? slugify(topic)
    : store.currentTopic(sessionId)
  if (checkSlug && !store.hasPreviewed(checkSlug, cards)) {
    throw new Error('这批内容还没有预览过，不能直接写入。')
  }
  const result = store.planSave({ topic, cards, sessionId, dryRun: false })
  return {
    ...result,
    dryRun: false,
    status: 'written',
    message: `已写入主题「${result.topic}」，该主题现有 ${result.total} 条。`
  }
}

/**
 * 写库主流程：
 *   1. 归一化卡片、解析主题
 *   2. 算写入计划 + 查重（疑似重复 / 同主题相关 / 跨主题冲突）
 *   3. 默认 mode=preview → 只出预览（卡片摆给用户看，不写库）；
 *      mode=commit → 弹宿主确认框，用户点了就写
 *   4. 写盘前仍要过「这批内容预览过没有」的服务端指纹闸门
 *
 * 为什么默认是 preview（2026-10-23 用户反馈）：
 *   「直接问我要权限写入，不会先给我预览卡片效果和内容，只有我拒绝前面的写入
 *   才会给我先预览的选项」—— 旧默认是 commit，第一步就弹权限框，
 *   用户看不到内容就只能拒绝。现在第一步先把卡片摆出来：
 *     · 界面上卡片底部有「确认写入 N 条」按钮 → 点一下直接落库（不用模型再跑一趟）
 *     · 用户口头说「写」→ 模型再调一次 mode="commit" 且 approved=true（降级路径）
 */
async function runSave({ ctx, store, args, exec }) {
  const sessionId = sessionIdOf(exec)
  const cards = normalizeCards(args?.cards)
  const topic = args?.topic ? String(args.topic).trim() : undefined
  // 默认预览：只有显式写 mode="commit" 才走确认框那条路
  const mode = args?.mode === 'commit' ? 'commit' : 'preview'
  const approved = !!args?.approved
  const bypassDuplicate = !!args?.bypassDuplicate

  const checkSlug = topic
    ? store.findTopic(topic)?.slug ?? slugify(topic)
    : store.currentTopic(sessionId)
  const previewed = checkSlug ? store.hasPreviewed(checkSlug, cards) : false

  // 降级路径：审批通道不可用时，用户在对话里点头了才允许直接写
  if (approved) {
    if (!previewed) {
      throw new Error('这批内容还没有预览过，不能直接写入。请先调 learn_save(cards) 出预览，让用户确认后再带 approved=true 调一次。')
    }
    return writeNow({ store, topic, cards, sessionId })
  }

  // 算计划（只算不写）
  const plan = store.planSave({ topic, cards, sessionId, dryRun: true })
  store.markPreviewed(plan.topic, cards)

  const hasDuplicate = (plan.similar?.length || 0) > 0
  if (hasDuplicate && !bypassDuplicate && mode === 'commit') {
    return {
      ...plan,
      dryRun: true,
      status: 'need_decision',
      message: store.getKbEditTools()
        ? '这条和库里的条目高度相似，先请用户裁决：补充原条目（learn_update）还是仍然新增（bypassDuplicate=true）。'
        : '这条和库里的条目高度相似，先请用户裁决：在库里的原条目上补充，还是仍然新增（bypassDuplicate=true）。',
    }
  }

  if (mode === 'preview') {
    // 登记成「待写入批次」：界面上「确认写入 N 条」按钮按 batchId 回来取这批内容落盘。
    // 批次本身也是「用户已经看过这批内容」的凭据，写入时还要再过一次指纹闸门。
    const batchId = registerSaveBatch({
      topicArg: topic || null,
      slug: plan.topic,
      cards,
      sessionId,
      similarCount: plan.similar?.length || 0,
      bypassDuplicate,
    })
    return {
      ...plan,
      dryRun: true,
      status: 'preview',
      batchId,
      message:
        '预览（未写入）。卡片已经摆出来了：用户可以在卡片下方点「确认写入」直接落库；' +
        '用户口头同意的话，用 mode="commit" 且 approved=true 再调一次（内容要和这一批完全一致）。',
    }
  }

  // 弹宿主确认框
  const outcome = await requestApproval({ ctx, exec, plan, cards })
  if (outcome === 'allowed-once') {
    return writeNow({ store, topic, cards, sessionId })
  }
  if (outcome === 'rejected') {
    return {
      ...plan,
      dryRun: true,
      status: 'rejected',
      message: '用户拒绝了这次写入，库里没有改动。',
    }
  }
  if (outcome === 'cancelled') {
    return {
      ...plan,
      dryRun: true,
      status: 'cancelled',
      message: '写入被取消，库里没有改动。',
    }
  }
  // unavailable：降级成「对话里确认」
  return {
    ...plan,
    dryRun: true,
    status: 'preview',
    message: '确认框不可用（宿主没提供审批通道）。已出预览：请让用户在对话里说「可以」，然后用 mode="commit" 且 approved=true 再调一次。',
  }
}

export function apply(ctx) {
  const store = createStore(resolveRoot())
  // 检索重排也走 llm.js 的 callModel：把「插件自己的模型设置」挂上，
  // 否则这里会自顾自跟会话模型走，用户在面板里换的模型对重排不生效。
  // （两个半侧在同一进程、共用同一个 llm.js 模块实例，所以设一次就都生效。）
  setModelPreference(() => store.getAiModel())

  ctx.tools.register({
    name: 'learn_topics',
    description:
      '学习模式的知识库主题管理：list 列出全部主题（带领域分布）| create 新建并绑定 | use 切到已有主题 | current 看当前绑定 | find 模糊查找 | default 设置/清除默认主题。',
    parameters: toolSchema(
      {
        action: {
          type: 'string',
          enum: ['list', 'create', 'use', 'current', 'find', 'default'],
          description: 'list 列出 | create 新建并绑定 | use 切换 | current 当前绑定 | find 查找 | default 默认主题',
        },
        name: {
          type: 'string',
          description: '主题名。create 必填；use/find 填名称；default 填要设为默认的主题名，空串则清除默认',
        },
        description: {
          type: 'string',
          description: '主题说明（仅 create）',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '主题关键词（仅 create），供按关键词模糊查找',
        },
        domain: {
          type: 'string',
          description:
            '主题级领域（仅 create，可选）：条目没标 appliesTo 时用它兜底。比如 mysql-进阶 设成 "MySQL" —— 主题本身就是一个领域，不必要求每条都标。',
        },
      },
      ['action'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          [
            value.current
              ? `当前主题：${value.current.name}（${value.current.activeCount} 条）${value.currentFromDefault ? ' · 来自默认主题' : ''}`
              : '当前主题：未绑定',
            value.defaultTopic ? `默认主题：${value.defaultTopic}` : '默认主题：未设置（新会话会先问放哪个主题）',
            value.found ? `匹配到主题：${value.found.name}（${value.found.slug}）` : '',
            value.topics.length ? '全部主题：' : '知识库还是空的，先用 action=create 建一个主题。',
            ...value.topics.map(
              t =>
                `- ${t.name}（${t.activeCount} 条）${t.description ? ' — ' + t.description : ''}${
                  t.keywords?.length ? ' {' + t.keywords.join('/') + '}' : ''
                }${t.domain ? ' 主题领域：' + t.domain : ''}${
                  t.domains?.length
                    ? ' 领域：' + t.domains.map(d => d.value + ' ' + d.count).join(' / ')
                    : ' 领域：未标注'
                }${t.tags?.length ? ' 标签：' + t.tags.map(d => d.value + ' ' + d.count).join(' / ') : ''}`,
            ),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const action = String(args?.action || 'list')
      const name = String(args?.name || '').trim()

      if (action === 'find') {
        const found = name ? store.findTopic(name) : null
        return { action, found, current: null, defaultTopic: store.getDefaultTopic(), topics: store.listTopics() }
      }

      if (action === 'default') {
        const slug = store.setDefaultTopic(name || null)
        const topics = store.listTopics()
        const current = slug ? topics.find(t => t.slug === slug) || null : null
        return { action, current, defaultTopic: store.getDefaultTopic(), topics, found: null }
      }

      if (action === 'create' || action === 'use') {
        if (!name) throw new Error(`${action} 需要 name 参数（主题名称）`)
        const existing = store.findTopic(name)
        let slug
        if (action === 'use') {
          if (!existing) {
            throw new Error(
              `主题「${name}」不存在。use 只能切到已有主题；要新建请用 action="create"。`,
            )
          }
          slug = existing.slug
        } else {
          slug = store.createTopic(name, {
            description: args?.description,
            keywords: args?.keywords,
            domain: args?.domain,
          })
        }
        if (sessionId) store.bindTopic(sessionId, slug)
        const topics = store.listTopics()
        const current = topics.find(t => t.slug === slug) || null
        return { action, current, defaultTopic: store.getDefaultTopic(), topics, reused: !!existing, found: null }
      }

      const topics = store.listTopics()
      const bound = sessionId ? store.currentTopic(sessionId) : null
      const defaultTopic = store.getDefaultTopic()
      const current = bound ? topics.find(t => t.slug === bound) || null : null
      return {
        action,
        current,
        currentFromDefault: !!current && !!defaultTopic && current.slug === defaultTopic,
        defaultTopic,
        topics,
        found: null,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '知识库主题',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'learn_search',
    description:
      '检索知识库回答问题：返回「命中」（直接回答）与「相关补充」（同领域但不是答案），无关的丢掉。' +
      '用法：具体问题把原话整句传进来直接搜，别先查主题列表（每次工具调用都是一次完整请求）；' +
      '点名多个方向时也用原句一次调用（别把一次检索拆成多次调用），检索器自己按「、」拆方向分别召回，**不要自己把方向改写成更窄的词**；' +
      'appliesTo 只在范围性问题（某领域有哪些 / 点名多方向）才传，**具体问题不要传 appliesTo**' +
      '（领域要先猜，猜错就把答案过滤掉了）；**传 appliesTo 前先确认这个主题有没有领域**' +
      '（learn_topics 里写了「主题领域：X」或分布里有具体领域才能收窄）；' +
      '范围问题用 appliesTo 收窄，别拿 tag 当范围条件（tag 精确匹配会漏同族条目）；' +
      '**具体问题要的是少而准**：命中最多 2 条、相关最多 3 条，别把沾边但没回答的也摆上去。' +
      '模型不可用时退回本地排序并说明原因。',
    parameters: toolSchema(
      {
        query: {
          type: 'string',
          description:
            '检索词，直接用用户原话；用「、」点名多个方向时会自动按方向分别检索——不要自己把方向改写成更窄的词。',
        },
        scope: {
          type: 'string',
          enum: ['auto', 'topic', 'all'],
          default: 'auto',
          description: 'auto（默认）| topic 只查当前主题 | all 查所有主题',
        },
        topic: {
          type: 'string',
          description: '指定主题；不存在只返回提示，不会新建',
        },
        tag: { type: 'string', description: '只返回带该标签的条目（精确匹配）' },
        appliesTo: {
          type: 'string',
          description:
            '按领域收窄（数组或逗号分隔，如 "C++"；忽略大小写空格，"C++" 也命中 "C++14/17"）。要列全某领域用 learn_entries。',
        },
        limit: {
          type: 'integer',
          description:
            '候选深度（默认 3，最大 10）：本地召回多少条交给重排。具体问题命中最多 2 条、相关最多 3 条；点名多个方向时每个方向命中一两条、相关不限条数。',
        },
      },
      ['query'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderHits(value)),
      // 结构化卡片：界面用它把命中渲染成卡片（对话里 / 侧边栏里同一份数据）。
      // 渲染文本是给人（和模型）看的，presentationMeta 才是给界面做卡片用的。
      presentationMeta: (_args, value) => ({
        kbCards: (Array.isArray(value?.hits) ? value.hits : []).map(projectHitCard),
        // 相关补充：同一份投影，但界面里排在命中卡片之后、默认折叠。
        kbRelated: (Array.isArray(value?.related) ? value.related : []).map(projectHitCard),
        // 卡片是哪来的：界面据此区分「检索命中」和「清单列出」——
        // 把列出来的 251 条说成「命中 251 条」是骗人（2026-10-23 用户实测）。
        kbCardSource: 'search',
        kbRerank: value?.rerank && value.rerank.used ? null : String(value?.rerank?.reason || ''),
        // 检索重排也是真金白银的一次模型调用：用量随结果一起发到界面
        kbTokens: value?.rerank && value.rerank.usage ? { rerank: value.rerank.usage } : null,
      }),
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      const query = String(args?.query || '').trim()
      if (!query) throw new Error('query 不能为空')
      const scope = ['topic', 'all', 'auto'].includes(args?.scope) ? args.scope : 'auto'
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 3))
      const tag = args?.tag ? String(args.tag).trim() : null
      const needles = store.domainNeedles(args?.appliesTo)
      // 方向拆分放在最前面：它决定「这次检索是不是范围性问题」，
      // 而范围性问题才该按领域收窄（见下面的 domainFilterActive）。
      const segments = splitQuerySegments(query)
      // 领域**只用来筛范围性问题**（2026-10-23 用户定）：
      //   · 具体问题（「间隙锁是什么」「什么是 LRU cache」）→ 不按领域收窄。
      //     按领域收窄要先猜领域，猜错就把答案过滤掉了（实测：间隙锁被 appliesTo=MySQL 挤掉），
      //     而具体问题靠文字匹配 + 重排本来就够准。
      //   · 范围性问题（「C++ 有哪些」/ 点名多个方向）→ 收窄，避免整库倒出来、混进跨领域条目。
      const domainFilterActive = needles.length > 0 && (segments.length >= 2 || isDomainOnlyQuery(query, needles))

      const explicit = args?.topic ? String(args.topic).trim() : ''
      const allTopics = store.listTopics()
      // 检索不建主题：名字写错不该在库里留下空主题
      const currentSlug = explicit
        ? store.findTopic(explicit)?.slug || null
        : sessionId
          ? store.currentTopic(sessionId)
          : null

      if (explicit && !currentSlug) {
        return {
          scope: 'topic',
          query,
          total: 0,
          hits: [],
          needTopic: true,
          note: `主题「${explicit}」不存在。用 learn_topics(action="list") 看现有主题，或 action="create" 新建。`,
        }
      }

      // 检索范围：
      //   topic → 只查当前主题
      //   all   → 查全部主题
      //   auto  → 也查全部主题，但**当前主题的命中在同分档里优先**
      //
      // 这里修过一个会吞掉正确答案的 bug（2026-10-22 用户踩到）：
      // 旧实现是「先查当前主题，凑够 limit 就不再查别的主题」，于是当前主题里
      // 3 条无关的弱命中就能把别处的高分答案挤掉 ——
      // 问「什么是 LRU cache」时，当前主题（mysql-进阶）返回 3 条缓冲池的弱命中，
      // 真正那条 134 分的「什么是LRU cache」（在「面试」主题）连看都没看到。
      const slugs = scope === 'topic'
        ? (currentSlug ? [currentSlug] : [])
        : allTopics.map(t => t.slug)

      const docs = []
      // 领域收窄**不能把当前主题清空**（2026-10-23 用户实测的真凶）：
      // mysql-进阶 的 123 条条目一条都没标 appliesTo，模型按 persona 传了 appliesTo="MySQL"，
      // 结果当前主题被过滤得一条不剩，检索退到「面试」主题里那 9 条 MySQL 领域的条目 ——
      // 全是事务隔离级别 / MVCC / 索引结构这类**皮命中**，而真正的答案（间隙锁）在库里却被过滤掉了。
      // 规则：收窄后当前主题一条不剩，就说明这个主题没标领域 → 这一主题放弃收窄、按主题内全量检索，
      // 并在返回里说明（模型和用户都要知道收窄没生效）。
      let domainFallbackNote = ''
      const topicEntries = new Map()
      const topicDomains = new Map()
      for (const slug of slugs) {
        const kept = []
        for (const entry of store.readEntries(slug)) {
          if ((entry.status || 'active') !== 'active') continue
          if (tag && !(entry.tags || []).includes(tag)) continue
          kept.push(entry)
        }
        topicEntries.set(slug, kept)
        // 主题级领域：条目没标 appliesTo 时用主题的 domain 兜底（2026-10-23 用户定：
        // 「主题就是一种领域」—— mysql-进阶 主题里的知识点，领域就是 MySQL）
        topicDomains.set(slug, store.topicDomain(slug))
      }
      for (const slug of slugs) {
        const entries = topicEntries.get(slug) || []
        const isCurrent = !!currentSlug && slug === currentSlug
        const topicDomain = topicDomains.get(slug) || ''
        if (!domainFilterActive) {
          docs.push(...entries.map(entry => ({ ...entry, topicSlug: slug })))
          continue
        }
        const matched = entries.filter(entry => store.matchDomain(entry.appliesTo || topicDomain, needles))
        if (matched.length) {
          docs.push(...matched.map(entry => ({ ...entry, topicSlug: slug })))
          continue
        }
        if (isCurrent && entries.length) {
          domainFallbackNote =
            `当前主题「${slug}」既没有标领域、也没设主题领域，按 appliesTo=${needles.join(',')} 收窄会一条不剩，已改为在主题内检索。`
          docs.push(...entries.map(entry => ({ ...entry, topicSlug: slug })))
        }
        // 其它主题：收窄后为空就整条不收（保持原来的语义）
      }
      // 没有绑定主题、且按领域收窄后整个库都空了 → 放弃收窄，宁可多召回也不要空手
      if (domainFilterActive && !docs.length) {
        for (const slug of slugs) {
          docs.push(...(topicEntries.get(slug) || []).map(entry => ({ ...entry, topicSlug: slug })))
        }
        domainFallbackNote = `按 appliesTo=${needles.join(',')} 收窄后库里一条都没有，已改为全库检索。`
      }
      const domainApplied = domainFilterActive && !domainFallbackNote ? needles.join(',') : null
      // 模型传了 appliesTo、但这是个具体问题 → 明确告诉它这次没按领域筛（它才知道为什么）
      if (needles.length && !domainFilterActive && !domainFallbackNote) {
        domainFallbackNote =
          `这次是具体问题，没有按 appliesTo=${needles.join(',')} 收窄（领域只用来筛「某领域有哪些」这类范围性问题，` +
          '按领域收窄要先猜领域，猜错会把答案过滤掉）。要盘点某个领域请用 learn_entries(appliesTo)。'
      }
      // 相关补充**不限条数**（2026-10-23 用户定：「相关知识点不用限制数量，既然这个是比较宽松
      // 的筛选，那自然会有很多」）。以前还有一层「跨主题时只留 1 条」的收紧，那是在用数量补
      // 判据的漏；现在判据（同主题 + 同领域 + 共享一个词就 drop）已经写严，数量不再设限。
      const total = docs.length

      // 多取一些做候选：本地排序只提供"候选池"，最终分档交给大模型。
      // 池子要比 limit 宽，而且**召回门槛放得松**（CANDIDATE_RELATIVE）——
      // 精确判断交给重排那一步，本地不必先替它筛掉"差不多相关"的条目。
      const depth = Math.min(60, Math.max(limit * 3, 8))
      // 2026-10-23 用户定：**按方向分批问模型**。
      // 一次调用里塞「4 个方向 + 16 条候选」实测不行 —— 模型把函数重载 / inline / this 指针
      // 当成命中，点名的 STL / RAII 反而丢了；而且总数被候选池钉死（方向多于 4 个时永远 16 条）。
      // 现在：方向 = 用户自己点名的词（splitQuerySegments 只按「、」拆，不改写一个字），
      // 每个方向各召回一池、各跑一次重排，结果按方向顺序合并去重。
      // 方向有几个就调几次模型 —— 这就是"分批次找大模型"，但查询词永远是用户的原话。
      // （segments 在上面算好了：它同时决定这次检索要不要按领域收窄。）
      const toCandidate = hit => ({
        ...hit,
        verified: hit.verified ?? false,
        appliesTo: hit.appliesTo || null,
        fromCurrent: !!currentSlug && hit.topic === currentSlug,
      })
      const candidates =
        segments.length >= 2
          ? []
          : rankDocs(docs, query, depth, { minRelative: CANDIDATE_RELATIVE })
              .map(toCandidate)
              .sort((a, b) => {
                const wa = a.score * (a.fromCurrent ? CURRENT_TOPIC_BOOST : 1)
                const wb = b.score * (b.fromCurrent ? CURRENT_TOPIC_BOOST : 1)
                return wb - wa
              })

      // 大模型重排：把候选分成「直接命中」和「相关补充」，无关的丢掉。
      // 任何失败（没模型 / 超时 / 返回不合法）都退回本地排序，卡片照常出。
      //
      // 缓存（审计 P1-5）：同一个问题 + 同一份知识库 + 同一个模型，10 分钟内不重复调模型。
      // 知识库一改就自动作废；模型失败的结果不缓存（免得模型恢复后还拿着旧失败）。
      const selection = resolveSelection(ctx)
      const kbStamp = slugs.map(slug => `${slug}@${store.topicStamp(slug)}`).join(',')
      const cacheKey = [query, scope, limit, tag || '', needles.join(','), selection.model || '', kbStamp].join('|')
      const cached = readRerankCache(cacheKey)
      let split
      let fromCache = false
      if (cached) {
        split = cached.value
        fromCache = true
      } else {
        split =
          segments.length >= 2
            ? await rerankByDirections({ ctx, directions: segments, docs, depth })
            : await rerankHits({
                ctx,
                query,
                hits: candidates,
                // 具体问题（不是点名多方向）：命中只留最直接的一两条、相关只留真正相邻的几条 ——
                // 2026-10-23 用户实测「明明有一个卡片比较合适、完全够用，他还有很多的皮命中」。
                limits: { limit: MATCH_MODE.exact.maxMatch, ...MATCH_MODE.exact, mode: 'exact' },
              })
        if (split.used) writeRerankCache(cacheKey, split)
      }

      let matched = split.matched
      let related = split.related
      if (!split.used && segments.length < 2) {
        // 降级：模型没帮上忙，就得靠本地门槛把噪声挡住。
        // 用严格门槛（MIN_RELATIVE）重筛一遍，别把放给模型的宽松召回直接甩给用户。
        // （按方向分批的路径自己在 rerankByDirections 里降级，不走这里。）
        const best = candidates.length ? candidates[0].score : 0
        matched = candidates
          .filter(hit => hit.score >= best * MIN_RELATIVE)
          .slice(0, limit)
        related = []
      }

      // 领域内补全（2026-10-23）：query 只写到领域名（"C++"）时，BM25 会把整片同质条目
      // 的 IDF 压到接近 0 —— 实测 38 条 C++ 领域条目里只召回 4~5 条。用户问的是「这个领域
      // 有哪些」，不是「最像的那 3 条」，所以命中不足 limit 时按出处页码把同领域条目补齐。
      // 补的条目带 padded=true，文本里会标「按领域补全，非文字命中」—— 不冒充答案。
      //
      // 只在「问的几乎就是领域名本身」时补：具体问题（"什么是 X"）补进来的是皮命中，
      // 用户实测过「明明有一个卡片够用，却匹配了一堆」。
      //
      // 放在分档之后做：先按文字/模型分档，剩下的名额才用来补齐。反过来的话
      // 补全条目会先占掉 limit，把真正的高分命中挤掉。
      // 按方向分批时不做这层补全：逐方向已经会如实说「库里没有」，
      // 再把领域里的条目塞进命中就自相矛盾了（2026-10-23 用户测的正是「有的方向有、有的没有」）。
      if (segments.length < 2 && needles.length && matched.length < limit && isDomainOnlyQuery(query, needles)) {
        const seen = new Set([...matched, ...related].map(hit => hit.id))
        const rest = docs
          .filter(doc => !seen.has(doc.id))
          .sort(
            (a, b) =>
              store.locatorPage(a.source) - store.locatorPage(b.source) ||
              String(a.title || '').localeCompare(String(b.title || '')),
          )
        for (const doc of rest.slice(0, limit - matched.length)) {
          matched.push({
            id: doc.id,
            topic: doc.topicSlug || doc.topic || null,
            kind: doc.kind || 'point',
            title: doc.title,
            q: doc.q || null,
            body: String(doc.body || '').slice(0, 400),
            tags: doc.tags || [],
            source: doc.source || null,
            verified: doc.verified ?? false,
            appliesTo: doc.appliesTo || null,
            version: doc.version || 1,
            updatedAt: doc.updatedAt || null,
            fromCurrent: !!currentSlug && doc.topicSlug === currentSlug,
            score: 0,
            coverage: 0,
            strength: 'weak',
            matched: [],
            padded: true,
          })
        }
      }

      return {
        scope: scope === 'all' ? 'all' : currentSlug || (scope === 'auto' ? 'all' : 'topic'),
        query,
        total,
        hits: matched,
        related,
        rerank: {
          used: split.used,
          reason: split.reason || '',
          // 走缓存时没有新的模型调用，用量不该再报一遍（否则界面上的 token 累计会虚高）
          usage: fromCache ? null : split.usage || null,
          cached: fromCache,
        },
        // 按方向分批时的逐方向结果（哪个方向有、哪个方向库里没有）
        directions: Array.isArray(split.byDirection) && split.byDirection.length ? split.byDirection : null,
        currentTopic: currentSlug,
        // 回显模型请求的领域（归一化后）；是否真的生效看 appliesToApplied
        appliesTo: needles.length ? needles.join(',') : null,
        // 真正按领域收窄了才非空（收窄会把主题清空时回退，这里是 null）
        appliesToApplied: domainApplied,
        note: [
          currentSlug ? '' : '当前会话没绑定主题，已按整体库检索。入库前请先用 learn_topics 指定主题。',
          domainFallbackNote,
        ].filter(Boolean).join(' '),
      }

    },
    presentCall: args => ({
      card: 'generic',
      title: '检索知识库',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'learn_save',
    description:
      '把知识卡片写进主题库。默认 mode="preview"：只出预览、不写库，用户点头后才落盘。用户点界面预览下的「确认写入 N 条」按钮即完成（你不用再跑一趟）；按钮不可用时用 mode="commit" + approved=true 再调一次同样内容。返回带 similar（疑似重复）或 related（其它主题相近/冲突）时交用户裁决。',
    parameters: toolSchema(
      {
        cards: {
          type: 'array',
          description:
            '一张或多张知识卡片。每张必须有 title 和 body（格式见 body 参数说明）；tags 2-5 个；kind 默认 point，问答类用 qa 并把问题原文放进 q；source 写 {type, ref, locator}；verified/appliesTo 写核实状态与适用范围。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '标题，≤20 字' },
              body: {
                type: 'string',
                description:
                  '正文，≤400 字。首行结论；之后每行一个要点，行首 "- "；术语 **粗体**，重点 【】；参数/命令用 `反引号`。',
              },
              tags: { type: 'array', items: { type: 'string' }, description: '2-5 个标签' },
              kind: { type: 'string', enum: ['point', 'qa'], description: 'point（知识点，默认）| qa（问答）' },
              q: { type: 'string', description: 'kind=qa 时的问题原文' },
              source: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['user', 'file', 'web', 'model'], description: '出处类型' },
                  ref: { type: 'string', description: '出处说明或文件路径' },
                  locator: { type: 'string', description: '页码等定位，如 p.16-18' },
                },
                required: ['type'],
              },
              verified: { type: 'boolean', description: '用户是否已核实；模型知识入库时给 false' },
              appliesTo: { type: 'string', description: '适用范围，如 MySQL 8.0' },
            },
            required: ['title', 'body'],
          },
        },
        topic: { type: 'string', description: '目标主题，缺省用当前绑定或默认主题' },
        mode: {
          type: 'string',
          enum: ['commit', 'preview'],
          default: 'preview',
          description: 'preview（默认）：只出预览不写 | commit：弹确认框后写入',
        },
        approved: {
          type: 'boolean',
          description:
            '确认框不可用、用户已在对话里点头时置 true，跳过确认框直接写；必须先预览过同一批内容。',
        },
        bypassDuplicate: {
          type: 'boolean',
          description: '疑似重复时用户仍要新增才置 true',
        },
      },
      ['cards'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderSave(value)),
      // 整理出来的卡片也走同一套渲染：写入计划里的 id / 版本对界面有用，
      // 正文从入参拿（计划本身不带正文）。
      presentationMeta: (args, value) => {
        const cards = Array.isArray(args?.cards) ? args.cards : []
        const plan = Array.isArray(value?.plan) ? value.plan : []
        const slug = value?.topic || ''
        const topicName = slug ? store.findTopic(slug)?.name || slug : ''
        const status = value?.status || null
        return {
          kbCardSource: 'save',
          kbCards: cards.map((card, index) => {
            const item = plan[index] || {}
            return {
              // 还没落盘的卡片不给 id：界面据此隐藏「评审 / 编辑 / 问一下」——
              // 预览里的正文是「待写入」的那一版，拿旧 id 去操作会改错东西。
              id: status === 'written' ? item.id || null : null,
              title: String(card?.title || ''),
              body: String(card?.body || ''),
              topic: slug,
              topicName,
              kind: card?.kind === 'qa' ? 'qa' : 'point',
              tags: Array.isArray(card?.tags) ? card.tags : [],
              verified: item.verified ?? false,
              version: item.version || 1,
              source: card?.source || null,
              appliesTo: card?.appliesTo || null,
              action: item.action || null,
              status,
              // 角色：这次是新增还是更新已有条目。
              // 用户反馈「卡片之间没有区分」—— 检索命中（existing）和这次要加的
              // （new / update）混在一堆，用户分不清哪些已经在库里、哪些是新的。
              role: roleOfPlanItem(item),
            }
          }),
          // 待写入批次：界面拿它渲染「确认写入 N 条」按钮。
          kbSave:
            status === 'preview' && value?.batchId
              ? { batchId: value.batchId, count: cards.length, topic: slug, topicName }
              : null,
        }
      },
    },
    execute(args, exec) {
      return runSave({ ctx, store, args, exec })
    },
    presentCall: args => ({
      card: 'generic',
      title: '写入知识库',
      kind: 'other',
      rawInput: args,
    }),
  })

  // 改 / 删条目的工具**默认不暴露给模型**（2026-10-23 用户定：「我不说要删改条目
  // 为什么要每次都发过去」）。这两个 schema 每次请求都随 tools 一起发，约 1200 字 ≈ 900 tokens。
  // 要用时：settings.json 里 kbEditTools=true，或环境变量 DSH_KB_EDIT=1。
  const editToolsEnabled = store.getKbEditTools()

  if (editToolsEnabled) {
    ctx.tools.register({
      name: 'learn_update',
      description:
        '修改库里已有的一条（按 id）：可改正文、标签、出处、适用范围、核实状态等，版本号递增。',
      parameters: toolSchema(
        {
          id: { type: 'string', description: '条目 id' },
          topic: { type: 'string', description: '所在主题，缺省全库找' },
          title: { type: 'string', description: '新标题' },
          body: { type: 'string', description: '新正文' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
          appliesTo: { type: 'string', description: '适用范围' },
          verified: { type: 'boolean', description: '标记为已核实/未核实' },
          kind: { type: 'string', enum: ['point', 'qa'], description: '条目类型' },
          q: { type: 'string', description: 'kind=qa 时的问题原文' },
          source: {
            type: 'object',
            description: '出处 {type, ref, locator}',
            properties: {
              type: {
                type: 'string',
                enum: ['user', 'file', 'web', 'model'],
                description: '出处类型',
              },
              ref: { type: 'string', description: '出处说明或文件路径' },
              locator: { type: 'string', description: '页码等定位' },
            },
            required: ['type'],
          },
        },
        ['id'],
      ),
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          text(`已更新条目 ${value.id}（${value.title}）→ v${value.version}，主题 ${value.topic}`),
      },
      execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const id = String(args?.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const topic = args?.topic ? String(args.topic).trim() : undefined
        const fields = {}
        for (const key of ['title', 'body', 'tags', 'appliesTo', 'verified', 'source', 'kind', 'q']) {
          if (args?.[key] !== undefined) fields[key] = args[key]
        }
        return store.updateEntry({ id, topic, sessionId, fields })
      },
      presentCall: args => ({
        card: 'generic',
        title: '修改知识库条目',
        kind: 'other',
        rawInput: args,
      }),
    })

    ctx.tools.register({
      name: 'learn_delete',
      description:
        '删除库里的一条（按 id）。默认归档（仍可恢复，检索不再返回）；确认要彻底删除时传 hard=true。',
      parameters: toolSchema(
        {
          id: { type: 'string', description: '条目 id' },
          topic: { type: 'string', description: '所在主题，缺省全库找' },
          hard: { type: 'boolean', description: 'true 才彻底删除，默认归档' },
        },
        ['id'],
      ),
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          text(
            value.mode === 'deleted'
              ? `已彻底删除条目 ${value.id}（${value.title}）`
              : `已归档条目 ${value.id}（${value.title}），检索不再返回，但仍可恢复`,
          ),
      },
      execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const id = String(args?.id || '').trim()
        if (!id) throw new Error('id 不能为空')
        const topic = args?.topic ? String(args.topic).trim() : undefined
        return store.deleteEntry({ id, topic, sessionId, hard: !!args?.hard })
      },
      presentCall: args => ({
        card: 'generic',
        title: '删除知识库条目',
        kind: 'other',
        rawInput: args,
      }),
    })
  }

  ctx.tools.register({
    name: 'learn_entries',
    description:
      '列出某主题已有条目（标题、标签、出处、是否核实、版本），用于审阅、查重、盘点。' +
      '**这是唯一该用枚举的场景**（用户要「有哪些 / 清单 / 常考点汇总」）；要内容就用 learn_search，不要拿它当清单倒。' +
      '查「某技术栈有哪些」用 appliesTo（比 tag 宽），查「某几个方向」用 query；不带过滤会列出整个主题。' +
      'facets=领域与标签分布，termStats=每个关键词各命中几条（0=库里真没有）。',
    parameters: toolSchema(
      {
        topic: { type: 'string', description: '主题名称，缺省用当前绑定的主题' },
        status: {
          type: 'string',
          enum: ['active', 'archived', 'all'],
          default: 'active',
          description: 'active（默认）| archived | all',
        },
        kind: { type: 'string', enum: ['point', 'qa'], description: 'point | qa' },
        tag: { type: 'string', description: '按标签精确过滤（细粒度关键词）' },
        appliesTo: {
          type: 'string',
          description: '按领域过滤（数组或逗号分隔，如 "C++"；忽略大小写空格，"C++" 也命中 "C++14/17"）。',
        },
        limit: { type: 'integer', description: '最多返回多少条' },
        query: {
          type: 'string',
          description:
            '按关键词收窄，多个方向用「、」分开，命中任一即可；termStats 给出每个方向各命中几条（0=库里真没有）。',
        },
      },
    ),
    output: {
      schema: { type: 'object' },
      // 列出来的条目也要出卡片 —— 「有哪些」这类问题模型走的就是这条工具，
      // 没有卡片投影就等于答完什么都没有（2026-10-23 用户实测报「没给我卡片啊」）。
      //
      // listEntries 故意不返回正文（51 条正文会撑爆工具输出），但卡片要显示正文：
      // 宿主和存储在同一进程，这里按 id 回读一次补上，模型看到的那份仍然只有标题。
      presentationMeta: (_args, value) => {
        let stored = []
        try {
          stored = store.readEntries(value.topic)
        } catch {
          stored = []
        }
        const byId = new Map((Array.isArray(stored) ? stored : []).map(entry => [entry.id, entry]))
        const topicName = store.findTopic(value.topic)?.name || value.topic || ''
        return {
          kbCards: (Array.isArray(value.entries) ? value.entries : []).map(entry => {
            const full = byId.get(entry.id) || {}
            return projectHitCard({
              ...entry,
              body: String(full.body || '').slice(0, 400),
              topic: value.topic,
              topicName,
            })
          }),
          // 这是「列出来的」，不是「检索命中的」—— 界面上的计数要照实说
          kbCardSource: 'entries',
        }
      },
      render: (_args, value) =>
        text(
          [
            `主题「${value.topic}」共 ${value.total} 条${value.brokenLines ? `（另有 ${value.brokenLines} 行数据损坏已跳过）` : ''}`,
            // 领域/标签目录：模型靠它选过滤值，不靠猜。
            renderFacets(value.facets),
            // 关键词过滤的结果统计：每个方向各命中几条，0 条 = 库里真没有这一项
            value.termStats?.length
              ? '关键词命中：' + value.termStats.map(item => `${item.term} ${item.count} 条`).join(' / ')
              : '',
            // 条目 id 挪到行尾，并说明它是给工具调用用的。
            // 以前 id 在行首（`- [k_xxx] 标题`），模型照抄这个格式写进回答，
            // 用户就看到一串他根本不关心的编号（2026-10-23 用户实测报「用户想要知道这些编号吗」）。
            // 改 / 删工具默认不提供时，这句提示也要跟着改 —— 不然模型会去调一个不存在的工具。
            editToolsEnabled
              ? '（每行末尾的 #id 是给你调 learn_update / learn_delete 用的，不要写进给用户的回答）'
              : '（每行末尾的 #id 不要写进给用户的回答）',
            // 一次列太多条时，明说这是目录不是答案：
            // 2026-10-23 用户实测：模型把两个主题整个列出来（251 条），
            // 回答里也跟着贴成目录，用户的屏幕上根本没法看。
            value.entries.length > 30
              ? `⚠ 这里列了 ${value.entries.length} 条 —— 这是目录，不是答案。给用户的回答只挑相关的几条讲结论 + 出处标记，别把清单贴过去。`
              : '',
            ...value.entries.map(
              e =>
                `- ${e.title}${e.status === 'archived' ? '（已归档）' : ''}${e.version > 1 ? ' v' + e.version : ''}${
                  e.verified ? ' ✓已核实' : ' ⚠未核实'
                }${e.appliesTo ? ' 适用:' + e.appliesTo : ''}${e.tags?.length ? ' {' + e.tags.join('/') + '}' : ''}${
                  e.source ? ' ' + renderSource(e.source) : ''
                }${e.id ? '  #' + e.id : ''}`,
            ),
          ].join('\n'),
        ),
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const topic = args?.topic ? String(args.topic).trim() : undefined
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : undefined
      return store.listEntries({
        topic,
        sessionId,
        limit,
        status: args?.status ? String(args.status) : undefined,
        kind: args?.kind ? String(args.kind) : undefined,
        tag: args?.tag ? String(args.tag) : undefined,
        // 数组要原样传下去（String() 会把它变成 "C++,C语言"，虽然也能解析，但没必要绕）
        appliesTo: args?.appliesTo,
        // 关键词原样传：拆词在 store 里做，检索层和清单层共用同一套规则
        query: args?.query,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '列出知识库条目',
      kind: 'other',
      rawInput: args,
    }),
  })

  /**
   * 提议补条目（2026-10-23）。
   *
   * 为什么单开一条工具，而不是让模型在回答里写一句「要不要补」：
   *   ① 那行字太不显眼（用户实测看漏），而且会被宿主的「过程组折叠」吞掉；
   *   ② 提议只是标题 + 理由，正文等用户同意再生成 —— 不能提前烧一次模型调用。
   * 所以：模型调这个工具 → 界面上出现一条醒目的提议条 → 用户点「同意，出卡片预览」
   * → 宿主按 proposalId 调模型写正文、落成待写入批次 → 预览卡片 + 「确认写入」。
   */
  ctx.tools.register({
    name: 'learn_propose',
    description:
      '提议往知识库里补条目。**要写正文**（卡片格式：首行结论 + 每行一个要点）：' +
      '正文存在提议里，用户点「同意，出卡片预览」时直接出预览卡片 —— 不用再调一次模型去生成。' +
      '**库里已经讲过的不要提议**：工具会查重，也会检查这个话题是不是已经被某条相邻条目的正文覆盖了（覆盖了会告诉你，别再提）。',
    parameters: toolSchema(
      {
        topic: { type: 'string', description: '目标主题，缺省用当前绑定的主题' },
        items: {
          type: 'array',
          description: '要补的条目，1-5 条',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '条目标题，≤20 字，命名风格与库里一致' },
              why: { type: 'string', description: '一句话理由：为什么值得单独成条' },
              body: {
                type: 'string',
                description:
                  '卡片正文（≤400 字）：首行结论；之后每行一个要点，行首 "- "；术语 **粗体**，重点 【】，参数用 `反引号`。',
              },
              appliesTo: { type: 'string', description: '适用范围/领域，如 C++、MySQL 8.0' },
              tags: { type: 'array', items: { type: 'string' }, description: '2-5 个标签' },
            },
            required: ['title', 'why'],
          },
        },
      },
      ['items'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.status === 'already') {
          return text(`这些条目库里已经有了，没有提议：${value.existing.join('、')}`)
        }
        const lines = [`【已提议】主题「${value.topicName || value.topic}」，${value.items.length} 条等用户确认：`]
        for (const item of value.items) lines.push(`- ${item.title}${item.why ? ' —— ' + item.why : ''}`)
        if (value.existing?.length) lines.push(`（库里已有、跳过：${value.existing.join('、')}）`)
        lines.push('')
        lines.push('用户在对话下方的提议条上点「同意，出卡片预览」后，正文会自动生成并出预览；你不用再调 learn_save。')
        lines.push('（提议条上可以只勾其中几条、也可以改补到哪个主题 —— 用户自己决定，不用你追问。）')
        return text(lines.join('\n'))
      },
      presentationMeta: (_args, value) =>
        value?.status === 'proposed'
          ? {
              kbProposal: {
                id: value.proposalId,
                topic: value.topic,
                topicName: value.topicName || value.topic,
                items: value.items,
                // 主题下拉的选项（2026-10-23 用户要求：「加入到哪个主题也要可以选啊」）
                topics: store
                  .listTopics()
                  .map(item => ({ slug: item.slug, name: item.name, count: item.activeCount })),
              },
            }
          : null,
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const raw = Array.isArray(args?.items) ? args.items : args?.items ? [args.items] : []
      if (!raw.length) throw new Error('items 不能为空：至少一条 {title, why}')

      const topicArg = args?.topic ? String(args.topic).trim() : ''
      const found = topicArg ? store.findTopic(topicArg) : null
      if (topicArg && !found) {
        throw new Error(`主题「${topicArg}」不存在。用 learn_topics(action="list") 看现有主题。`)
      }
      const slug = found ? found.slug : store.currentTopic(sessionId)
      if (!slug) throw new Error('当前会话没有绑定主题：先 learn_topics(action="use"|"create") 指定主题')

      const topicName = store.findTopic(slug)?.name || slug
      const existingEntries = store.readEntries(slug)
      const items = []
      const existing = []
      const covered = []
      for (const item of raw) {
        const title = String(item?.title || '').trim()
        if (!title) throw new Error('每条提议都必须有 title')
        const norm = normalizeTitle(title)
        const hit = existingEntries.find(entry => normalizeTitle(entry.title) === norm)
        if (hit) {
          existing.push(hit.title)
          continue
        }
        // 覆盖检查：这条要补的话题，是不是已经被库里某条相邻条目的正文讲到了？
        // （2026-10-23 用户实测：问「三次握手和四次挥手」，库里明明有《TCP三次握手与四次挥手》，
        //  模型却提议补「为什么挥手需要四次」「TIME_WAIT 为什么等 2MSL」——
        //  这两件事那条卡片的正文里都写了。白白多一次提议往返，还把库污染了。）
        const cover = findCoveringEntry(title, existingEntries)
        if (cover) {
          covered.push({ title, coveredBy: cover.title })
          continue
        }
        items.push({
          title,
          why: String(item?.why || '').trim(),
          // 正文随提议一起存下来：用户点「同意」时直接出预览卡片，
          // 不用再调一次模型去生成（那次调用又慢又烧 token）。
          body: String(item?.body || '').trim().slice(0, 2000),
          appliesTo: item?.appliesTo ? String(item.appliesTo).trim() : null,
          tags: Array.isArray(item?.tags) ? item.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8) : [],
        })
      }

      if (!items.length) {
        return { status: 'already', topic: slug, topicName, existing, covered, items: [] }
      }

      const proposalId = registerProposal({ topicArg: topicArg || null, slug, topicName, items, sessionId })
      return { status: 'proposed', proposalId, topic: slug, topicName, items, existing, covered }
    },
    presentCall: args => ({
      card: 'generic',
      title: '提议补知识条目',
      kind: 'other',
      rawInput: args,
    }),
  })

  // 工具白名单（S1）：学习模式只需要「读被指名的文件」这一类工具。
  // 其余全局工具（bash / 写文件 / 生图 / 定时器 / 插件管理 / 子代理 / ESR…）在本作用域不可见，
  // 素材纪律从此是机制保证，不只是提示词里的君子协定。
  ctx.on('agent/created', function () {
    // this 可能是 agent 作用域，也可能就是插件所在作用域；两个都试
    const tools = this?.ctx?.tools ?? ctx.tools
    if (!tools || typeof tools.restrict !== 'function') return
    // 只点名去掉全局工具；作用域内注册的工具不受影响，也不许进 deny
    const deny = DENY_TOOLS.filter(name => {
      if (MUST_KEEP.includes(name) || name.startsWith('ops_') || name === 'pwsh') return false
      try {
        return !!tools.get(name)
      } catch {
        return false
      }
    })
    if (!deny.length) return
    // 安全网：接管面不在就不做限制
    const missing = MUST_KEEP.filter(name => {
      try {
        return !tools.get(name)
      } catch {
        return true
      }
    })
    if (missing.length) {
      console.error('[learning-kb] 宿主接管面缺失（' + missing.join('、') + '），不做工具限制')
      return
    }
    let dispose = null
    try {
      dispose = tools.restrict({ deny })
    } catch (error) {
      console.error('[learning-kb] 工具限制失败，已放弃：' + error.message)
      return
    }
    // 限制完再确认一次接管面还在；被动过就撤销
    const broken = MUST_KEEP.filter(name => {
      try {
        return !tools.get(name)
      } catch {
        return true
      }
    })
    if (broken.length) {
      console.error('[learning-kb] 工具限制动到了宿主接管面（' + broken.join('、') + '），已撤销')
      if (typeof dispose === 'function') dispose()
    }
  })
}

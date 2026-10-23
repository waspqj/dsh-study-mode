// 学习模式知识库 · 检索层
//
// 这是**纯文字匹配**，没有语义（无 embedding、无向量库）。
// 打分：字段加权的 BM25（title 3 / tags 2 / q 2 / body 1）+ 整句命中加分。
// 分词：英文按词，中文按 bigram（不用词典，够用且零依赖）。
// 说明：小语料下纯 BM25 的 IDF 会偏低（一条文档时 idf≈0.29），
//      所以额外给「整句出现在标题/正文」的条目加分，保证精确命中排在前面。
//
// 两道精度控制（2026-10-22 用户反馈「一堆没有关联的卡片」后加的）：
//   1. QUERY_STOP 把疑问词/虚词从打分里剔除，否则「什么是X」全都互相命中；
//   2. MIN_RELATIVE 相对分门槛，避免只沾一个通用词就进榜。

const K1 = 1.2
const B = 0.75

// appliesTo 是「领域/技术栈」这一层（C++、网络、操作系统…），和 tags 权重同级。
//
// 2026-10-23 用户踩到：问「C++ 的常考点」时只拿到 tag=C++ 的 34 条，另外 17 条
// C++ 相关的（C++11 新特性、智能指针、C 语言基础、设计模式）一条都没出来。
// 根因之一就在这里 —— 条目上的 appliesTo 明明写着 "C++"，但它从没进过索引，
// 所以哪怕 query 写 "C++" 也召不回那些正文不含 "C++" 字样的条目。
const FIELD_WEIGHTS = { title: 3, tags: 2, appliesTo: 2, q: 2, body: 1 }

// 查询侧停用词：疑问句式和虚词。
//
// 为什么必须有这张表：中文按 bigram 切，「什么是LRU」会切出「什么」「么是」
// 「什么是」三个词。这些词在整个语料里到处都是，BM25 的 IDF 压低它们的权重，
// 但压不到零 —— 于是「什么是并查集」「什么是事务」都能靠共享「什么是」进榜，
// 卡片立刻变噪声。（实测：query=`什么是LRU cache`，第 2~9 名全是「什么是X」。）
// 停用词同时参与覆盖率的分母计算，否则覆盖率会被虚高（protobuf 那条显示 0.6）。
const QUERY_STOP = new Set([
  // 疑问 / 语气
  '什么', '么是', '是什', '什么是', '什么样', '么样', '怎样', '怎么', '么办',
  '如何', '为何', '为什', '为什么', '哪些', '哪个', '哪里', '是否', '能否', '可否',
  // 泛用谓词 / 客套
  '可以', '能不', '不能', '请问', '一下', '介绍', '解释', '说说', '讲讲', '聊聊',
  '帮我', '我想', '想知', '知道', '告诉',
  // 指代 / 连接
  '这个', '那个', '一个', '就是', '这样', '那样', '这些', '那些', '以及', '还有',
  // 英文
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'what', 'how', 'why', 'which', 'do', 'does', 'it', 'this',
  'that', 'with', 'can', 'you', 'me', 'please',
])

// 门槛：分数不到最佳分这个比例的一律不进榜。
// 没有门槛时只要共享任意一个词就返回，这是「一堆无关卡片」的直接原因。
// 为什么只用相对分不用覆盖率：短查询（2 个内容词）时只匹配 1 个的覆盖率也是
// 0.5，一样过线 —— 实测「缓冲池的三个链表」只有 LRU 一个词就混进来了。
//
// 两个值分工：
//   CANDIDATE_RELATIVE —— 交给大模型重排时的**召回**门槛，故意放得松，
//     让"差不多相关"的条目也能进候选池，精确判断交给模型；
//   MIN_RELATIVE —— 没有模型可用（降级）时的**精度**门槛，收紧，别退回噪声。
export const CANDIDATE_RELATIVE = 0.12
export const MIN_RELATIVE = 0.3


/** 英文/数字按词切，中文按 bigram 切。 */
export function tokenize(text) {
  // 下划线视为分隔符：buffer_pool_size → buffer / pool / size
  const lower = String(text ?? '').toLowerCase().replace(/_/g, ' ')
  const tokens = []

  for (const word of lower.match(/[a-z0-9][a-z0-9_+#.]*/g) || []) tokens.push(word)

  for (const run of lower.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    if (run.length <= 4) tokens.push(run)
  }

  return tokens
}

/**
 * 词集合：用于相似度比较（跨主题重复/冲突检测）。
 */
export function tokenSet(text) {
  return new Set(tokenize(text))
}

/**
 * Jaccard 相似度（两个词集合的交并比），取值 0~1。
 */
/**
 * 词集合 + 相邻拉丁词的连写形：read view → readview，这样 ReadView / read view /
 * read_view 三种写法能对上（去重器专用，不影响检索排序）。
 */
function tokensWithCompounds(text) {
  const tokens = tokenize(text)
  const out = new Set(tokens)
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (/^[a-z0-9]+$/.test(a) && /^[a-z0-9]+$/.test(b)) out.add(a + b)
  }
  return out
}

/** 去重器用的词集合（文本 → 集合）。 */
export function tokenSetWithCompounds(text) {
  return tokensWithCompounds(text)
}

/**
 * 条目全字段词集合：用于「标题里的词在条目里出现多少」这类覆盖度判断。
 */
export function entryTokenSet(entry) {
  const out = new Set()
  const fields = [entry?.title, (entry?.tags || []).join(' '), entry?.q || '', entry?.body || '']
  for (const field of fields) {
    for (const token of tokensWithCompounds(field)) out.add(token)
  }
  return out
}

export function jaccard(a, b) {
  const setA = a instanceof Set ? a : tokenSet(a)
  const setB = b instanceof Set ? b : tokenSet(b)
  if (!setA.size && !setB.size) return 1
  if (!setA.size || !setB.size) return 0
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection++
  return intersection / (setA.size + setB.size - intersection)
}

function fieldTokens(entry, field) {
  switch (field) {
    case 'title':
      return tokenize(entry.title)
    case 'tags':
      return tokenize((entry.tags || []).join(' '))
    case 'appliesTo':
      return tokenize(entry.appliesTo || '')
    case 'q':
      return tokenize(entry.q || '')
    case 'body':
      return tokenize(entry.body || '')
    default:
      return []
  }
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 强度分档：查询词覆盖率为主、相对名次为辅。
 * 小语料下 BM25 的 IDF 偏低，纯绝对分会误判；覆盖率与语料规模无关。
 * 语义相关性仍由模型自己判断。
 */
function strength(score, coverage, best) {
  const rel = best > 0 ? score / best : 0
  if (coverage >= 0.6 && score >= 2.5 && rel >= 0.5) return 'strong'
  if (coverage >= 0.3 || rel >= 0.5) return 'medium'
  return 'weak'
}

/**
 * 预构建检索器：把语料统计（分词、词频、df/avg）算**一次**，之后反复检索都复用。
 *
 * 2026-10-23 审计 P1-3：原来 rankDocs 每调用一次就把整个语料重新分词一遍
 * —— 4 个字段全量 tokenize + 重建 df 表。而 planSave 是「每张卡片调一次」，
 * 于是 250 张卡 × 250 条 = 全库被分词 250 遍，这是批量入库慢的主因
 * （不是写盘：写盘本来就只写一次）。
 * 建一次检索器、循环里复用，复杂度从 O(卡数 × 语料) 的分词降到 O(语料)。
 */
export function createRanker(docs) {
  const fields = Object.keys(FIELD_WEIGHTS)
  const list = Array.isArray(docs) ? docs : []
  const N = list.length

  // 每篇文档、每个字段：token 列表 + 词频表
  const perDoc = list.map(doc => {
    const byField = {}
    for (const field of fields) {
      const tokens = fieldTokens(doc, field)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
      byField[field] = { tokens, tf, length: tokens.length }
    }
    return byField
  })

  // 每个字段的语料统计：文档长度、文档频率、平均长度
  const stats = {}
  for (const field of fields) {
    const docLens = new Array(N)
    const df = new Map()
    let total = 0
    for (let i = 0; i < N; i++) {
      const { tokens } = perDoc[i][field]
      docLens[i] = tokens.length
      total += tokens.length
      for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1)
    }
    stats[field] = { docLens, df, avg: total / Math.max(1, N) }
  }

  function search(query, limit = 3, options = {}) {
    const minRelative = typeof options.minRelative === 'number' ? options.minRelative : MIN_RELATIVE
    const queryText = String(query ?? '').trim()
    const queryTokens = tokenize(queryText)
    if (!N || !queryTokens.length) return []

    const allTerms = Array.from(new Set(queryTokens))
    // 只让"内容词"参与打分。全是停用词时退回原样，免得整条查询被清空。
    const contentTerms = allTerms.filter(term => !QUERY_STOP.has(term))
    const queryTerms = contentTerms.length ? contentTerms : allTerms

    const scored = []
    for (let index = 0; index < N; index++) {
      const doc = list[index]
      let score = 0
      const matched = new Set()

      for (const field of fields) {
        const tf = perDoc[index][field].tf
        const length = stats[field].docLens[index] || 0
        const avg = stats[field].avg || 1

        let fieldScore = 0
        for (const term of queryTerms) {
          const frequency = tf.get(term) || 0
          if (!frequency) continue
          matched.add(term)
          const df = stats[field].df.get(term) || 0
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
          const norm = K1 * (1 - B + B * (length / avg))
          fieldScore += (idf * (frequency * (K1 + 1))) / (frequency + norm)
        }
        score += fieldScore * FIELD_WEIGHTS[field]
      }

      // 整句命中：小语料下把精确匹配顶到前面
      const needle = queryText.toLowerCase()
      const title = String(doc.title || '').toLowerCase()
      const body = String(doc.body || '').toLowerCase()
      if (title.includes(needle)) score += 4
      else if (body.includes(needle)) score += 2

      scored.push({ doc, score, matched: Array.from(matched) })
    }

    const sorted = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score)
    const bestScore = sorted[0]?.score ?? 0
    // 门槛只看相对分：绝对分在小语料里没有可比性，最佳分的比例才有。
    const kept = sorted.filter(item => item.score >= bestScore * minRelative)

    return kept
      .slice(0, Math.max(1, limit))
      .map(item => ({
        id: item.doc.id,
        topic: item.doc.topicSlug || item.doc.topic || null,
        kind: item.doc.kind || 'point',
        title: item.doc.title,
        q: item.doc.q || null,
        body: truncate(item.doc.body, 400),
        tags: item.doc.tags || [],
        source: item.doc.source || null,
        verified: item.doc.verified ?? false,
        appliesTo: item.doc.appliesTo || null,
        version: item.doc.version || 1,
        updatedAt: item.doc.updatedAt || null,
        score: round2(item.score),
        coverage: Math.round((item.matched.length / Math.max(1, queryTerms.length)) * 100) / 100,
        strength: strength(item.score, item.matched.length / Math.max(1, queryTerms.length), bestScore),
        matched: item.matched.slice(0, 6),
      }))
  }

  return { docs: list, size: N, search }
}

/**
 * 在候选条目中检索（一次性调用：语料统计用完即弃）。
 * 需要对同一批语料反复检索时，请用 createRanker 建检索器复用。
 * @param {object[]} docs 候选条目
 * @param {string} query 查询串
 * @param {number} limit 返回条数
 * @param {{minRelative?: number}} [options] minRelative：相对分门槛，默认 MIN_RELATIVE
 */
export function rankDocs(docs, query, limit = 3, options = {}) {
  return createRanker(docs).search(query, limit, options)
}

/** 方向分隔符：顿号 / 逗号 / 分号 / 斜杠 / 竖线 / 中点。 */
const SEGMENT_SEP = /[、，,;；/|·]+/
/** 每个方向尾部常带的套话，拆完要摘掉（「C++11 新特性的相关知识点」→「C++11 新特性」）。 */
const SEGMENT_TAIL = /\s*的?\s*(相关)?\s*(知识点|考点|内容|条目)\s*$/

/**
 * 把「一句话点名好几个方向」的查询拆成方向列表。
 *
 * 只在用户**显式用顿号/逗号分隔**时才拆 —— 普通问句（「什么是 LRU cache」）原样不拆。
 * 为什么需要它（2026-10-23 用户实测）：问「STL、智能指针、RAII、C++11 新特性的相关知识点」，
 * 模型把方向改写成更窄的词（STL → vector 迭代器）分别检索，结果智能指针 / RAII / STL 组件
 * 那几条一条都没进候选池。方向是用户点名的，就不该由模型再翻译一遍。
 *
 * @param {string} query 原始查询
 * @returns {string[]} 方向列表；不值得拆时返回空数组
 */
export function splitQuerySegments(query) {
  const text = String(query ?? '').trim()
  if (!text || !SEGMENT_SEP.test(text)) return []
  const parts = text
    .split(SEGMENT_SEP)
    .map(part => part.replace(SEGMENT_TAIL, '').trim())
    .filter(part => part.length >= 2)
  // 同一个方向写了两遍（「智能指针、智能指针」）不算多方向
  const unique = Array.from(new Set(parts))
  if (unique.length < 2 || unique.length > 6) return []
  return unique
}


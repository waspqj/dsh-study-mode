// 学习模式知识库 · 检索层
//
// 打分：字段加权的 BM25（title 3 / tags 2 / q 2 / body 1）+ 整句命中加分。
// 分词：英文按词，中文按 bigram（不用词典，够用且零依赖）。
// 说明：小语料下纯 BM25 的 IDF 会偏低（一条文档时 idf≈0.29），
//      所以额外给「整句出现在标题/正文」的条目加分，保证精确命中排在前面。

const K1 = 1.2
const B = 0.75

const FIELD_WEIGHTS = { title: 3, tags: 2, q: 2, body: 1 }

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
 * 在候选条目中检索。
 * @param {object[]} docs 候选条目
 * @param {string} query 查询串
 * @param {number} limit 返回条数
 */
export function rankDocs(docs, query, limit = 3) {
  const queryText = String(query ?? '').trim()
  const queryTokens = tokenize(queryText)
  if (!docs.length || !queryTokens.length) return []

  const fields = Object.keys(FIELD_WEIGHTS)
  const stats = {}
  for (const field of fields) {
    const docLens = []
    const df = new Map()
    for (const doc of docs) {
      const tokens = fieldTokens(doc, field)
      docLens.push(tokens.length)
      for (const term of new Set(tokens)) df.set(term, (df.get(term) || 0) + 1)
    }
    const total = docLens.reduce((sum, len) => sum + len, 0)
    stats[field] = { docLens, df, avg: total / Math.max(1, docLens.length) }
  }

  const N = docs.length
  const queryTerms = Array.from(new Set(queryTokens))

  const scored = docs.map((doc, index) => {
    let score = 0
    const matched = new Set()

    for (const field of fields) {
      const tokens = fieldTokens(doc, field)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
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

    return { doc, score, matched: Array.from(matched) }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
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
      strength: strength(item.score, item.matched.length / Math.max(1, queryTerms.length), scored[0]?.score ?? item.score),
      matched: item.matched.slice(0, 6),
    }))
}

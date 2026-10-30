// 学习知识库 · 卡片互链的纯逻辑层
//
// 这一层不碰盘、不碰网络，只回答三个问题：
//   1) 正文里的 [[某某]] 指的是谁？
//   2) 这张卡片连着谁（正向）？
//   3) 谁连着这张卡片（反向 / 被引用）？
//
// 为什么链接是「读时解析」而不是「写时定死」：
//   - 卡片可以改名。写时定死的话，改名之后链接就指错人了。
//   - 卡片可以后建。正文里先写了 [[索引隔离]]，等那张卡建好了，链接才成立。
//   所以：**正文里的 [[..]] 是活的**（改一次正文，链接跟着变），
//   **手动挂的链接另存一份**（entry.links），两者在读时合并。
//
// 解析顺序（认准一条，不猜）：
//   1. 整串就是条目 id（如 k_l3k2j_9f）→ 命中那张卡
//   2. 标题精确相同 → 命中
//      同名有多张时：先看是不是同一个主题；还是多张 → 不猜，当作没解析
//   3. 都没命中 → 悬空链接（界面上标出来，等那张卡建好就自动接上）

/** 一张卡片最多挂多少条链接（正文 + 手动合计）。防的是模型一口气写几十个 [[...]]。 */
export const LINK_MAX = 24

/** 链接目标文本的长度上限：超了就不当链接（多半是误写）。 */
export const LINK_TITLE_MAX = 80

/** 正文里的引用语法：[[目标]]。目标里不允许再出现方括号或换行。 */
const LINK_PATTERN = /\[\[([^[\]\n]{1,80})\]\]/g

/**
 * 归一化链接目标：全角空格转半角、连续空白压成一个、去掉首尾空白、英文转小写。
 * 这样「MySQL  索引」和「mysql 索引」是同一个目标。
 *
 * @param {string} text 原始文本
 * @returns {string} 归一化后的键
 */
export function normalizeLinkTitle(text) {
  return String(text ?? '')
    .replace(/[\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 从正文里抽出 [[..]] 引用。保序、去重（同一个目标只留一次）。
 *
 * @param {string} text 正文
 * @returns {{raw: string, key: string}[]}
 */
export function parseLinkRefs(text) {
  const refs = []
  const seen = new Set()
  const source = String(text ?? '')
  if (!source.includes('[[')) return refs
  const pattern = new RegExp(LINK_PATTERN.source, 'g')
  let match
  while ((match = pattern.exec(source))) {
    const raw = String(match[1] ?? '').trim()
    if (!raw || raw.length > LINK_TITLE_MAX) continue
    const key = normalizeLinkTitle(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    refs.push({ raw, key })
    if (refs.length >= LINK_MAX) break
  }
  return refs
}

/**
 * 往索引里加一条。
 *
 * 单独抽出来是因为「同一批写入的卡片要能互相引用」：
 * 写第 2 张卡时，第 1 张还没落盘，但它的 id 早就知道了 —— 把它加进索引，
 * 第 2 张卡正文里的 [[第 1 张]] 就能解析出来。
 *
 * @param {{byId: Map, byTitle: Map}} index 索引
 * @param {object} entry 条目（至少要有 id 和 title）
 */
export function indexAdd(index, entry) {
  if (!index || !entry || !entry.id) return
  index.byId.set(entry.id, entry)
  const key = normalizeLinkTitle(entry.title || '')
  if (!key) return
  const bucket = index.byTitle.get(key)
  if (bucket) bucket.push(entry)
  else index.byTitle.set(key, [entry])
}

/**
 * 给一批条目建索引：按 id、按标题各一份。
 *
 * @param {object[]} entries 条目数组
 * @returns {{byId: Map<string, object>, byTitle: Map<string, object[]>}}
 */
export function buildLinkIndex(entries) {
  const index = { byId: new Map(), byTitle: new Map() }
  for (const entry of Array.isArray(entries) ? entries : []) {
    indexAdd(index, entry)
  }
  return index
}

/**
 * 解析一个引用指向哪张卡。
 *
 * @param {string} raw 引用原文（标题或 id）
 * @param {{byId: Map, byTitle: Map}} index 索引
 * @param {{topic?: string}} [options] 同名时的偏好主题
 * @returns {object|null} 命中的条目；没命中返回 null
 */
export function resolveRef(raw, index, options = {}) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const byId = index && index.byId ? index.byId : new Map()
  const byTitle = index && index.byTitle ? index.byTitle : new Map()

  const direct = byId.get(text)
  if (direct) return direct

  const key = normalizeLinkTitle(text)
  const hits = byTitle.get(key) || []
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    const topic = options.topic
    if (topic) {
      const same = hits.filter(item => item.topic === topic)
      if (same.length === 1) return same[0]
    }
    // 重名且分不清 → 不猜。宁可显示「未解析」，也不要给一条错的知识链。
    return null
  }
  return null
}

/**
 * 从正文里解析出「正文引用」这一部分的链接。
 *
 * 关键动作：**先认旧的**。
 * 正文里写的是 [[某某]]（标题），但链接一旦成立就该记下那张卡的 id ——
 * 否则目标卡改个名，链接就断了。所以旧清单里 raw 相同的那条，
 * 直接沿用它的 id（标题按 id 现查，显示的是新名字）。
 *
 * @param {string} body 正文
 * @param {{byId: Map, byTitle: Map}} index 索引
 * @param {object[]} oldLinks 这张卡原来的链接清单
 * @param {string} [topic] 所在主题（同名时的偏好）
 * @returns {{id: string, title: string, raw: string, from: 'body'}[]}
 */
export function deriveBodyLinks(body, index, oldLinks, topic) {
  const old = Array.isArray(oldLinks) ? oldLinks : []
  const out = []
  for (const ref of parseLinkRefs(body)) {
    const previous = old.find(item => item && item.from === 'body' && item.raw === ref.raw)
    const kept = previous && previous.id && index && index.byId ? index.byId.get(previous.id) : null
    if (kept) {
      out.push({ id: kept.id, title: kept.title || ref.raw, raw: ref.raw, from: 'body' })
      continue
    }
    const target = resolveRef(ref.raw, index, { topic })
    out.push({
      id: target ? target.id : '',
      title: target ? target.title || ref.raw : ref.raw,
      raw: ref.raw,
      from: 'body',
    })
  }
  return out
}

/**
 * 一张卡片的正向链接：落库的清单 + 正文里现写的引用，读时合并。
 *
 * @param {object} entry 条目
 * @param {{byId: Map, byTitle: Map}} index 索引
 * @returns {{id: string|null, title: string, topic: string|null, topicName: string|null, resolved: boolean, from: string, raw: string}[]}
 */
export function resolveEntryLinks(entry, index) {
  const out = []
  const seen = new Set()
  if (!entry) return out

  const add = (target, fallbackTitle, from, raw) => {
    const id = target ? target.id : null
    const title = target ? target.title || fallbackTitle : fallbackTitle
    if (!id && !title) return
    const key = id ? 'id:' + id : 't:' + normalizeLinkTitle(title)
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      id,
      title,
      topic: target ? target.topic || null : null,
      topicName: target ? target.topicName || null : null,
      resolved: !!target,
      from,
      raw: raw || '',
    })
  }

  // 落库的清单：按 id 现查（改名后显示新名字，链接不指错人），找不到再按标题找
  const persisted = Array.isArray(entry.links) ? entry.links : []
  const covered = new Set()
  for (const item of persisted) {
    if (!item) continue
    const raw = String(item.raw || '').trim()
    let target = item.id && index && index.byId ? index.byId.get(item.id) || null : null
    if (!target) {
      const key = normalizeLinkTitle(item.title || '')
      const hits = key && index && index.byTitle ? index.byTitle.get(key) || [] : []
      if (hits.length === 1) target = hits[0]
    }
    if (item.from === 'body' && raw) covered.add(normalizeLinkTitle(raw))
    add(target, item.title || raw, item.from || 'manual', raw)
  }

  // 正文里现写的引用：清单里已经认领过的 raw 不再重复算
  // （清单里那条按 id 认得准；这里这条按标题可能已经认不出了）
  for (const ref of parseLinkRefs(entry.body)) {
    if (covered.has(ref.key)) continue
    const target = resolveRef(ref.raw, index, { topic: entry.topic })
    add(target, ref.raw, 'body', ref.raw)
  }

  return out
}

/**
 * 反向链接：哪些卡片引用了这张卡。
 *
 * @param {string} targetId 目标条目 id
 * @param {object[]} entries 全库条目
 * @param {{byId: Map, byTitle: Map}} index 索引
 * @returns {object[]} 引用它的条目
 */
export function backlinksOf(targetId, entries, index) {
  const out = []
  if (!targetId) return out
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.id === targetId) continue
    const links = resolveEntryLinks(entry, index)
    if (links.some(link => link.id === targetId)) out.push(entry)
  }
  return out
}

/**
 * 链接的展示形状：给界面 / 模型用的一行一条。
 *
 * @param {object} entry 条目
 * @param {object} index 索引
 * @returns {{id: string|null, title: string, topic: string|null, topicName: string|null, resolved: boolean, from: string}[]}
 */
export function linkRows(entry, index) {
  return resolveEntryLinks(entry, index).map(link => ({
    id: link.id,
    title: link.title,
    topic: link.topic,
    topicName: link.topicName,
    resolved: link.resolved,
    from: link.from,
  }))
}

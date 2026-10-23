// 学习模式知识库 · 存储层（v2）
//
// 磁盘布局（root 默认 ~/.dsh/learn）：
//   topics/<slug>/topic.json   主题元数据：显示名、描述、关键词、别名、时间
//   topics/<slug>/kb.jsonl     知识点，一行一条 JSON
//   bindings.json              会话 → 当前主题 的绑定
//
// v2 相对 v1 的变化：
//   1. source 结构化：{type: user|file|web|model|unknown, ref, locator}，兼容旧的字符串写法
//   2. 新增 verified（用户是否核实过）与 appliesTo（适用版本/环境）
//   3. 新增 status（active|archived），归档条目不参与检索
//   4. 写入前做 dryRun 计划，支持预览后再落盘
//   5. 跨主题相似/冲突检测
//   6. 按 mtime+size 做读取缓存，写入后失效
//   7. 写入前校验文件是否被其它会话改过（并发保护）
//
// 设计取舍：
//   - 「整体库」不单独存一份，而是扫描全部主题库得到，因此永远不会与主题库不一致。
//   - JSONL：可 grep、可 diff、可手改、可备份，几千条以内性能足够。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { rankDocs, jaccard, tokenSet, tokenize, entryTokenSet, tokenSetWithCompounds, createRanker } from './rank.js'
import { formatVersion } from './format.js'

/** 把主题显示名转成目录用的 slug。中文保留，只清理空白与标点。 */
export function slugify(name) {
  const s = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'topic'
}

/** 标题归一化，用于判重：忽略大小写、空白与常见标点。 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 从字符串来源猜类型，用于兼容 v1 的裸字符串 source。 */
function guessSourceType(ref) {
  if (/^https?:\/\//i.test(ref)) return 'web'
  if (/用户|口述|对话|亲述/i.test(ref)) return 'user'
  if (/[\\/]|\.(pdf|png|jpe?g|txt|sql|md|cnf)$/i.test(ref)) return 'file'
  return 'unknown'
}

/** 来源统一成 {type, ref, locator}。 */
export function normalizeSource(source) {
  if (source == null) return null
  if (typeof source === 'string') {
    const ref = source.trim()
    if (!ref) return null
    return { type: guessSourceType(ref), ref, locator: null }
  }
  if (typeof source !== 'object') return null
  const ref = source.ref == null ? null : String(source.ref)
  if (!ref) return null
  return {
    type: String(source.type || 'unknown'),
    ref,
    locator: source.locator == null ? null : String(source.locator),
  }
}

/**
 * 待处理状态（预览指纹 / 待写入批次 / 待确认提议）的**落盘位置**。
 *
 * 为什么必须落盘（2026-10-23 用户实测：「同意，出卡片预览」这个按钮一直失败）：
 * 这三张表原来是进程内内存。只要宿主把两个半侧当成两个模块实例加载（或者用户
 * 在「模型提议」和「点同意」之间重启了 DSH），工具半侧登记的提议，UI 半侧就查不到，
 * 按钮永远报「这条提议已经过期」。写进 <root>/.pending.json 之后，谁读谁写都是同一份，
 * 重启后也还在（TTL 仍然生效）。
 */
function pendingFile() {
  const override = process.env.DSH_LEARN_ROOT
  const root =
    override && override.trim()
      ? path.resolve(override.trim())
      : path.join(
          process.env.DSH_HOME && process.env.DSH_HOME.trim()
            ? process.env.DSH_HOME.trim()
            : path.join(os.homedir(), '.dsh'),
          'learn',
        )
  return path.join(root, '.pending.json')
}

/** 读整份待处理状态；坏文件当空处理（绝不能因为一个 JSON 坏了把检索带崩）。 */
function readPending() {
  try {
    const raw = fs.readFileSync(pendingFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写整份待处理状态；失败静默（磁盘满/权限问题不该让工具调用报错）。 */
function writePending(state) {
  try {
    const file = pendingFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state))
  } catch {
    /* 忽略 */
  }
}

/**
 * 「先预览再写入」的进程级状态。
 *
 * 为什么必须放在模块级、而不是 store 实例里：
 * 工具半侧（plugin/tools.js 的 apply）和 UI 半侧（plugin/index.js 的 store()）
 * 各自 createStore 一次，是两个互不相干的实例。指纹记在实例里的话，
 * 「预览」发生在工具侧、「确认写入」发生在 UI 侧 —— 闸门会误判成「没预览过」，
 * 界面上那个「确认写入 N 条」按钮就永远写不进去。
 * 批次登记表同理：预览时登记 batchId，UI 侧按 batchId 取回内容落盘。
 */

/** 预览指纹的存活时间：10 分钟。 */
const PREVIEW_TTL_MS = 10 * 60 * 1000
/** 待写入批次的存活时间：30 分钟。 */
const SAVE_BATCH_TTL_MS = 30 * 60 * 1000
/** 提议的存活时间：30 分钟。 */
const PROPOSAL_TTL_MS = 30 * 60 * 1000
/** 最近预览过的写入内容（指纹 → 时间），用于强制「先预览再写入」。 */
const previews = new Map()

/**
 * 登记一批「预览过、等你点头」的内容。
 * @param {object} batch { topicArg, slug, cards, sessionId }
 * @returns {string} batchId（一次性，写完即作废）
 */
export function registerSaveBatch(batch) {
  const nowMs = Date.now()
  const state = readPending()
  const batches = state.batches && typeof state.batches === 'object' ? state.batches : {}
  for (const [id, item] of Object.entries(batches)) {
    if (!item || nowMs - Number(item.at || 0) > SAVE_BATCH_TTL_MS) delete batches[id]
  }
  const batchId = 'b_' + nowMs.toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  batches[batchId] = { ...batch, at: nowMs }
  state.batches = batches
  writePending(state)
  return batchId
}

/** 取一批待写入内容；不存在或已过期返回 null。 */
export function getSaveBatch(batchId) {
  const id = String(batchId || '').trim()
  if (!id) return null
  const state = readPending()
  const batches = state.batches && typeof state.batches === 'object' ? state.batches : {}
  const batch = batches[id]
  if (!batch) return null
  if (Date.now() - Number(batch.at || 0) > SAVE_BATCH_TTL_MS) {
    delete batches[id]
    state.batches = batches
    writePending(state)
    return null
  }
  return batch
}

/** 写完（或作废）就把这批删掉：batchId 是一次性的。 */
export function dropSaveBatch(batchId) {
  const id = String(batchId || '').trim()
  if (!id) return
  const state = readPending()
  const batches = state.batches && typeof state.batches === 'object' ? state.batches : {}
  if (batches[id]) {
    delete batches[id]
    state.batches = batches
    writePending(state)
  }
}

/**
 * 只把一批里的一部分写成一批新的（其余留在原批次里等用户逐条确认）。
 *
 * 2026-10-24 用户要求：「审批只能批量，展开知识卡片后要可以单独审批」。
 * batchId 保持不变，只是把已确认的那几条从里面摘出去 —— 界面按同一个 batchId
 * 再渲染剩下的条目，用户接着一条条确认。
 *
 * @param {string} batchId 批次 id
 * @param {object[]} remaining 剩下的条目（原批次里还没确认的）
 * @returns {boolean} 是否更新成功（批次已过期 / 不存在返回 false）
 */
export function trimSaveBatch(batchId, remaining) {
  const id = String(batchId || '').trim()
  if (!id) return false
  const state = readPending()
  const batches = state.batches && typeof state.batches === 'object' ? state.batches : {}
  const batch = batches[id]
  if (!batch) return false
  if (!Array.isArray(remaining) || !remaining.length) {
    delete batches[id]
  } else {
    batches[id] = { ...batch, cards: remaining }
  }
  state.batches = batches
  writePending(state)
  return true
}

/**
 * 「提议补条目」的登记表（2026-10-23）。
 *
 * 为什么单独一张表：提议时**只有标题和理由**，正文要等用户点了「同意」才生成 ——
 * 生成正文是一次真实的模型调用，不能提前烧。所以提议先登记，用户同意后按
 * proposalId 取回标题，再写正文、落成待写入批次。
 *
 * 登记在 .pending.json 里（不是进程内存）：工具半侧登记、UI 半侧按 id 取回，
 * 两个半侧可能是两个模块实例 —— 2026-10-23 用户实测「同意，出卡片预览」一直失败，
 * 就是这个原因。
 */
/** 登记一条提议，返回 proposalId。 */
export function registerProposal(proposal) {
  const nowMs = Date.now()
  const state = readPending()
  const items = state.proposals && typeof state.proposals === 'object' ? state.proposals : {}
  for (const [id, item] of Object.entries(items)) {
    if (!item || nowMs - Number(item.at || 0) > PROPOSAL_TTL_MS) delete items[id]
  }
  const proposalId = 'p_' + nowMs.toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  items[proposalId] = { ...proposal, at: nowMs }
  state.proposals = items
  writePending(state)
  return proposalId
}

/** 取一条提议；不存在或已过期返回 null。 */
export function getProposal(proposalId) {
  const id = String(proposalId || '').trim()
  if (!id) return null
  const state = readPending()
  const items = state.proposals && typeof state.proposals === 'object' ? state.proposals : {}
  const proposal = items[id]
  if (!proposal) return null
  if (Date.now() - Number(proposal.at || 0) > PROPOSAL_TTL_MS) {
    delete items[id]
    state.proposals = items
    writePending(state)
    return null
  }
  return proposal
}

/** 作废一条提议（同意或放弃之后都该删掉）。 */
export function dropProposal(proposalId) {
  const id = String(proposalId || '').trim()
  if (!id) return
  const state = readPending()
  const items = state.proposals && typeof state.proposals === 'object' ? state.proposals : {}
  if (items[id]) {
    delete items[id]
    state.proposals = items
    writePending(state)
  }
}

export function createStore(root) {
  const topicsDir = path.join(root, 'topics')
  const bindingsFile = path.join(root, 'bindings.json')
  const settingsFile = path.join(root, 'settings.json')
  const backupsDir = path.join(root, 'backups')
  const cache = new Map()
  /** 每个主题保留几份日备份（审计 P0-2） */
  const BACKUP_KEEP = 7

  const now = () => new Date().toISOString()

  /**
   * 版本号 = 写入时刻的时间戳（epoch 毫秒）。
   *
   * 2026-10-23 用户定的规则：不再用自增整数。跨端同步时能直接比新旧，
   * 回退到原版时版本号也跟着回到原版那一刻（见 rollbackCard）。
   */
  const stampVersion = () => Date.now()

  /**
   * 新版本号：时间戳，但要保证**比当前那版大**。
   *
   * 同一毫秒里连写两次，纯时间戳会撞号 —— 撞号意味着乐观锁失效
   * （expectedVersion 比对不出来「已经改过了」）。所以同毫秒时 +1 兜底。
   */
  const nextVersion = (current) => {
    const stamp = Date.now()
    const prev = Number(current)
    if (Number.isFinite(prev) && prev >= stamp) return prev + 1
    return stamp
  }

  /** 老数据的版本号是小整数；这种一律按「非时间戳」处理。 */
  const isStampVersion = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1e12
  }

  /** ISO 时间 → epoch 毫秒；解析不了就返回 null。 */
  const isoToMs = (value) => {
    if (!value) return null
    const ms = Date.parse(String(value))
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }

  function ensureRoot() {
    fs.mkdirSync(topicsDir, { recursive: true })
  }

  const topicDir = (slug) => path.join(topicsDir, slug)
  const topicFile = (slug) => path.join(topicDir(slug), 'kb.jsonl')
  const metaFile = (slug) => path.join(topicDir(slug), 'topic.json')

  function statFile(file) {
    try {
      return fs.statSync(file)
    } catch {
      return null
    }
  }

  function readMeta(slug) {
    try {
      return JSON.parse(fs.readFileSync(metaFile(slug), 'utf8'))
    } catch {
      return {}
    }
  }

  function writeMeta(slug, meta) {
    atomicWriteFile(metaFile(slug), JSON.stringify(meta, null, 2))
  }

  function parseEntries(file) {
    const out = []
    let broken = 0
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        const entry = JSON.parse(text)
        if (entry && typeof entry === 'object') out.push(entry)
      } catch {
        broken++
      }
    }
    out.broken = broken
    return out
  }

  /** 读取主题条目；按 mtime+size 缓存，坏行跳过并计数。 */
  function readEntries(slug) {
    const file = topicFile(slug)
    const stat = statFile(file)
    if (!stat) {
      const empty = []
      empty.broken = 0
      return empty
    }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entries
    const entries = parseEntries(file)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries })
    return entries
  }

  /**
   * 原子写：写 .tmp → fsync 让内容真的落盘 → rename 覆盖。
   *
   * 2026-10-23 审计 P0-1：原来直接 writeFileSync 覆盖目标文件，进程在写到
   * 一半时被杀掉 / 断电，留下的就是半截 JSONL —— 读回来全是坏行，整个主题
   * 相当于报废。rename 在同一文件系统内是原子的，所以任何时刻目标文件要么
   * 是完整旧版、要么是完整新版，不会出现中间态。
   */
  function atomicWriteFile(target, content) {
    const dir = path.dirname(target)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = target + '.tmp'
    let fd = null
    try {
      fd = fs.openSync(tmp, 'w')
      fs.writeFileSync(fd, content, 'utf8')
      // 不 fsync 的话，数据可能还在内核页缓存里，崩溃后照样丢
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tmp, target)
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd) } catch { /* 已经坏了，关不上就算了 */ }
      }
      // 半截 .tmp 没用了，留着只会让人以为那是知识库
      try { fs.unlinkSync(tmp) } catch { /* 还没有这个文件 */ }
      throw error
    }
    // 目录项本身也落盘，否则崩溃后可能「文件写好了但目录里看不见」
    try {
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } catch {
      // Windows 上打不开目录句柄，这一步跳过，不影响 rename 的原子性
    }
  }

  /** 本地日期键（YYYY-MM-DD）；备份按「用户所在的那一天」算，不按 UTC。 */
  function dayKey(ms) {
    const d = new Date(ms)
    return (
      d.getFullYear() +
      '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0')
    )
  }

  /**
   * 备份轮转：每个主题留最近 7 份日快照，多了把最老的删掉。
   * 只认 `kb-YYYY-MM-DD.jsonl` 这个命名，手工挪进来的文件不受影响。
   */
  function rotateBackups(slug) {
    const dir = path.join(backupsDir, slug)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    const snaps = names.filter(name => /^kb-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
    const excess = snaps.slice(0, Math.max(0, snaps.length - BACKUP_KEEP))
    for (const name of excess) {
      try { fs.unlinkSync(path.join(dir, name)) } catch { /* 删不掉就算了 */ }
    }
  }

  /**
   * 跨天备份：当天第一次改这个主题之前，把盘上那份（还是昨天写的）内容留一份快照。
   *
   * 2026-10-23 审计 P0-2：原来备份全靠手工，改一次库手动 cp 一次，
   * 结果 topics/ 下堆了 6 个 .bak-*（626KB，占 learn 目录 74%），而且
   * 没个章法 —— 该留哪份、留几份全凭记忆。现在：
   *   - 每天每主题自动留一份 `backups/<slug>/kb-YYYY-MM-DD.jsonl`
   *   - 只保留最近 7 份，更老的自动清掉
   *   - 同一天里反复写不重复备份（内容本来就是今天的，没有跨天价值）
   * 原子写（P0-1）保证「写坏」不会发生；这个保证「写完之后后悔了还能退回去」。
   */
  function backupBeforeWrite(slug) {
    const target = topicFile(slug)
    const stat = statFile(target)
    if (stat) {
      const today = dayKey(Date.now())
      const dir = path.join(backupsDir, slug)
      const snapshot = path.join(dir, `kb-${today}.jsonl`)
      // 今天已经留过档 → 不用再做；盘上这份就是今天写的 → 备它没意义
      if (!fs.existsSync(snapshot) && dayKey(stat.mtimeMs) !== today) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(target, snapshot)
      }
    }
    // 每次写都轮转：备份目录的上限不能只靠「刚好建了快照」那一次来维持
    rotateBackups(slug)
  }

  function writeEntries(slug, entries) {
    const body = entries.map(entry => JSON.stringify(entry)).join('\n')
    backupBeforeWrite(slug)
    atomicWriteFile(topicFile(slug), body ? body + '\n' : '')
    cache.delete(topicFile(slug))
  }

  /** 并发保护：读到的内容若已被别的会话改过，拒绝覆盖。 */
  function assertUnchanged(slug, observed) {
    const stat = statFile(topicFile(slug))
    if (!observed && !stat) return
    if (!observed || !stat) {
      throw new Error(`主题「${slug}」在你读取之后被其他会话改过，请重新读取后再写入`)
    }
    if (stat.mtimeMs !== observed.mtimeMs || stat.size !== observed.size) {
      throw new Error(`主题「${slug}」在你读取之后被其他会话改过，请重新读取后再写入`)
    }
  }

  /**
   * 主题知识库文件的最后修改时刻（epoch 毫秒）；文件不存在返回 0。
   *
   * 拿来当缓存失效依据：知识库一动，这个时刻就变，基于它的缓存自动作废。
   */
  function topicStamp(slug) {
    const stat = statFile(topicFile(slug))
    return stat ? Math.round(stat.mtimeMs) : 0
  }

  /** 一批条目按领域计数（降序）：主题列表里的「这个主题有什么」用它。 */
  function domainCounts(entries, topicDomain = '') {
    const counts = new Map()
    for (const entry of entries || []) {
      // 条目没标领域时用主题的 domain 兜底（主题本身就是一个领域）
      const domain = String(entry.appliesTo || topicDomain || '').trim()
      if (!domain) continue
      counts.set(domain, (counts.get(domain) || 0) + 1)
    }
    return Array.from(counts, ([value, count]) => ({ value, count })).sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value),
    )
  }

  /** 一批条目按标签计数（降序）：领域没标的主题靠它让模型认出来。 */
  function tagCounts(entries) {
    const counts = new Map()
    for (const entry of entries || []) {
      for (const tag of entry.tags || []) {
        const key = String(tag).trim()
        if (!key) continue
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    return Array.from(counts, ([value, count]) => ({ value, count })).sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value),
    )
  }

  /** 主题级领域：条目没标 appliesTo 时用它兜底（主题本身就是一个领域）。 */
  function topicDomain(slug) {
    if (!slug) return ''
    return String(readMeta(slug).domain || '').trim()
  }

  function listTopics() {
    ensureRoot()
    const out = []
    for (const item of fs.readdirSync(topicsDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const slug = item.name
      const meta = readMeta(slug)
      const entries = readEntries(slug)
      const active = entries.filter(entry => (entry.status || 'active') === 'active')
      out.push({
        slug,
        name: meta.name || slug,
        description: meta.description || '',
        // 主题级领域（2026-10-23 用户定）：条目没标 appliesTo 时用它兜底 ——
        // 「mysql-进阶 主题里的知识点，领域就是 MySQL」。
        domain: meta.domain || '',
        keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
        aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
        count: entries.length,
        activeCount: active.length,
        // 这个主题里都有哪些领域（各多少条）。
        //
        // 为什么加：2026-10-23 用户问「STL、智能指针、RAII、C++11 的相关知识点」，
        // 而会话绑的是 mysql-进阶 —— 模型**不知道 C++ 的条目在哪个主题**，
        // 只能把每个主题都列一遍（实测 128 + 123 = 251 张卡片刷屏）。
        // 有了这份分布，一次 learn_topics 就能定位到「面试」主题的 C++ 37 条，
        // 然后只枚举那一个主题 + 那一个领域，不用整库倒。
        domains: domainCounts(active, meta.domain || '').slice(0, 8),
        // 领域没标的主题（比如 mysql-进阶）靠标签让模型认出来
        tags: tagCounts(active).slice(0, 6),
        createdAt: meta.createdAt || null,
        updatedAt: meta.updatedAt || null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  /** 主题模糊查找：按 slug / 名称 / 别名 / 关键词 / 描述匹配。 */
  function findTopic(query) {
    const needle = String(query ?? '').trim().toLowerCase()
    if (!needle) return null
    const wanted = slugify(needle)
    const topics = listTopics()
    const exact = topics.find(t => t.slug === wanted || slugify(t.name) === wanted)
    if (exact) return exact
    const scored = topics
      .map(topic => {
        const haystacks = [topic.name, topic.slug, topic.description, ...(topic.keywords || []), ...(topic.aliases || [])]
        let score = 0
        for (const hay of haystacks) {
          const value = String(hay || '').toLowerCase()
          if (!value) continue
          if (value === needle) score += 10
          else if (value.includes(needle)) score += 5
          else if (needle.includes(value) && value.length >= 2) score += 3
          else score += jaccard(tokenSet(needle), tokenSet(value))
        }
        return { topic, score }
      })
      .filter(item => item.score >= 2)
      .sort((a, b) => b.score - a.score)
    return scored.length ? scored[0].topic : null
  }

  /** 新建/更新主题元数据；同名则补别名，不丢已有条目。 */
  function createTopic(name, meta = {}) {
    const display = String(name ?? '').trim()
    if (!display) throw new Error('主题名称不能为空')
    ensureRoot()
    const slug = slugify(display)
    const existing = readMeta(slug)
    const description = meta.description ? String(meta.description).trim() : existing.description || ''
    const keywords = Array.isArray(meta.keywords)
      ? meta.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 12)
      : existing.keywords || []
    // 主题级领域：不填就沿用已有的；传空字符串表示清除
    const domain =
      meta.domain === undefined ? existing.domain || '' : String(meta.domain || '').trim()

    if (existing.name) {
      if (existing.name !== display) {
        existing.aliases = Array.from(new Set([...(existing.aliases || []), existing.name]))
        existing.name = display
      }
      if (description) existing.description = description
      if (keywords.length) existing.keywords = keywords
      if (domain) existing.domain = domain
      else delete existing.domain
      existing.updatedAt = now()
      writeMeta(slug, existing)
    } else {
      writeMeta(slug, {
        name: display,
        slug,
        description,
        keywords,
        ...(domain ? { domain } : {}),
        aliases: [],
        createdAt: now(),
        updatedAt: now(),
      })
      if (!fs.existsSync(topicFile(slug))) writeEntries(slug, [])
    }
    return slug
  }

  function readBindings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeBindings(bindings) {
    ensureRoot()
    fs.writeFileSync(bindingsFile, JSON.stringify(bindings, null, 2), 'utf8')
  }

  function bindTopic(sessionId, slug) {
    if (!sessionId) throw new Error('缺少会话标识，无法绑定主题')
    const bindings = readBindings()
    bindings[sessionId] = { topic: slug, updatedAt: now() }
    writeBindings(bindings)
    return slug
  }

  function currentTopic(sessionId) {
    if (sessionId) {
      const binding = readBindings()[sessionId]
      if (binding && binding.topic) return binding.topic
    }
    // 没绑定的会话落到默认主题，避免每次都问「放哪个主题」
    return readSettings().defaultTopic || null
  }

  function readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeSettings(settings) {
    // 设置文件和知识库一样不能写一半：走原子写（审计 P0-1 同一套）
    atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2))
  }

  /**
   * 要不要给模型提供「改 / 删条目」的工具（learn_update / learn_delete）。
   *
   * 默认**不提供**（2026-10-23 用户定）：工具的 schema 每次请求都随 tools 一起发，
   * 改/删两个工具加起来约 1200 字 ≈ 900 tokens；而用户明确说「我不说要删改条目」。
   * 想临时开：改 settings.json 的 kbEditTools=true，或用环境变量 DSH_KB_EDIT=1。
   *
   * @returns {boolean}
   */
  function getKbEditTools() {
    if (String(process.env.DSH_KB_EDIT || '').trim() === '1') return true
    return readSettings().kbEditTools === true
  }

  /** 设置/清除默认主题（新会话未绑定时用它） */
  function setDefaultTopic(name) {
    const settings = readSettings()
    if (name === null || name === undefined || String(name).trim() === '') {
      delete settings.defaultTopic
      writeSettings(settings)
      return null
    }
    const slug = createTopic(String(name).trim())
    settings.defaultTopic = slug
    writeSettings(settings)
    return slug
  }

  function getDefaultTopic() {
    return readSettings().defaultTopic || null
  }

  /**
   * 插件自己的 AI 调用用哪个模型（校验 / 追问 / 检索重排）。
   *
   * 默认 `{ mode: 'session' }` = 跟当前会话选的模型走（2026-10-22 用户定的规则）。
   * 设成 `{ mode: 'fixed', provider, model, reasoningEffort }` 就固定用它 ——
   * 这样为了「让校验快一点」而切模型时，不必把整个会话的模型也一起换掉。
   *
   * @returns {{mode: 'session'|'fixed', provider: string|null, model: string|null, reasoningEffort: string|null}}
   */
  function getAiModel() {
    const raw = readSettings().aiModel
    const mode = raw && raw.mode === 'fixed' ? 'fixed' : 'session'
    if (mode !== 'fixed') return { mode: 'session', provider: null, model: null, reasoningEffort: null }
    return {
      mode: 'fixed',
      provider: raw.provider ? String(raw.provider) : null,
      model: raw.model ? String(raw.model) : null,
      reasoningEffort: raw.reasoningEffort ? String(raw.reasoningEffort) : null,
    }
  }

  /**
   * 保存插件 AI 模型设置。传 `{ mode: 'session' }` 或 null 表示恢复跟随会话。
   * @param {{mode?: string, provider?: string, model?: string, reasoningEffort?: string}|null} next
   * @returns {object} 实际保存下来的设置（同 getAiModel 的形状）
   */
  function setAiModel(next) {
    const settings = readSettings()
    if (!next || next.mode !== 'fixed') {
      delete settings.aiModel
      writeSettings(settings)
      return getAiModel()
    }
    const provider = String(next.provider || '').trim()
    const model = String(next.model || '').trim()
    if (!provider || !model) throw new Error('固定模型必须同时给出 provider 和 model')
    settings.aiModel = {
      mode: 'fixed',
      provider,
      model,
      reasoningEffort: next.reasoningEffort ? String(next.reasoningEffort).trim() : null,
    }
    writeSettings(settings)
    return getAiModel()
  }

  /** 预览内容的指纹：内容改过就要重新预览 */
  function previewKey(slug, cards) {
    const normalized = (cards || [])
      .map(card => ({
        title: String(card?.title ?? '').trim(),
        body: String(card?.body ?? '').trim(),
        kind: card?.kind === 'qa' ? 'qa' : 'point',
        q: card?.q ? String(card.q).trim() : null,
        tags: Array.isArray(card?.tags) ? card.tags.map(t => String(t).trim()).filter(Boolean) : [],
        appliesTo: card?.appliesTo ? String(card.appliesTo).trim() : null,
        source: normalizeSource(card?.source),
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
    return slug + '|' + JSON.stringify(normalized)
  }

  function markPreviewed(slug, cards) {
    const key = previewKey(slug, cards)
    const nowMs = Date.now()
    for (const [existing, at] of previews) {
      if (nowMs - at > PREVIEW_TTL_MS) previews.delete(existing)
    }
    previews.set(key, nowMs)
    return key
  }

  function hasPreviewed(slug, cards) {
    const key = previewKey(slug, cards)
    const at = previews.get(key)
    if (at === undefined) return false
    if (Date.now() - at > PREVIEW_TTL_MS) {
      previews.delete(key)
      return false
    }
    return true
  }

  /** 跨主题找相似条目：标题相似但正文差异大 → 可能是冲突（版本差异等）。 */
  /** 其它主题里全部有效条目（跨主题重复/冲突检测的语料）。 */
  function collectOtherEntries(slug) {
    const others = []
    for (const topic of listTopics()) {
      if (topic.slug === slug) continue
      for (const entry of readEntries(topic.slug)) {
        if ((entry.status || 'active') !== 'active') continue
        others.push({ ...entry, topicSlug: topic.slug })
      }
    }
    return others
  }

  function findRelated(slug, cards, others = collectOtherEntries(slug), ranker = null) {
    if (!others.length) return []
    // 语料统计只建一次（审计 P1-3）：原来每张卡片都让 rankDocs 把全量重新分词
    const search = ranker ? (query, limit) => ranker.search(query, limit) : (query, limit) => rankDocs(others, query, limit)

    const related = []
    for (const card of cards) {
      const title = String(card?.title ?? '').trim()
      if (!title) continue
      const query = `${title} ${String(card?.body ?? '').slice(0, 120)}`
      const hits = search(query, 3)
      for (const hit of hits) {
        if (hit.score < 2) continue
        const titleSim = jaccard(tokenSet(title), tokenSet(hit.title))
        const bodySim = jaccard(tokenSet(card?.body ?? ''), tokenSet(hit.body ?? ''))
        const conflict = titleSim >= 0.6 && bodySim < 0.5
        related.push({
          topic: hit.topic,
          id: hit.id,
          title: hit.title,
          score: hit.score,
          titleSim: Math.round(titleSim * 100) / 100,
          bodySim: Math.round(bodySim * 100) / 100,
          conflict,
          note: conflict
            ? '标题几乎相同但正文差异较大，可能是不同版本/场景的结论，请让用户裁决'
            : '其它主题已有相近条目',
        })
      }
    }
    // 同一卡片只保留最像的 3 条
    return related.slice(0, 3 * Math.max(1, cards.length))
  }

  /**
   * 生成写入计划；dryRun=true 时只算不写。
   * 同主题内标题归一化后相同即视为同一条：更新原条目并升版本，不追加重复行。
   */
  /**
   * 同主题内的近似重复检测：标题不同、但讲的是同一件事。
   *
   * 判定：标题词在候选条目里的覆盖率 ≥ 0.45 且 BM25 分数过线 → 判「疑似重复」。
   * 同标题的走「更新升版本」，不算重复。
   */
  function findSimilarInTopic(slug, cards, pool = null, ranker = null) {
    const entries = pool || readEntries(slug).filter(entry => (entry.status || 'active') === 'active')
    if (!entries.length) return []
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const N = entries.length
    // 条目全字段词集合缓存：同一批卡片反复命中同一条目时不用重新分词
    const tokenCache = new Map()
    const tokensOf = entry => {
      let set = tokenCache.get(entry.id)
      if (!set) {
        set = entryTokenSet(entry)
        tokenCache.set(entry.id, set)
      }
      return set
    }
    const search = ranker ? (query, limit) => ranker.search(query, limit) : (query, limit) => rankDocs(entries, query, limit)

    // 语料词频 → idf：通用词（间隙锁/页）在多条里都出现，权重低；
    // 专有词（innodb_page_size/16KB）只在一两条里出现，权重大。
    const df = new Map()
    for (const entry of entries) {
      for (const term of entryTokenSet(entry)) df.set(term, (df.get(term) || 0) + 1)
    }
    // 把查询本身算作一篇伪文档，未出现的词按 df=0.5 平滑。
    // 不做平滑的话，小语料（N=1）里「库外词」的权重是「库内词」的 4.8 倍，会把真重复判没。
    const N1 = N + 1
    const idf = term => {
      const d = df.get(term) ?? 0.5
      return Math.log(1 + (N1 - d + 0.5) / (d + 0.5))
    }
    /** 查询词被条目覆盖的 idf 加权比例：分母是查询自身的总权重。 */
    const weightedCoverage = (queryTerms, entryTokens) => {
      let total = 0
      let shared = 0
      for (const term of queryTerms) {
        const w = idf(term)
        total += w
        if (entryTokens.has(term)) shared += w
      }
      return total ? shared / total : 0
    }

    const out = []
    for (const card of cards) {
      const title = String(card?.title ?? '').trim()
      if (!title) continue
      const norm = normalizeTitle(title)
      const titleTerms = Array.from(tokenSetWithCompounds(title))
      if (!titleTerms.length) continue
      const body = String(card?.body ?? '')
      const bodyTerms = Array.from(tokenSetWithCompounds(body))
      const hits = search(`${title} ${body.slice(0, 160)}`, 5)
      for (const hit of hits) {
        if (hit.score < 2.5) continue
        const entry = byId.get(hit.id)
        if (!entry) continue
        if (normalizeTitle(entry.title) === norm) continue
        const entryTokens = tokensOf(entry)
        // 标题与正文两路都要够像，才算「疑似重复」；只有一路像 = 相关但不同的事
        const titleScore = weightedCoverage(titleTerms, entryTokens)
        const bodyScore = weightedCoverage(bodyTerms, entryTokens)
        if (titleScore < 0.45 || bodyScore < 0.5) continue
        out.push({
          id: entry.id,
          title: entry.title,
          topic: slug,
          score: hit.score,
          titleScore: Math.round(titleScore * 100) / 100,
          bodyScore: Math.round(bodyScore * 100) / 100,
          source: entry.source || null,
          note: '同一主题里已有一条讲相近内容的卡片，但标题不同，没走更新升版本',
        })
        break
      }
    }
    return out
  }

  /**
   * 同主题里最相关的几条（给人和模型做参照；抓不到转述型重复，但能提供上下文）。
   */
  function findNearbyInTopic(slug, cards, pool = null, ranker = null) {
    const entries = pool || readEntries(slug).filter(entry => (entry.status || 'active') === 'active')
    if (!entries.length) return []
    const search = ranker ? (query, limit) => ranker.search(query, limit) : (query, limit) => rankDocs(entries, query, limit)
    const out = []
    const seen = new Set()
    for (const card of cards) {
      const title = String(card?.title ?? '').trim()
      if (!title) continue
      const norm = normalizeTitle(title)
      const body = String(card?.body ?? '')
      const hits = search(`${title} ${body.slice(0, 160)}`, 3)
      for (const hit of hits) {
        if (normalizeTitle(hit.title) === norm) continue
        if (seen.has(hit.id)) continue
        seen.add(hit.id)
        out.push({
          id: hit.id,
          title: hit.title,
          topic: slug,
          score: hit.score,
          source: hit.source || null,
        })
      }
    }
    return out.slice(0, 5)
  }

  function planSave({ topic, cards, sessionId, dryRun }) {
    if (!Array.isArray(cards) || cards.length === 0) throw new Error('cards 不能为空')
    // dryRun 不创建主题，保持「只预览、不动盘」的语义
    let slug
    if (topic) {
      slug = dryRun ? (findTopic(topic)?.slug ?? slugify(topic)) : createTopic(topic)
    } else {
      slug = currentTopic(sessionId)
    }
    if (!slug) {
      throw new Error('当前会话没有绑定主题：先调用 learn_topics(action="create"|"use") 指定主题')
    }

    // 先记下文件状态，再读内容：这样才能判断「读之后有没有被别人改过」
    const observed = statFile(topicFile(slug))
    const entries = readEntries(slug)
    const plan = []

    for (const card of cards) {
      const title = String(card?.title ?? '').trim()
      if (!title) throw new Error('每张卡片都必须有 title')
      const body = String(card?.body ?? '').trim()
      const kind = card?.kind === 'qa' ? 'qa' : 'point'
      const norm = normalizeTitle(title)
      const existing = entries.find(
        entry => entry.normTitle === norm && (entry.kind || 'point') === kind,
      )
      const archived = existing && (existing.status || 'active') === 'archived'
      // 新条目的 id 在建计划时就生成好：这样落盘后调用方拿到的 plan 里带着真实 id，
      // 界面才能在「整理出来」的结果上直接给这张卡片挂操作。
      const newId = existing ? null : 'k_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
      plan.push({
        title,
        kind,
        action: existing ? (archived ? 'restore' : 'update') : 'create',
        id: existing ? existing.id : dryRun ? null : newId,
        newId,
        version: stampVersion(),
        body,
        tags: Array.isArray(card?.tags)
          ? card.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8)
          : existing?.tags || [],
        q: card?.q ? String(card.q).trim() : existing?.q,
        source: normalizeSource(card?.source) ?? existing?.source ?? null,
        verified:
          typeof card?.verified === 'boolean'
            ? card.verified
            : existing?.verified ?? (card?.source?.type === 'user'),
        appliesTo: card?.appliesTo ? String(card.appliesTo).trim() : existing?.appliesTo ?? null,
      })
    }

    // 语料统计只准备一次（审计 P1-3）：三个检查都拿同一批条目做 BM25，
    // 原来每张卡片都让 rankDocs 把整库重新分词一遍 —— 250 张卡就是 250 遍。
    // DSH_KB_LEGACY_RANK=1 可切回旧路（每卡重建统计），留作对照与逃生舱。
    const legacyRank = process.env.DSH_KB_LEGACY_RANK === '1'
    const pool = entries.filter(entry => (entry.status || 'active') === 'active')
    const topicRanker = legacyRank ? null : createRanker(pool)
    const others = collectOtherEntries(slug)
    const otherRanker = !legacyRank && others.length ? createRanker(others) : null

    const related = findRelated(slug, cards, others, otherRanker)
    const similar = findSimilarInTopic(slug, cards, pool, topicRanker)
    const nearby = findNearbyInTopic(slug, cards, pool, topicRanker)

    if (!dryRun) {
      assertUnchanged(slug, observed)
      for (const item of plan) {
        const existing = item.id
          ? entries.find(entry => entry.id === item.id)
          : null
        if (existing) {
          existing.version = item.version
          existing.title = item.title
          existing.body = item.body
          existing.q = item.q
          existing.tags = item.tags
          existing.source = item.source
          existing.verified = item.verified
          existing.appliesTo = item.appliesTo
          existing.status = 'active'
          delete existing.archivedAt
          existing.updatedAt = now()
        } else {
          entries.push({
            id: item.newId || 'k_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
            topic: slug,
            kind: item.kind,
            title: item.title,
            normTitle: normalizeTitle(item.title),
            q: item.q,
            body: item.body,
            tags: item.tags,
            source: item.source,
            verified: item.verified,
            appliesTo: item.appliesTo,
            status: 'active',
            createdAt: now(),
            updatedAt: now(),
            version: stampVersion(),
          })
        }
      }
      writeEntries(slug, entries)
      const meta = readMeta(slug)
      meta.updatedAt = now()
      if (!meta.name) meta.name = slug
      if (!meta.createdAt) meta.createdAt = meta.updatedAt
      writeMeta(slug, meta)
    }

    return {
      topic: slug,
      dryRun: !!dryRun,
      plan: plan.map(item => ({
        title: item.title,
        kind: item.kind,
        action: item.action,
        id: item.id,
        version: item.version,
        verified: item.verified,
        appliesTo: item.appliesTo,
      })),
      related,
      similar,
      nearby,
      total: entries.length,
    }
  }

  /** 更新既有条目（按 id）。bumpVersion=false 时不升版本（核实状态走这条路）。 */
  function updateEntry({ id, topic, sessionId, fields, bumpVersion = true }) {
    const slug = topic ? slugify(topic) : currentTopic(sessionId)
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (!entry) continue
      assertUnchanged(candidate, observed)
      if (fields.title !== undefined) {
        entry.title = String(fields.title).trim()
        entry.normTitle = normalizeTitle(entry.title)
      }
      if (fields.body !== undefined) entry.body = String(fields.body).trim()
      if (fields.q !== undefined) entry.q = String(fields.q).trim()
      if (fields.tags !== undefined) {
        entry.tags = (Array.isArray(fields.tags) ? fields.tags : [])
          .map(tag => String(tag).trim())
          .filter(Boolean)
          .slice(0, 8)
      }
      if (fields.source !== undefined) entry.source = normalizeSource(fields.source)
      if (fields.appliesTo !== undefined) {
        entry.appliesTo = fields.appliesTo === null ? null : String(fields.appliesTo).trim()
      }
      if (fields.verified !== undefined) entry.verified = !!fields.verified
      if (fields.kind !== undefined) entry.kind = fields.kind === 'qa' ? 'qa' : 'point'
      if (bumpVersion) entry.version = nextVersion(entry.version)
      entry.updatedAt = now()
      writeEntries(candidate, entries)
      return { ok: true, topic: candidate, id: entry.id, version: entry.version, title: entry.title }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /**
   * 找一条条目并返回它所在的主题。
   * @param {{id: string, topic?: string}} options
   * @returns {{topic: string, entry: object}} 找不到就抛错
   */
  function locateEntry({ id, topic }) {
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (entry) return { topic: candidate, entry }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /**
   * 写回卡片正文（AI 校验补充后覆盖用）。
   *
   * 三件事一起做：契约校验在调用方做，这里负责
   *   1) 版本冲突保护：expectedVersion 与当前不符就抛 409，不覆盖
   *   2) 原版快照：第一次修改时把原正文存进 originalBody，之后一直保留
   *      —— 只留「原版 + 当前」两版，不堆多版历史
   *   3) 正文变了 → 核实状态自动回落未核实（内容改了，旧的核实就失效）
   *
   * @param {{id: string, topic?: string, body: string, expectedVersion?: number}} options
   */
  function applyCardBody({ id, topic, body, expectedVersion, model }) {
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (!entry) continue
      assertUnchanged(candidate, observed)
      const current = entry.version || 1
      if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== current) {
        const error = new Error(
          `这条卡片在你之后被改过（现在是 ${formatVersion(current)}，你看到的是 ${formatVersion(expectedVersion)}）。请刷新后重新确认再写。`,
        )
        error.status = 409
        error.code = 'VERSION_CONFLICT'
        throw error
      }
      if (entry.originalBody === undefined || entry.originalBody === null) {
        // 存原版快照时，连它的版本号和写入时间一起存 ——
        // 回退时版本号要跟着正文一起回到原版那一刻（用户 2026-10-23 要求）
        entry.originalBody = entry.body || ''
        entry.originalVersion = current
        entry.originalUpdatedAt = entry.updatedAt || null
      }
      entry.body = String(body ?? '').trim()
      entry.version = nextVersion(current)
      entry.updatedAt = now()
      // 写回痕迹：这次正文是「AI 校验之后」改的，记一笔，但不动 source
      // （source 是知识的出处，不能被工具改写盖掉）
      entry.review = { at: entry.updatedAt, model: model ? String(model) : null }
      // 正文变更 → 核实状态自动回落未核实
      const hadVerify = !!(entry.verified || entry.verify)
      entry.verified = false
      delete entry.verify
      writeEntries(candidate, entries)
      return {
        ok: true,
        topic: candidate,
        id: entry.id,
        version: entry.version,
        title: entry.title,
        body: entry.body,
        verifyReset: hadVerify,
      }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /**
   * 回退到原版。
   *
   * 只有两版：原版 + 当前。回退就是把两版对调 —— 刚才那版成了新的「原版」，
   * 这样还能再退回去，但永远只存两版。
   *
   * 版本号也跟着对调（2026-10-23 用户要求）：内容回到原版，版本号就回到
   * 原版那一刻的时间戳，不能继续往上累加。老条目的原版没有时间戳版本号时，
   * 用原版的写入时间换算，保证版本号规则统一。
   */
  function rollbackCard({ id, topic }) {
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (!entry) continue
      assertUnchanged(candidate, observed)
      if (entry.originalBody === undefined || entry.originalBody === null) {
        throw new Error('这条卡片没有原版快照（还没被改过），不用回退')
      }
      const currentBody = entry.body || ''
      const currentVersion = entry.version || 1
      const currentUpdatedAt = entry.updatedAt || null
      const originalBody = entry.originalBody
      // 原版那一版的版本号：优先原版自己的时间戳版本号；
      // 老数据（整数版本）用原版写入时间换算
      const originalVersion = isStampVersion(entry.originalVersion)
        ? Number(entry.originalVersion)
        : isoToMs(entry.originalUpdatedAt) || stampVersion()
      const originalUpdatedAt = entry.originalUpdatedAt || null

      // 两版对调（正文、版本号、写入时间一起对调）
      entry.originalBody = currentBody
      entry.originalVersion = currentVersion
      entry.originalUpdatedAt = currentUpdatedAt
      entry.body = originalBody
      entry.version = originalVersion
      entry.updatedAt = originalUpdatedAt || now()
      entry.verified = false
      delete entry.verify
      writeEntries(candidate, entries)
      return {
        ok: true,
        topic: candidate,
        id: entry.id,
        version: entry.version,
        title: entry.title,
        body: entry.body,
        verifyReset: true,
      }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /**
   * 批量改核实状态。
   *
   * 批量只走「用户确认」这一条路径（by=source / ai-assisted 交给单条接口），
   * 免得一口气把额度烧在 AI 上。同一个主题里的条目只写一次盘。
   *
   * @param {{ids: string[], topic?: string, state?: string, by?: string, note?: string}} options
   */
  function setVerifyMany({ ids, topic, state, by, note }) {
    const wanted = Array.isArray(ids) ? ids.map(id => String(id)).filter(Boolean) : []
    if (!wanted.length) throw new Error('没有要核实的条目')
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    const verified = state === 'unverified' ? false : true
    const stamp = now()
    const done = []
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      let touched = false
      for (const entry of entries) {
        if (!wanted.includes(entry.id)) continue
        entry.verified = verified
        entry.verify = {
          state: verified ? 'verified' : 'unverified',
          by: String(by || 'user'),
          at: stamp,
          note: note ? String(note).trim() : null,
        }
        entry.updatedAt = stamp
        touched = true
        done.push({ id: entry.id, topic: candidate, version: entry.version || 1 })
      }
      if (touched) {
        assertUnchanged(candidate, observed)
        writeEntries(candidate, entries)
      }
    }
    if (!done.length) throw new Error('没有找到要核实的条目')
    return { ok: true, count: done.length, entries: done }
  }

  /**
   * 改核实状态。
   *
   * 核实不改正文、不升版本 —— 版本号只跟内容走。
   * 写入时同步维护老的 verified 布尔，老工具和老代码不受影响。
   */
  function setVerify({ id, topic, state, by, note }) {
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (!entry) continue
      assertUnchanged(candidate, observed)
      const verified = state === 'verified'
      entry.verified = verified
      entry.verify = {
        state: verified ? 'verified' : 'unverified',
        by: String(by || 'user'),
        at: now(),
        note: note ? String(note).trim() : null,
      }
      entry.updatedAt = now()
      writeEntries(candidate, entries)
      return {
        ok: true,
        topic: candidate,
        id: entry.id,
        version: entry.version,
        verified: entry.verified,
        verify: entry.verify,
      }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /** 删除/归档条目。默认归档（可恢复），hard=true 才真删。 */
  function deleteEntry({ id, topic, sessionId, hard }) {
    const slug = topic ? slugify(topic) : currentTopic(sessionId)
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const index = entries.findIndex(item => item.id === id)
      if (index < 0) continue
      assertUnchanged(candidate, observed)
      const [entry] = entries.splice(index, 1)
      if (!hard) {
        entry.status = 'archived'
        entry.archivedAt = now()
        entry.updatedAt = now()
        entries.push(entry)
      }
      writeEntries(candidate, entries)
      return { ok: true, topic: candidate, id, mode: hard ? 'deleted' : 'archived', title: entry.title }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /** 恢复归档条目：status 回 active，清 archivedAt（Web UI 的「恢复」用它）。 */
  function restoreEntry({ id, topic }) {
    const slug = topic ? slugify(topic) : null
    const candidates = slug ? [slug] : listTopics().map(t => t.slug)
    for (const candidate of candidates) {
      const observed = statFile(topicFile(candidate))
      const entries = readEntries(candidate)
      const entry = entries.find(item => item.id === id)
      if (!entry) continue
      if ((entry.status || 'active') === 'active') {
        return { ok: true, topic: candidate, id, mode: 'already-active', title: entry.title }
      }
      assertUnchanged(candidate, observed)
      entry.status = 'active'
      delete entry.archivedAt
      entry.updatedAt = now()
      entry.version = nextVersion(entry.version)
      writeEntries(candidate, entries)
      return { ok: true, topic: candidate, id, mode: 'restored', title: entry.title }
    }
    throw new Error(`找不到条目 ${id}`)
  }

  /**
   * 领域值归一：大小写、全半角空格、前后空白都不算差别。
   * 库里同一族写成 "C++" / "C++14/17" / "c++" 都出现过，不归一就等于查不到。
   */
  function normDomain(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '')
  }

  /**
   * 把入参变成一组「领域针」。
   * 支持字符串、数组、逗号分隔；空值返回空数组（= 不按领域过滤）。
   */
  function domainNeedles(spec) {
    const raw = Array.isArray(spec) ? spec : String(spec ?? '').split(',')
    return raw.map(normDomain).filter(Boolean)
  }

  /**
   * 领域匹配：完全相等，或条目值包含针（"C++" 能捞到 "C++14/17"）。
   *
   * 为什么要「包含」：库里没有受控词表，"C++" 和 "C++14/17" 是同一个族的两条。
   * 精确相等会让问 "C++" 的人看不到 C++14/17 —— 正是 2026-10-23 用户踩到的那个坑。
   * 反向不成立（针是 "C++14/17" 时不会捞到 "C++"），所以这是「向下兼容」的单向匹配。
   */
  function matchDomain(entryDomain, needles) {
    if (!needles.length) return true
    const value = normDomain(entryDomain)
    if (!value) return false
    return needles.some(needle => value === needle || value.includes(needle))
  }

  /** 出处页码：p.9-10 → 9。没有 locator 的排到最后。 */
  function locatorPage(source) {
    const hit = String(source?.locator || '').match(/\d+/)
    return hit ? Number(hit[0]) : Number.MAX_SAFE_INTEGER
  }

  /**
   * 主题画像：领域分布 + 标签分布（都按数量降序）。
   *
   * 给模型的「目录」：不知道库里有哪些领域值，它就只能瞎猜一个标签 —— 这就是
   * 「问 C++ 却只拿到 tag=C++ 的 34 条」的另一半原因。有了清单它自己就能判断
   * "C语言 13" 要不要一起捞，不用插件硬编码族表。
   */
  function buildFacets(entries, topicDomain = '') {
    const domains = new Map()
    const tags = new Map()
    let unscoped = 0
    for (const entry of entries) {
      if ((entry.status || 'active') !== 'active') continue
      // 条目没标领域时用主题的 domain 兜底（主题本身就是一个领域）
      const domain = String(entry.appliesTo || topicDomain || '').trim()
      if (domain) domains.set(domain, (domains.get(domain) || 0) + 1)
      else unscoped++
      for (const tag of entry.tags || []) {
        const key = String(tag).trim()
        if (key) tags.set(key, (tags.get(key) || 0) + 1)
      }
    }
    const sortDesc = map =>
      Array.from(map, ([value, count]) => ({ value, count })).sort(
        (a, b) => b.count - a.count || a.value.localeCompare(b.value),
      )
    return { appliesTo: sortDesc(domains), tags: sortDesc(tags), unscoped }
  }

  /**
   * 关键词查询拆成「词」。
   *
   * 为什么要有：2026-10-23 用户问「STL、智能指针、RAII、C++11 新特性的相关知识点」，
   * 模型要把相关条目**列出来**。但 learn_entries 当时只能按状态/类型/标签/领域过滤，
   * **没有任何按文字收窄的口子** —— 想给「相关的那些」，模型只能把整个主题列出来
   * （实测两个主题 251 条全刷成了卡片），或者改用 learn_search（那是排序答案，不是清单）。
   * 拆词后按「命中任一词」过滤，用户点名的几个方向都能被列全。
   *
   * 分隔符：中英文逗号、顿号、分号、竖线、斜杠、空白。
   */
  function queryTerms(spec) {
    const raw = Array.isArray(spec)
      ? spec.map(item => String(item ?? ''))
      : String(spec ?? '').split(/[、，,;；|/]+|\s+/)
    return raw.map(term => term.trim().toLowerCase()).filter(Boolean)
  }

  /** 条目的可检索文本：标题、正文、标签、适用范围、问题原文。 */
  function entryHaystack(entry) {
    return [
      entry.title,
      entry.body,
      (entry.tags || []).join(' '),
      entry.appliesTo,
      entry.q,
    ]
      .map(part => String(part ?? '').toLowerCase())
      .join(' ')
  }

  /** 列出条目，支持按状态/类型/标签/领域/关键词过滤。 */
  function listEntries({ topic, sessionId, limit, status, kind, tag, appliesTo, query }) {
    const slug = topic ? slugify(topic) : currentTopic(sessionId)
    if (!slug) {
      throw new Error('当前会话没有绑定主题：先调用 learn_topics(action="create"|"use") 指定主题')
    }
    const entries = readEntries(slug)
    // 主题本身就是一个领域（2026-10-23 用户定）：条目没标 appliesTo 时，用主题的 domain 兜底。
    // 理由：不是所有文件 / 临时加的知识都能提取出领域，但「mysql-进阶 主题里的东西属于 MySQL」
    // 这件事总是成立的 —— 否则按领域收窄会把整个主题清空。
    const topicDomain = readMeta(slug).domain || ''
    const wanted = status || 'active'
    const needles = domainNeedles(appliesTo)
    const terms = queryTerms(query)
    const filtered = entries.filter(entry => {
      const entryStatus = entry.status || 'active'
      if (wanted !== 'all' && entryStatus !== wanted) return false
      if (kind && (entry.kind || 'point') !== kind) return false
      if (tag && !(entry.tags || []).includes(tag)) return false
      if (!matchDomain(entry.appliesTo || topicDomain, needles)) return false
      // 关键词过滤：命中任一词即可（用户点名的几个方向要都能列到）
      if (terms.length) {
        const hay = entryHaystack(entry)
        if (!terms.some(term => hay.includes(term))) return false
      }
      return true
    })
    // 每个词各命中多少条：模型靠它回答「库里有没有 RAII」这种问题
    const termStats = terms.map(term => {
      const needle = term.toLowerCase()
      const count = entries.filter(entry => {
        const entryStatus = entry.status || 'active'
        if (wanted !== 'all' && entryStatus !== wanted) return false
        return entryHaystack(entry).includes(needle)
      }).length
      return { term, count }
    })
    // 有出处页码时按页码排 —— 清单出来就是原始文档顺序，分块和原文一致，
    // 模型照着分节就行，不用自己再归类一遍。没有页码的语料保持原顺序不变。
    const ordered = filtered.some(entry => locatorPage(entry.source) !== Number.MAX_SAFE_INTEGER)
      ? filtered
          .slice()
          .sort(
            (a, b) =>
              locatorPage(a.source) - locatorPage(b.source) ||
              String(a.title || '').localeCompare(String(b.title || '')),
          )
      : filtered
    const max = Number.isInteger(limit) && limit > 0 ? limit : ordered.length
    return {
      topic: slug,
      topicDomain: topicDomain || null,
      total: ordered.length,
      topicTotal: entries.filter(entry => (entry.status || 'active') === wanted || wanted === 'all').length,
      brokenLines: entries.broken || 0,
      facets: buildFacets(entries, topicDomain),
      // 关键词过滤时：模型要知道每个方向各命中几条（RAII 0 条 = 库里真没有）
      terms: terms.length ? terms : null,
      termStats: terms.length ? termStats : null,
      entries: ordered.slice(0, max).map(entry => ({
        id: entry.id,
        kind: entry.kind || 'point',
        status: entry.status || 'active',
        title: entry.title,
        tags: entry.tags || [],
        q: entry.q || null,
        source: entry.source || null,
        verified: entry.verified ?? false,
        appliesTo: entry.appliesTo || null,
        version: entry.version || 1,
        updatedAt: entry.updatedAt || null,
      })),
    }
  }

  return {
    root,
    listTopics,
    findTopic,
    createTopic,
    readEntries,
    topicStamp,
    currentTopic,
    bindTopic,
    setDefaultTopic,
    getDefaultTopic,
    getAiModel,
    setAiModel,
    // 改 / 删条目的工具默认不暴露给模型（省 schema；用户明确说不需要）
    getKbEditTools,
    markPreviewed,
    hasPreviewed,
    planSave,
    updateEntry,
    locateEntry,
    applyCardBody,
    rollbackCard,
    setVerify,
    setVerifyMany,
    deleteEntry,
    restoreEntry,
    listEntries,
    // 领域匹配的三件套：检索层（tools.js 的 learn_search）也要用同一套归一规则，
    // 否则「按领域列清单」和「按领域检索」会对同一份数据给出不同答案。
    normDomain,
    domainNeedles,
    matchDomain,
    // 主题级领域：条目没标 appliesTo 时用主题的 domain 兜底（主题本身就是一个领域）
    topicDomain,
    locatorPage,
    // 关键词过滤：检索层和清单层共用同一套拆词规则
    queryTerms,
    entryHaystack,
  }
}

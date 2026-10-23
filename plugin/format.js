// 正文重排：把一整段连续文字拆成面板认得的结构。
//
// 纪律：只加换行和项目符号，不改一个字、不删一个字、不改标点。
// 「；」「→」被换成换行，「。」保留在最后一项 —— 语义完全不变。
//
// 渲染侧的解析在 client/index.js 的 parseBody；这里是写入侧的生产者。
// 两者各管一头：解析器负责"读得懂各种写法"，这里负责"写成标准写法"。

const SENTENCE_END = new Set(['。', '！', '？'])

/**
 * 版本号 = 写入时刻的时间戳（epoch 毫秒）。
 *
 * 2026-10-23 用户定的规则：版本号不再自增，改成时间戳。好处：
 *   · 跨端同步时能直接看出谁新谁旧（整数自增在不同端会撞车）
 *   · 回退到原版时，版本号跟着正文一起回到原版那一刻
 * 老数据还是小整数（1、2、3…），显示时按老样子处理。
 */
export const TIMESTAMP_VERSION_MIN = 1e12

export function isStampVersion(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= TIMESTAMP_VERSION_MIN
}

const pad2 = (value) => String(value).padStart(2, '0')

/** 完整版本号：时间戳显示成 '2026-10-23 01:28'，老整数显示成 'v2'。 */
export function formatVersion(version) {
  const n = Number(version)
  if (!Number.isFinite(n)) return 'v' + String(version ?? '')
  if (!isStampVersion(n)) return 'v' + n
  const date = new Date(n)
  return (
    date.getFullYear() +
    '-' +
    pad2(date.getMonth() + 1) +
    '-' +
    pad2(date.getDate()) +
    ' ' +
    pad2(date.getHours()) +
    ':' +
    pad2(date.getMinutes())
  )
}

/** 卡片脚上的短版本号：'10-23 01:28'（老数据仍是 'v2'）。 */
export function shortVersion(version) {
  const n = Number(version)
  if (!Number.isFinite(n) || !isStampVersion(n)) return 'v' + n
  const date = new Date(n)
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 按顶层分隔符切分；括号里的分隔符不算（"(如 a；b)" 里的分号不是并列项）。 */
function splitTopLevel(text, separators) {
  const parts = []
  let depth = 0
  let buffer = ''
  for (const ch of text) {
    if (ch === '（' || ch === '(') depth++
    else if (ch === '）' || ch === ')') depth--
    if (depth === 0 && separators.includes(ch)) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  parts.push(buffer)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** 顶层句子切分，保留句末标点。 */
function splitSentences(text) {
  const out = []
  let buffer = ''
  let depth = 0
  for (const ch of text) {
    buffer += ch
    if (ch === '（' || ch === '(') depth++
    else if (ch === '）' || ch === ')') depth--
    else if (depth === 0 && SENTENCE_END.has(ch)) {
      out.push(buffer.trim())
      buffer = ''
    }
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out.filter(Boolean)
}

/** 一句话怎么排：并列项（；/→）→ 列表；否则 → 段落。 */
function planSentence(sentence) {
  if (sentence.includes('→')) {
    const parts = splitTopLevel(sentence, ['→'])
    if (parts.length >= 2) {
      // 引导语靠冒号认："按层看：连接层（A）→ …" 的前半截是引导语 + 第一项
      let lead = null
      let items = parts
      const at = parts[0].indexOf('：')
      if (at >= 0 && at + 1 <= 14) {
        lead = parts[0].slice(0, at + 1)
        const head = parts[0].slice(at + 1).trim()
        items = [head, ...parts.slice(1)].filter(Boolean)
      }
      return { type: 'list', lead, items }
    }
  }
  if (sentence.includes('；')) {
    const parts = splitTopLevel(sentence, ['；'])
    if (parts.length >= 2) return { type: 'list', lead: null, items: parts }
  }
  return { type: 'p', text: sentence }
}

function renderBlocks(blocks) {
  const lines = []
  let lastWasList = false
  for (const block of blocks) {
    if (block.type === 'p') {
      if (lines.length) lines.push('')
      lines.push(block.text)
      lastWasList = false
      continue
    }
    if (lines.length && !lastWasList) lines.push('')
    if (block.lead) lines.push(block.lead)
    for (const item of block.items) lines.push('- ' + item)
    lastWasList = true
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把正文重排成块结构。
 * @param {string} body 原始正文
 * @returns {string|null} 新正文；null 表示这条不该动
 */
export function formatBody(body) {
  const source = String(body ?? '').trim()
  if (!source) return null
  if (source.includes('\n')) return null // 已经是块结构，别碰
  if (source.includes('①')) return null // ①②③ 连写由渲染层直接拆成列表，改写会丢序号
  if (!source.includes('；') && !source.includes('→') && !hasSentenceBreak(source)) return null

  const blocks = splitSentences(source).map(planSentence)
  if (blocks.length === 1 && blocks[0].type === 'p') return null
  const text = renderBlocks(blocks)
  return text === source ? null : text
}

function hasSentenceBreak(text) {
  return splitSentences(text).length > 1
}

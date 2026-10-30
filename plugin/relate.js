// 学习知识库 · 「哪些卡片相关」的判断（纯逻辑层）
//
// 这一层只回答一个问题：**这两张卡该不该连一条线？**
// 判据只用看得见的信号 —— 共享标签、标题撞词、正文词重合度 ——
// 不用模型、不猜语义，理由要能说出来（「同标签 锁」「标题撞词 间隙」「内容重合 24%」）。
//
// 为什么单独一个文件：
//   - 判据要能被单测覆盖（「同名同标签的两张卡连不连」这种事不能靠眼看）；
//   - 存储层（落库）、工具层（入库时自动挂）、面板（扫描按钮）要用同一套判据，
//     免得「界面里连的」和「批量扫出来的」不是一个标准。

import { tokenize, tokenSet, jaccard } from './rank.js'

/**
 * 泛标签：到处都有的分类词，不能拿它当「相关」的证据。
 * （「分类」「作用」「参数」这种标签几乎每张卡都有，拿它连边等于乱连）
 */
export const GENERIC_TAGS = new Set([
  '分类', '作用', '参数', '查询', '内存', '特点', '区别', '原理', '流程', '总结',
  '常见', '基础', '使用', '注意', '场景', '问题', '实现', '对比', '类型', '结构',
])

/**
 * 标题里的停用词：这些词撞上了不算「撞词」。
 *
 * 除了常见的虚词，还包括那些泛标签词 —— 「索引的分类」和「缓冲池的分类」
 * 都带「分类」，但它们不是一回事；拿泛词当撞词证据会连出一堆废边。
 */
const TITLE_STOP = new Set([
  '的', '是', '在', '和', '与', '等', '了', '有', '对', '为', '把', '被', '从', '到', '上', '下', '个',
  '这', '那', '就', '也', '不', '会', '可以', '一个', '什么', '怎么', '如果', '因为', '所以', '但是',
  'the', 'a', 'an', 'of', 'to', 'is', 'are', 'and', 'or', 'in', 'on', 'for', 'with',
  ...GENERIC_TAGS,
])

/**
 * 标题里这些字开头/结尾的二元组是噪音（「的分」「与聚」这种）。
 * 中文没有词边界，分词只能切二元组，所以只能靠这个粗筛。
 */
const STOP_CHARS = '的是在和与等了有对为把被从到上下个这那就也不会一二三不很最更'

/**
 * 给一张卡算它的「特征」：标题词、正文词集合、整体词集合。
 *
 * 整体词集合**不含标签** —— 标签是另一条独立的信号，
 * 混进来会把「共享同一个标签」这件事算两遍，正文重合度就虚高了。
 *
 * @param {object} card 卡片（要有 title / body / q / tags）
 * @returns {{titleTerms: Set<string>, bodySet: Set<string>, allSet: Set<string>}}
 */
export function cardFeatures(card) {
  const title = String(card?.title || '')
  const body = String(card?.body || '')
  const q = String(card?.q || '')
  const titleTokens = tokenize(title + ' ' + q).filter(term => {
    if (!term || term.length < 2) return false
    if (TITLE_STOP.has(term)) return false
    if (STOP_CHARS.includes(term[0]) || STOP_CHARS.includes(term[term.length - 1])) return false
    return true
  })
  return {
    titleTerms: new Set(titleTokens),
    bodySet: tokenSet(body),
    allSet: new Set([...titleTokens, ...tokenize(body)]),
  }
}

/**
 * 判断两张卡「算不算相关」。
 *
 * 返回 null = 不算；否则返回 {why, score, tagShared, titleShared, allOv, bodyOv}。
 * 规则按强度从高到低（先命中先算）：
 *   ① 共享 ≥2 个标签，且整体词重合 ≥3%
 *   ② 共享 1 个标签，且标题撞词 ≥1，且整体词重合 ≥2.5%
 *   ③ 标题撞词 ≥2，且整体词重合 ≥8%
 *   ④ 整体词重合 ≥11%（近义或重复的两张卡）
 *   ⑤ 同标签簇：共享一个具体标签（小标签簇 ≤5 张且有重合，或 ≤10 张且重合 ≥5%）
 *
 * @param {object} a 卡片 A（要带 features）
 * @param {object} b 卡片 B（要带 features）
 * @param {Map<string, number>} tagCount 标签在库里的出现次数
 * @returns {object|null}
 */
export function judgeRelated(a, b, tagCount) {
  const tagsA = Array.isArray(a.tags) ? a.tags : []
  const tagsB = Array.isArray(b.tags) ? b.tags : []
  const tagShared = tagsA.filter(tag => tagsB.includes(tag))
  const titleShared = [...a.features.titleTerms].filter(term => b.features.titleTerms.has(term))
  const allOv = Math.round(jaccard(a.features.allSet, b.features.allSet) * 1000) / 1000
  const bodyOv = Math.round(jaccard(a.features.bodySet, b.features.bodySet) * 1000) / 1000
  const count = tag => (tagCount.get(tag) || 0)

  if (tagShared.length >= 2 && allOv >= 0.03) {
    return { why: `同标签 ${tagShared.join('/')}`, score: 3 + tagShared.length + allOv, tagShared, titleShared, allOv, bodyOv }
  }
  if (tagShared.length >= 1 && titleShared.length >= 1 && allOv >= 0.025) {
    return { why: `同标签 ${tagShared.join('/')} + 标题撞词`, score: 2 + allOv, tagShared, titleShared, allOv, bodyOv }
  }
  if (titleShared.length >= 2 && allOv >= 0.08) {
    return { why: `标题撞词 ${titleShared.slice(0, 3).join('/')}`, score: 1.5 + allOv, tagShared, titleShared, allOv, bodyOv }
  }
  if (allOv >= 0.11) {
    return { why: `内容重合 ${Math.round(allOv * 100)}%`, score: 1 + allOv, tagShared, titleShared, allOv, bodyOv }
  }
  if (tagShared.length >= 1 && allOv >= 0.02) {
    const specific = tagShared.filter(tag => !GENERIC_TAGS.has(tag))
    const small = specific.filter(tag => count(tag) <= 5)
    const mid = specific.filter(tag => count(tag) <= 10)
    if (small.length || (mid.length && allOv >= 0.05)) {
      const tags = small.length ? small : mid
      return { why: `同标签簇 ${tags.join('/')}`, score: 0.8 + allOv, tagShared, titleShared, allOv, bodyOv }
    }
  }
  return null
}

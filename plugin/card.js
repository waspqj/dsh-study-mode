// 学习知识库 · 卡片交互的纯逻辑层
//
// 这一层不碰盘、不碰网络，只做三件事：
//   1) 把条目投影成「卡片」结构（工具结果、界面、模型三边共用同一份形状）
//   2) 校验正文是否符合写入契约（首行结论 / "- " 要点 / 反引号成对 / 【】成对）
//   3) 拼 AI 校验与追问的提示词，并把模型返回的文本解析回结构
//
// 为什么要单独一个文件：
//   - 提示词里绝对不能带会话历史，一旦混进来「上下文隔离」就破了。
//     把提示词拼装集中在这里，测试能直接断言「payload 里只有卡片正文」。
//   - 写入契约的判断要能被单测覆盖，不能散落在界面代码里。

/** 写入契约的软上限：正文超过这个长度只提示，不拦（老卡片可能有更长的）。 */
export const BODY_SOFT_LIMIT = 400

/** 正文允许的最大长度（硬上限，超过就拒绝写入）。 */
export const BODY_HARD_LIMIT = 2000

/** 一次校验最多采纳几条补充要点。多了就是在重写这张卡，不该由工作台干。 */
export const MAX_ADDITIONS = 3

/** 单条补充要点的字数上限（超出截断，不报错）。 */
export const ADDITION_MAX_CHARS = 120

/**
 * 卡片投影：界面对话里展示、工具结果携带、AI 校验输入，三边共用同一份形状。
 *
 * @param {object} entry 库里的条目
 * @param {string} topicName 主题显示名
 * @returns {object} 卡片结构
 */
export function projectCard(entry, topicName) {
  return {
    id: entry.id,
    title: entry.title || '',
    body: entry.body || '',
    topic: entry.topic || '',
    topicName: topicName || entry.topic || '',
    kind: entry.kind || 'point',
    q: entry.q || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    source: entry.source || null,
    verified: entry.verified ?? false,
    verify: entry.verify || null,
    appliesTo: entry.appliesTo || null,
    version: entry.version || 1,
    updatedAt: entry.updatedAt || null,
    score: typeof entry.score === 'number' ? entry.score : null,
  }
}

/**
 * 校验正文是否符合写入契约。
 *
 * 硬规则（不通过就不许写）：
 *   - 正文非空
 *   - 首行是结论（不能以 "- " 开头）
 *   - 反引号成对
 *   - 【】成对
 *   - 长度不超过硬上限
 * 软提示（只提示，不拦）：
 *   - 超过软上限（400 字）
 *   - 没有任何 "- " 要点行（说明可能是整段话，排版上不好读）
 *
 * @param {string} body 正文
 * @returns {{ok: boolean, problems: string[], warnings: string[]}}
 */
export function validateBody(body) {
  const text = String(body ?? '').trim()
  const problems = []
  const warnings = []

  if (!text) {
    problems.push('正文不能为空')
    return { ok: false, problems, warnings }
  }

  const lines = text.split('\n')
  const first = lines[0].trim()
  if (first.startsWith('- ')) {
    problems.push('首行必须是结论（不要以 "- " 开头，要点从第二行开始）')
  }
  if (first && !/[。！？；，、:：)）】]/.test(first) && lines.length > 1) {
    warnings.push('首行结论建议以句号或分号收尾')
  }

  const backticks = (text.match(/`/g) || []).length
  if (backticks % 2 !== 0) {
    problems.push('反引号没有成对（代码片段要用一对 ` 包住）')
  }

  const open = (text.match(/【/g) || []).length
  const close = (text.match(/】/g) || []).length
  if (open !== close) {
    problems.push('【】没有成对')
  }

  if (text.length > BODY_HARD_LIMIT) {
    problems.push(`正文超过 ${BODY_HARD_LIMIT} 字，请拆成多条`)
  } else if (text.length > BODY_SOFT_LIMIT) {
    warnings.push(`正文 ${text.length} 字，超过建议的 ${BODY_SOFT_LIMIT} 字`)
  }

  if (!lines.some(line => line.trim().startsWith('- '))) {
    warnings.push('没有 "- " 开头的要点行')
  }

  return { ok: problems.length === 0, problems, warnings }
}

/** 校验模式的中文说明，提示词里要用。 */
const MODE_BRIEF = {
  verify: '只找事实性问题：说法错误、结论过时、条件缺失、适用范围写错、把某个实现说成通用的等等。不做扩写。',
  expand: '只补充可以确认的要点：不发明事实；确实是延伸但需要用户自己确认的内容，在文本末尾标「延伸·待核实」。',
  both: '既找事实性问题，也补充可以确认的要点。不发明事实；确实是延伸但需要用户自己确认的内容，在文本末尾标「延伸·待核实」。',
}

/**
 * 拼 AI 校验的提示词。
 *
 * 上下文只有卡片本身：标题、正文、主题、标签。**绝不包含会话历史**，
 * 也绝不包含别的卡片 —— 这是「上下文隔离」的落点，单测会断言这一点。
 *
 * @param {object} card 卡片投影
 * @param {'verify'|'expand'|'both'} mode 校验模式
 * @returns {{system: string, prompt: string}}
 */
export function buildReviewPrompt(card, mode) {
  const kind = MODE_BRIEF[mode] ? mode : 'both'
  const system = [
    '你是知识库的审校助手。你会看到一张知识卡片（标题 + 正文 + 主题 + 标签）。',
    '硬纪律：',
    '1. 只依据卡片自身的内容判断，不要引入你记忆里的其它结论去"纠正"它。',
    '2. 不发明事实。你不确定的地方写进 issues，并说明"需核实"，不要直接断言。',
    '3. 不删参数、不改数字、不改命令原文。',
    '4. suggested 必须是完整正文，格式：首行结论，之后每行一个要点，行首 "- "。',
    '5. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏。',
    '5b. **第一行就是那个 JSON 对象**（程序只读第一段 JSON）。如果还想补充说明，写在 JSON 之后，不要写在前面。',
    '5c. 输出要短：整个 JSON 控制在 30 行以内，suggested 没必要时给空字符串。',
    `6. additions 最多 ${MAX_ADDITIONS} 条、每条不超过 ${ADDITION_MAX_CHARS} 字，只写"卡里确实缺的事实点"，不要展开成讲解。`,
    '7. 不要输出表格、多级标题、教程式清单、追问预备清单 —— 正文格式只有：首行结论 + "- " 要点。',
    '8. suggested 只在结构确实需要重排时才给，且不要比原文多出新的章节；没有要改的就给空字符串。',
  ].join('\n')

  const prompt = [
    `主题：${card.topicName || card.topic || '未标注'}`,
    `标题：${card.title}`,
    card.tags && card.tags.length ? `标签：${card.tags.join('、')}` : '',
    '',
    '正文：',
    card.body,
    '',
    `任务：${MODE_BRIEF[kind]}`,
    '',
    '输出这个 JSON（字段可以为空数组或空字符串）：',
    '{',
    '  "issues": [{"text": "问题描述", "level": "warn"}],',
    '  "additions": [{"text": "可补充的要点"}],',
    '  "suggested": "完整的改写后正文（没有要改的就给空字符串）"',
    '}',
  ]
    .filter(line => line !== '')
    .join('\n')

  return { system, prompt }
}

/**
 * 宽松修复最常见的三种 JSON 毛病：尾逗号、`//` 与 `/* *\/` 注释、单引号包字符串。
 *
 * 只在严格解析失败后使用 —— 它是"尽力救一次"，不是标准解析器。
 * @param {string} text 待修复的 JSON 文本
 * @returns {string} 修复后的文本
 */
function loosenJson(text) {
  return text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^']*)'/g, ': "$1"')
}

/**
 * 解析模型返回的 JSON。模型很爱加代码围栏、前后废话，这里放宽一点。
 *
 * @param {string} text 模型返回的原文
 * @returns {{issues: object[], additions: object[], suggested: string, parseError: boolean, raw: string}}
 */
export function parseReviewJson(text) {
  const text0 = String(text ?? '').trim()
  const raw = text0.length > 4000 ? text0.slice(0, 4000) + '…' : text0
  const empty = { issues: [], additions: [], suggested: '', parseError: false, raw }
  if (!raw) return { ...empty, parseError: true }

  let payload = raw
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(payload)
  if (fence) payload = fence[1].trim()

  const start = payload.indexOf('{')
  const end = payload.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return { ...empty, parseError: true }
  payload = payload.slice(start, end + 1)

  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    // 宽松修复一次：模型常犯的是尾逗号、// 注释、单引号包 key。
    // 只在第一次解析失败时尝试，避免把正常内容改坏。
    try {
      parsed = JSON.parse(loosenJson(payload))
    } catch {
      return { ...empty, parseError: true }
    }
  }
  if (!parsed || typeof parsed !== 'object') return { ...empty, parseError: true }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .map(item => {
          if (typeof item === 'string') return { text: item, level: 'warn' }
          if (!item || typeof item !== 'object') return null
          const value = String(item.text ?? item.issue ?? '').trim()
          if (!value) return null
          return { text: value, level: item.level === 'error' ? 'error' : 'warn' }
        })
        .filter(Boolean)
    : []

  // 补充要点要**短**，这是有意的硬限制：
  // 2026-10-22 用户点了「AI 校验补充」，模型回了整张「TCP/UDP 完整对照表」+ 追问清单，
  // 那不是工作台该产出的东西 —— 工作台只补"卡里确实缺的事实点"。
  // 所以这里不光在提示词里要求，解析时也硬截断，模型不听话也不会把面板撑爆。
  const additions = Array.isArray(parsed.additions)
    ? parsed.additions
        .map(item => {
          if (typeof item === 'string') return { text: item.trim() }
          if (!item || typeof item !== 'object') return null
          const value = String(item.text ?? '').trim()
          if (!value) return null
          return { text: value }
        })
        .filter(Boolean)
        .slice(0, MAX_ADDITIONS)
        .map(item => ({ text: item.text.length > ADDITION_MAX_CHARS ? item.text.slice(0, ADDITION_MAX_CHARS) + '…' : item.text }))
    : []

  const suggested = typeof parsed.suggested === 'string' ? parsed.suggested.trim() : ''

  return { issues, additions, suggested, parseError: false, raw }
}

/**
 * 拼「问一下」的提示词。
 *
 * 上下文 = 卡片正文 + 这张卡片自己的追问历史（history 由前端维持，不落库）。
 * 不关联会话里的任何其它内容。
 *
 * @param {object} card 卡片投影
 * @param {string} question 用户这次问的
 * @param {Array<{q: string, a: string}>} history 这张卡片之前的追问
 * @returns {{system: string, prompt: string}}
 */
export function buildAskPrompt(card, question, history) {
  const system = [
    '你是知识卡片的问答助手。你只能依据给定的那一条知识卡片来回答。',
    '硬纪律：',
    '1. 卡片里没有的信息，直接说「这条卡片里没有」并给出建议去问哪个主题，不要凭记忆补充。',
    '2. 不要引入会话里的其它内容 —— 你看不到，也不需要。',
    '3. 回答用中文，简洁；必要时可以用 "- " 列点。',
  ].join('\n')

  const turns = Array.isArray(history) ? history.slice(-6) : []
  const parts = [
    `卡片主题：${card.topicName || card.topic || '未标注'}`,
    `卡片标题：${card.title}`,
    '',
    '卡片正文：',
    card.body,
  ]
  if (turns.length) {
    parts.push('', '此前就这张卡片的追问：')
    for (const turn of turns) {
      if (turn && turn.q) parts.push(`问：${String(turn.q).trim()}`)
      if (turn && turn.a) parts.push(`答：${String(turn.a).trim()}`)
    }
  }
  parts.push('', `现在的问题：${String(question ?? '').trim()}`)

  return { system, prompt: parts.join('\n') }
}

/**
 * 把若干条「采纳」的补充拼到正文后面。
 * 采纳是逐条进行的，所以这里只负责把单条文本变成一行要点。
 *
 * @param {string} text 补充内容
 * @returns {string} 要点行
 */
export function toBullet(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  if (value.startsWith('- ')) return value
  return '- ' + value.replace(/\n+/g, ' ')
}

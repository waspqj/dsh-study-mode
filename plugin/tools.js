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

import { createStore, slugify } from './store.js'
import { rankDocs } from './rank.js'

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

function text(value) {
  return [{ type: 'text', text: value }]
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

function renderHits(value) {
  if (value.needTopic) {
    return `没有绑定主题，无法检索主题库。${value.note || ''}`
  }
  const lines = [
    `检索 "${value.query}" → 范围 ${value.scope}，库内 ${value.total} 条，命中 ${value.hits.length} 条`,
  ]
  for (const hit of value.hits) {
    lines.push('')
    lines.push(`${hit.strength} [${hit.score}] ${hit.fromCurrent ? '★' : ''}${hit.title}${hit.verified ? ' ✓已核实' : ' ⚠未核实'}`)
    if (hit.q) lines.push(`问：${hit.q}`)
    lines.push(hit.body || '(空)')
    const meta = []
    if (hit.tags?.length) meta.push(`标签 ${hit.tags.join('/')}`)
    if (hit.appliesTo) meta.push(`适用 ${hit.appliesTo}`)
    if (hit.source) meta.push(renderSource(hit.source))
    if (hit.topic) meta.push('主题 ' + hit.topic)
    if (meta.length) lines.push(meta.join(' · '))
  }
  return lines.join('\n')
}

/**
 * 宿主不变量：dsh-ops 的 hide-official 开启时，会检查它接管的官方文件工具是否都有
 * OPS 替身。少了下面任何一个，宿主判定 READINESS_BLOCKED，agent 直接不可用
 *（2026-10-22 实测踩过：一发消息就挂）。这些工具永远不能被限制掉。
 */
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

/** 确认框里给用户看的内容（中文）。 */
function buildApprovalText(plan) {
  const lines = []
  const verb = plan.plan.length > 1 ? '写入' : '写入'
  lines.push(`将向主题「${plan.topic}」${verb} ${plan.plan.length} 条知识：`)
  for (const p of plan.plan) {
    const act = p.action === 'create' ? '新增' : p.action === 'restore' ? '恢复' : '更新'
    lines.push(`- ${act}《${p.title}》${p.version > 1 ? '（→ v' + p.version + '）' : ''}`)
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
function buildApprovalTextEn(plan) {
  const lines = [`Write ${plan.plan.length} knowledge card(s) to topic «${plan.topic}»:`]
  for (const p of plan.plan) {
    const act = p.action === 'create' ? 'add' : p.action === 'restore' ? 'restore' : 'update'
    lines.push(`- ${act} «${p.title}»${p.version > 1 ? ' (→ v' + p.version + ')' : ''}`)
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
async function requestApproval({ ctx, exec, plan }) {
  const approval = ctx?.get?.('approval')
  if (!approval || typeof approval.request !== 'function') return 'unavailable'
  const agent = exec?.agent
  if (!agent) return 'unavailable'
  const zh = buildApprovalText(plan)
  const en = buildApprovalTextEn(plan)
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
 *   3. mode=commit → 弹宿主确认框，用户点了就写；mode=preview → 只出预览
 *   4. 写盘前仍要过「这批内容预览过没有」的服务端指纹闸门
 */
async function runSave({ ctx, store, args, exec }) {
  const sessionId = sessionIdOf(exec)
  const cards = normalizeCards(args?.cards)
  const topic = args?.topic ? String(args.topic).trim() : undefined
  const mode = args?.mode === 'preview' ? 'preview' : 'commit'
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
      message: '这条和库里的条目高度相似，先请用户裁决：补充原条目（learn_update）还是仍然新增（bypassDuplicate=true）。',
    }
  }

  if (mode === 'preview') {
    return {
      ...plan,
      dryRun: true,
      status: 'preview',
      message: '预览（未写入）。用户确认后用 mode="commit" 再调一次。',
    }
  }

  // 弹宿主确认框
  const outcome = await requestApproval({ ctx, exec, plan })
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

  ctx.tools.register({
    name: 'learn_topics',
    description:
      '学习模式的知识库主题管理。action=list 列出全部主题；create 新建主题并绑定当前会话；use 把当前会话切到某个已有主题（不存在会报错，不会偷偷建空主题）；current 只看当前绑定；find 按关键词模糊查找主题；default 设置/清除默认主题（新会话未绑定时自动使用）。',
    parameters: toolSchema(
      {
        action: {
          type: 'string',
          enum: ['list', 'create', 'use', 'current', 'find', 'default'],
          description:
            'list 列出全部主题 | create 新建并绑定当前会话 | use 切到已有主题 | current 看当前绑定 | find 按名称模糊查找 | default 设置/清除默认主题',
        },
        name: {
          type: 'string',
          description:
            '主题名称。action=create 时必填；action=use/find 时填要查找的名称；action=default 时填要设为默认的主题名，传空字符串则清除默认主题',
        },
        description: {
          type: 'string',
          description: '主题描述（仅 action=create 用），一句话说明这个主题覆盖什么',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '主题关键词（仅 action=create 用），用于之后按关键词模糊查找',
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
                }`,
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
      '在知识库里检索。scope=topic 只查当前会话绑定的主题（默认），scope=all 查所有主题库（即整体库）。返回按相关度排序的条目，含正文、出处类型、是否已核实、适用版本与打分。',
    parameters: toolSchema(
      {
        query: { type: 'string', description: '检索词，直接用问题原文即可' },
        scope: {
          type: 'string',
          enum: ['auto', 'topic', 'all'],
          default: 'auto',
          description:
            'auto（默认，一次查完两级：先当前主题、命中不够再补其它主题）| topic 只查当前主题 | all 查所有主题库',
        },
        topic: {
          type: 'string',
          description: '指定主题，覆盖当前绑定；主题不存在只返回提示，不会新建空主题',
        },
        tag: { type: 'string', description: '只返回带该标签的条目' },
        limit: { type: 'integer', description: '返回条数，默认 3，最大 10' },
      },
      ['query'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderHits(value)),
    },
    execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const query = String(args?.query || '').trim()
      if (!query) throw new Error('query 不能为空')
      const scope = ['topic', 'all', 'auto'].includes(args?.scope) ? args.scope : 'auto'
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 3))
      const tag = args?.tag ? String(args.tag).trim() : null

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

      // auto：先查当前主题，命中不够再补其它主题 —— 保留「当前主题优先」语义，但只花一次调用
      let groups = []
      if (scope === 'all') {
        groups = [allTopics.map(t => t.slug)]
      } else if (scope === 'topic') {
        groups = currentSlug ? [[currentSlug]] : []
      } else if (currentSlug) {
        groups = [[currentSlug], allTopics.map(t => t.slug).filter(s => s !== currentSlug)]
      } else {
        // 没绑定主题也照样查整体库（②级永远不跳过）
        groups = [allTopics.map(t => t.slug)]
      }

      const hits = []
      const seen = new Set()
      let total = 0
      for (const group of groups) {
        const docs = []
        for (const slug of group) {
          for (const entry of store.readEntries(slug)) {
            if ((entry.status || 'active') !== 'active') continue
            if (tag && !(entry.tags || []).includes(tag)) continue
            if (seen.has(entry.id)) continue
            seen.add(entry.id)
            docs.push({ ...entry, topicSlug: slug })
          }
        }
        total += docs.length
        if (hits.length >= limit) continue
        for (const hit of rankDocs(docs, query, limit - hits.length)) {
          hits.push({
            ...hit,
            verified: hit.verified ?? false,
            appliesTo: hit.appliesTo || null,
            fromCurrent: !!currentSlug && hit.topic === currentSlug,
          })
        }
      }
      return {
        scope: scope === 'all' ? 'all' : currentSlug || (scope === 'auto' ? 'all' : 'topic'),
        query,
        total,
        hits,
        currentTopic: currentSlug,
        note: currentSlug ? '' : '当前会话没绑定主题，已按整体库检索。入库前请先用 learn_topics 指定主题。',
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
      '把知识卡片写进主题库。默认：工具自己算好写入计划和查重结果，弹宿主确认框给用户点，用户点「允许」就写入 —— 一次调用搞定。用户想先看内容再决定时传 mode="preview"（只出预览不写）。返回里若带 similar，是同主题的疑似重复；要带 related，说明其它主题有相近或冲突条目，都交给用户裁决。',
    parameters: toolSchema(
      {
        cards: {
          type: 'array',
          description:
            '一张或多张知识卡片。每张必须有 title 和 body；tags 给 2-5 个；kind 默认 point，问答类用 qa 并把问题原文放进 q；source 写 {type: user|file|web|model, ref: 出处说明, locator: 页码}；verified 表示用户是否核实过；appliesTo 写适用范围。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '标题，≤20 字' },
              body: { type: 'string', description: '正文，≤400 字' },
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
        topic: { type: 'string', description: '目标主题，缺省用当前会话绑定或默认主题' },
        mode: {
          type: 'string',
          enum: ['commit', 'preview'],
          default: 'commit',
          description: 'commit（默认）：弹确认框，用户点了就写入 | preview：只出预览不写',
        },
        approved: {
          type: 'boolean',
          description: '仅当确认框不可用、用户已在对话里点头时置 true：跳过确认框直接写。必须先预览过同一批内容。',
        },
        bypassDuplicate: {
          type: 'boolean',
          description: '出现「疑似重复」时用户仍要新增才置 true，否则只提示不写',
        },
      },
      ['cards'],
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(renderSave(value)),
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

  ctx.tools.register({
    name: 'learn_update',
    description:
      '修改库里已有的一条（按 id）。可改正文、标签、出处、适用范围、是否已核实等；修改后版本号递增。',
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

  ctx.tools.register({
    name: 'learn_entries',
    description:
      '列出某个主题里已有的条目（标题、标签、出处、是否核实、版本），用于审阅、查重或回顾。可按状态、类型、标签过滤。',
    parameters: toolSchema(
      {
        topic: { type: 'string', description: '主题名称，缺省用当前会话绑定的主题' },
        status: {
          type: 'string',
          enum: ['active', 'archived', 'all'],
          description: 'active（默认）| archived | all',
        },
        kind: { type: 'string', enum: ['point', 'qa'], description: 'point | qa' },
        tag: { type: 'string', description: '按标签过滤' },
        limit: { type: 'integer', description: '最多返回多少条' },
      },
    ),
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          [
            `主题「${value.topic}」共 ${value.total} 条${value.brokenLines ? `（另有 ${value.brokenLines} 行数据损坏已跳过）` : ''}`,
            ...value.entries.map(
              e =>
                `- [${e.id}] ${e.title}${e.status === 'archived' ? '（已归档）' : ''}${e.version > 1 ? ' v' + e.version : ''}${
                  e.verified ? ' ✓已核实' : ' ⚠未核实'
                }${e.appliesTo ? ' 适用:' + e.appliesTo : ''}${e.tags?.length ? ' {' + e.tags.join('/') + '}' : ''}${
                  e.source ? ' ' + renderSource(e.source) : ''
                }`,
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
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '列出知识库条目',
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

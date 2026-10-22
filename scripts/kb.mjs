#!/usr/bin/env node
// 学习模式知识库 CLI —— 不经过对话，直接在终端看库
//
// 用法:
//   node scripts/kb.mjs stats                       # 主题与条目统计
//   node scripts/kb.mjs topics                      # 列出主题
//   node scripts/kb.mjs list [主题] [--all] [--limit N]   # 列出条目（默认只列 active）
//   node scripts/kb.mjs search <关键词> [--topic 主题] [--all] [--limit N]
//   node scripts/kb.mjs show <id>                   # 看单条全文
//
//   node scripts/kb.mjs add <主题> --title "标题" --body "正文" [--tags a,b] [--verified]
//                                                   # 直接加一条（终端手工入口，不经过对话里的预览闸门）
// 库位置：DSH_LEARN_ROOT > DSH_HOME/learn > ~/.dsh/learn

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { createStore } from '../plugin/store.js'
import { rankDocs } from '../plugin/rank.js'
import { formatBody } from '../plugin/format.js'

const argv = process.argv.slice(2)
const command = argv[0]

function resolveRoot() {
  const override = process.env.DSH_LEARN_ROOT
  if (override && override.trim()) return path.resolve(override.trim())
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'learn')
}

/** 从参数里取 --flag 与 --key value 形式的值。 */
function parseFlags(args) {
  const flags = {
    all: false,
    verified: false,
    apply: false,
    limit: null,
    topic: null,
    title: null,
    body: null,
    tags: [],
    'source-type': null,
    'source-ref': null,
    locator: null,
    'applies-to': null,
    kind: null,
    q: null,
  }
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (item === '--all') flags.all = true
    else if (item === '--verified') flags.verified = true
    else if (item === '--apply') flags.apply = true
    else if (item.startsWith('--')) {
      const key = item.slice(2)
      const value = args[++i]
      if (value === undefined) {
        console.error(`参数 ${item} 缺值`)
        process.exitCode = 2
        return { flags, rest }
      }
      if (key === 'limit') flags.limit = Number(value)
      else if (key === 'tags') {
        flags.tags = String(value).split(/[,，]/).map(tag => tag.trim()).filter(Boolean)
      } else if (Object.prototype.hasOwnProperty.call(flags, key)) {
        flags[key] = value
      } else {
        console.error(`未知参数：${item}`)
      }
    }
    else rest.push(item)
  }
  return { flags, rest }
}

function shortDate(value) {
  return value ? String(value).slice(0, 10) : '-'
}

function sourceLabel(source) {
  if (!source) return '无出处'
  const type = { file: '文件', web: '网络', user: '用户', model: '模型' }[source.type] || source.type
  return `${type}${source.locator ? '·' + source.locator : ''}`
}

const store = createStore(resolveRoot())
const { flags, rest } = parseFlags(argv.slice(1))

function cmdStats() {
  const topics = store.listTopics()
  const total = topics.reduce((sum, t) => sum + t.count, 0)
  const active = topics.reduce((sum, t) => sum + t.activeCount, 0)
  console.log(`库位置：${store.root}`)
  console.log(`主题 ${topics.length} 个 · 条目 ${total} 条（有效 ${active}，归档 ${total - active}）`)
  for (const topic of topics) {
    const entries = store.readEntries(topic.slug)
    const broken = entries.broken || 0
    const verified = entries.filter(e => e.verified).length
    console.log(
      `  ${topic.name}（${topic.slug}）${topic.count} 条 · 已核实 ${verified}${broken ? ` · 坏行 ${broken}` : ''}`,
    )
  }
}

function cmdTopics() {
  for (const topic of store.listTopics()) {
    console.log(`${topic.name}\t${topic.slug}\t${topic.count} 条\t${topic.description || ''}`)
  }
}

function cmdList() {
  const topicName = flags.topic || rest[0]
  if (!topicName) {
    // 不指定主题就列全部
    for (const topic of store.listTopics()) {
      console.log(`\n# ${topic.name}（${topic.count} 条）`)
      for (const entry of store.readEntries(topic.slug)) {
        if (!flags.all && (entry.status || 'active') !== 'active') continue
        console.log(`  [${entry.id}] ${entry.title}${entry.verified ? ' ✓' : ' ⚠'} ${sourceLabel(entry.source)}`)
      }
    }
    return
  }
  const topic = store.findTopic(topicName)
  if (!topic) {
    console.error(`找不到主题：${topicName}（用 topics 看有哪些）`)
    process.exitCode = 1
    return
  }
  const entries = store
    .readEntries(topic.slug)
    .filter(e => flags.all || (e.status || 'active') === 'active')
  const limit = flags.limit || entries.length
  console.log(`# ${topic.name}（${entries.length} 条${flags.all ? '，含归档' : ''}）`)
  for (const entry of entries.slice(0, limit)) {
    console.log(
      `[${entry.id}] ${entry.title}${entry.verified ? ' ✓已核实' : ' ⚠未核实'} · ${sourceLabel(entry.source)} · v${entry.version || 1} · ${shortDate(entry.updatedAt)}`,
    )
  }
  if (entries.length > limit) console.log(`... 还有 ${entries.length - limit} 条，用 --limit 调整`)
}

function cmdSearch() {
  const query = rest.join(' ').trim()
  if (!query) {
    console.error('用法: kb.mjs search <关键词> [--topic 主题] [--all]')
    process.exitCode = 2
    return
  }
  const topics = flags.all || !flags.topic ? store.listTopics() : [store.findTopic(flags.topic)].filter(Boolean)
  if (!topics.length) {
    console.error(`找不到主题：${flags.topic}`)
    process.exitCode = 1
    return
  }
  const docs = []
  for (const topic of topics) {
    for (const entry of store.readEntries(topic.slug)) {
      if ((entry.status || 'active') !== 'active') continue
      docs.push({ ...entry, topicSlug: topic.slug })
    }
  }
  const hits = rankDocs(docs, query, flags.limit || 5)
  console.log(`检索「${query}」→ 候选 ${docs.length} 条，命中 ${hits.length} 条\n`)
  for (const hit of hits) {
    console.log(`${hit.strength}\t[${hit.score}]\t${hit.title}`)
    console.log(`\t${hit.body}`)
    console.log(`\t出处 ${sourceLabel(hit.source)}${hit.verified ? ' · ✓已核实' : ' · ⚠未核实'} · 主题 ${hit.topic}`)
    console.log('')
  }
  if (!hits.length) console.log('没有命中：换关键词，或用 --all 查全部主题')
}

function cmdShow() {
  const id = rest[0]
  if (!id) {
    console.error('用法: kb.mjs show <id>')
    process.exitCode = 2
    return
  }
  for (const topic of store.listTopics()) {
    const entry = store.readEntries(topic.slug).find(e => e.id === id)
    if (!entry) continue
    console.log(`标题：${entry.title}`)
    console.log(`主题：${topic.name}（${topic.slug}）`)
    console.log(`状态：${entry.status || 'active'} · 版本：v${entry.version || 1} · ${entry.verified ? '✓已核实' : '⚠未核实'}`)
    console.log(`出处：${sourceLabel(entry.source)}${entry.source?.ref ? ' · ' + entry.source.ref : ''}`)
    if (entry.appliesTo) console.log(`适用：${entry.appliesTo}`)
    console.log(`标签：${(entry.tags || []).join(', ') || '无'}`)
    if (entry.q) console.log(`\n问：${entry.q}`)
    console.log(`\n${entry.body}`)
    return
  }
  console.error(`找不到条目：${id}`)
  process.exitCode = 1
}

function cmdAdd() {
  const topicName = flags.topic || rest[0]
  if (!topicName) {
    console.error('用法: kb.mjs add <主题> --title "标题" --body "正文" [--tags a,b] [--verified]')
    process.exitCode = 2
    return
  }
  if (!flags.title || !flags.body) {
    console.error('add 必须同时给 --title 和 --body')
    process.exitCode = 2
    return
  }
  const card = {
    title: flags.title,
    body: flags.body,
    tags: flags.tags,
    kind: flags.kind || 'point',
  }
  if (flags.q) card.q = flags.q
  if (flags['applies-to']) card.appliesTo = flags['applies-to']
  if (flags.verified) card.verified = true
  if (flags['source-type']) {
    card.source = { type: flags['source-type'] }
    if (flags['source-ref']) card.source.ref = flags['source-ref']
    if (flags.locator) card.source.locator = flags.locator
  }
  const result = store.planSave({ topic: topicName, cards: [card], sessionId: null, dryRun: false })
  const written = result.plan
    .map(item => item.title + (item.version > 1 ? ` (v${item.version})` : ''))
    .join('、')
  console.log(`已写入主题「${result.topic}」：${written}（该主题现有 ${result.total} 条）`)
  if (result.related?.length) {
    console.log('相似/冲突提示：')
    for (const related of result.related) {
      console.log(
        `  - [${related.topic}] ${related.title}${related.conflict ? ' ⚠可能是冲突：' + related.note : '（' + related.note + '）'}`,
      )
    }
  }
}

/**
 * 把连续正文重排成面板的块结构（只加换行和项目符号，不改字）。
 * 默认只预览；--apply 才写盘，写前先备份 kb.jsonl。
 */
function cmdReformat() {
  const topics = store.listTopics()
  let changed = 0
  let skipped = 0
  const preview = []
  for (const topic of topics) {
    const entries = store.readEntries(topic.slug)
    for (const entry of entries) {
      const next = formatBody(entry.body)
      if (!next) {
        skipped++
        continue
      }
      changed++
      preview.push({ topic, entry, next })
    }
  }
  const limit = flags.limit || 8
  console.log(`可重排 ${changed} 条，跳过 ${skipped} 条（已有结构 / ①序列 / 无可拆结构）`)
  if (!changed) return
  console.log('')
  for (const item of preview.slice(0, limit)) {
    console.log(`--- [${item.topic.name}] ${item.entry.title}`)
    console.log('  旧: ' + item.entry.body)
    console.log('  新:')
    for (const line of item.next.split('\n')) console.log('      ' + line)
    console.log('')
  }
  if (preview.length > limit) console.log(`（还有 ${preview.length - limit} 条，只列前 ${limit} 条）\n`)
  if (!flags.apply) {
    console.log('这是预览。确认无误后加 --apply 真正写入（写前会自动备份 kb.jsonl）。')
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const topic of topics) {
    const file = path.join(store.root, 'topics', topic.slug, 'kb.jsonl')
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-' + stamp)
  }
  let written = 0
  for (const item of preview) {
    store.updateEntry({
      id: item.entry.id,
      topic: item.topic.slug,
      sessionId: null,
      fields: { body: item.next },
    })
    written++
  }
  console.log(`已重排 ${written} 条（每条版本号 +1）；备份：kb.jsonl.bak-${stamp}`)
}

switch (command) {
  case 'stats':
    cmdStats()
    break
  case 'topics':
    cmdTopics()
    break
  case 'list':
    cmdList()
    break
  case 'search':
    cmdSearch()
    break
  case 'show':
    cmdShow()
    break
  case 'add':
    cmdAdd()
    break
  case 'reformat':
    cmdReformat()
    break
  default:
    console.log(`用法:
  node scripts/kb.mjs stats
  node scripts/kb.mjs topics
  node scripts/kb.mjs list [主题] [--all] [--limit N]
  node scripts/kb.mjs search <关键词> [--topic 主题] [--all] [--limit N]
  node scripts/kb.mjs show <id>
  node scripts/kb.mjs reformat [--apply] [--limit N]   # 正文重排：默认预览，--apply 才写
  node scripts/kb.mjs add <主题> --title "标题" --body "正文" [--tags a,b] [--source-type user|file|web|model] [--source-ref 说明] [--locator p.5] [--applies-to "MySQL 8.0"] [--verified]`)
    if (command) process.exitCode = 2
}

// 学习知识库 · Web UI 的宿主半侧（包的 '.' 入口）
//
// 这一半只做一件事：把知识库暴露成 /kb/api/* 的 JSON 接口。
//
// 为什么 UI/路由占着 '.'、工具反而在 './tools'：
//   宿主扫描浏览器半侧（dsh.client）时只认裸包名 —— exactPackageSpecifier 要求
//   '@scope/name' 恰好两段。行名写成 '@scope/name/ui' 会被判成 undefined 直接跳过，
//   而且不报错，表现就是「侧边栏啥也没有、日志也干净」。所以裸名必须留给
//   带 client bundle 的这一半，工具半侧挪到子路径（子路径行本来就不参与该扫描）。
// 界面（侧边栏图标 + 主面板）在 client/index.js，通过同源 fetch 调这些接口。
//
// 为什么单独一个模块、单独一行 patch：
//   工具（plugin/index.js）挂在「学习模式」预设里，只在学习模式的 agent 作用域内
//   生效；而 webServer 的路由是进程级全局的，(kind, path) 重复注册会直接抛错。
//   如果路由跟着预设走，每开一个学习模式会话就注册一次 → 第二个会话启动即崩。
//   所以路由必须是全局行（patch 里的 learning-kb-ui），与预设无关。
//
// 存储位置：~/.dsh/learn（可用环境变量 DSH_LEARN_ROOT 覆盖），与 plugin/index.js 同一份。

import os from 'node:os'
import path from 'node:path'

import { createStore } from './store.js'
import { rankDocs } from './rank.js'

export const name = 'learning-kb-ui'

export const inject = ['webServer']

/** 路由前缀：和 dsh-pet 的 /dsh-pet-7340 学，插件自己占一段，不污染根路径 */
export const ROUTE_PREFIX = '/kb/api'

/** 请求体上限：手动录入一条知识，1MB 足够，防误发大文件把内存吃满 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 知识库根目录。与 plugin/index.js 里的 resolveRoot 保持一致：
 * DSH_LEARN_ROOT > $DSH_HOME/learn > ~/.dsh/learn。
 * （两处重复 7 行，是为了让 UI 半侧能独立挂载，不 import 工具半侧。）
 */
export function resolveRoot() {
  const override = process.env.DSH_LEARN_ROOT
  if (override && override.trim()) return path.resolve(override.trim())
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'learn')
}

let cachedStore = null

/** 按当前根目录取 store（环境变量变了就重建） */
function store() {
  const root = resolveRoot()
  if (!cachedStore || cachedStore.root !== root) cachedStore = createStore(root)
  return cachedStore
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 写操作的跨站防护。
 *
 * 回环地址上的路由没有额外鉴权（dsh-pet 那类插件同样如此），所以真正的风险不是
 * 「本机别的进程」，而是「浏览器里打开的任意网页偷偷 POST 到 127.0.0.1」。
 * 两道闸：
 *   1) Origin 必须等于本服务的监听源（同源 fetch 会带，跨站页面带的是它自己）；
 *   2) content-type 必须是 application/json —— 普通表单跨站提交带不了这个头，
 *      而要带它就得先过 CORS 预检，预检我们一律不回 CORS 头，于是发不出来。
 * 没有 Origin 的请求放行：本机 curl / 脚本不带这个头，它们本来就能直接读写文件。
 */
function createOriginGuard(getOrigin) {
  return req => {
    const origin = String(req.headers.origin || '')
    if (origin) {
      let self = ''
      try {
        self = getOrigin()
      } catch {
        self = ''
      }
      if (!self || origin !== self) return `跨站写请求被拒绝（Origin: ${origin}）`
    }
    const type = String(req.headers['content-type'] || '')
    if (!type.includes('application/json')) {
      return '写操作要求 content-type: application/json'
    }
    return null
  }
}

function tagList(value) {
  if (Array.isArray(value)) return value.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8)
  return String(value ?? '')
    .split(/[,，;；\s]+/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
}

/** 条目投影：界面要正文，所以正文也发（单条 ≤ 几百字，123 条约 100KB，可接受） */
function projectEntry(entry, slug, topicName) {
  return {
    id: entry.id,
    topic: slug,
    topicName: topicName || slug,
    kind: entry.kind || 'point',
    status: entry.status || 'active',
    title: entry.title,
    q: entry.q || null,
    body: entry.body || '',
    tags: entry.tags || [],
    source: entry.source || null,
    verified: entry.verified ?? false,
    appliesTo: entry.appliesTo || null,
    version: entry.version || 1,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    archivedAt: entry.archivedAt || null,
  }
}

function topicNames() {
  const map = new Map()
  for (const topic of store().listTopics()) map.set(topic.slug, topic.name)
  return map
}

function resolveSlugs(topicParam) {
  const topics = store().listTopics()
  const names = new Map(topics.map(topic => [topic.slug, topic.name]))
  if (topicParam && topicParam !== 'all') return { slugs: [topicParam], names }
  return { slugs: topics.map(topic => topic.slug), names }
}

function handleOverview() {
  const topics = store().listTopics()
  const total = topics.reduce((sum, topic) => sum + topic.count, 0)
  const activeTotal = topics.reduce((sum, topic) => sum + topic.activeCount, 0)
  return {
    root: store().root,
    defaultTopic: store().getDefaultTopic(),
    total,
    activeTotal,
    archivedTotal: Math.max(0, total - activeTotal),
    topics: topics.map(topic => ({
      slug: topic.slug,
      name: topic.name,
      description: topic.description,
      keywords: topic.keywords,
      count: topic.count,
      activeCount: topic.activeCount,
      archivedCount: Math.max(0, topic.count - topic.activeCount),
      updatedAt: topic.updatedAt,
    })),
  }
}

function handleEntries(params) {
  const topicParam = String(params.get('topic') || '').trim()
  const status = String(params.get('status') || 'active').trim()
  const tag = String(params.get('tag') || '').trim()
  const kind = String(params.get('kind') || '').trim()
  const { slugs, names } = resolveSlugs(topicParam)
  const rows = []
  let brokenLines = 0
  for (const slug of slugs) {
    const entries = store().readEntries(slug)
    brokenLines += entries.broken || 0
    for (const entry of entries) {
      const entryStatus = entry.status || 'active'
      if (status !== 'all' && entryStatus !== status) continue
      if (kind && (entry.kind || 'point') !== kind) continue
      if (tag && !(entry.tags || []).includes(tag)) continue
      rows.push(projectEntry(entry, slug, names.get(slug)))
    }
  }
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const limit = Number(params.get('limit'))
  const sliced = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows
  return {
    topic: topicParam || 'all',
    status,
    tag: tag || null,
    kind: kind || null,
    total: rows.length,
    brokenLines,
    entries: sliced,
  }
}

function handleSearch(params) {
  const query = String(params.get('q') || '').trim()
  if (!query) return { q: '', scope: 'all', poolSize: 0, hits: [] }
  const topicParam = String(params.get('topic') || '').trim()
  const { slugs, names } = resolveSlugs(topicParam)
  const pool = []
  for (const slug of slugs) {
    for (const entry of store().readEntries(slug)) {
      if ((entry.status || 'active') !== 'active') continue
      pool.push({ ...entry, topicSlug: slug })
    }
  }
  const limit = Number(params.get('limit'))
  const wanted = Number.isFinite(limit) && limit > 0 ? Math.min(60, limit) : 30
  const hits = rankDocs(pool, query, wanted).map(hit => ({
    ...hit,
    topicName: names.get(hit.topic) || hit.topic,
    // 正文完整版另取：rankDocs 只给 400 字摘要
    body: (pool.find(entry => entry.id === hit.id)?.body) ?? hit.body,
  }))
  return {
    q: query,
    scope: topicParam || 'all',
    poolSize: pool.length,
    hits,
  }
}

function asId(value) {
  const id = String(value ?? '').trim()
  if (!id) throw new Error('缺少条目 id')
  return id
}

function handleArchive(body) {
  const result = store().deleteEntry({
    id: asId(body.id),
    topic: body.topic ? String(body.topic) : null,
    hard: false,
  })
  return { ok: true, ...result }
}

function handleRestore(body) {
  const result = store().restoreEntry({
    id: asId(body.id),
    topic: body.topic ? String(body.topic) : null,
  })
  return { ok: true, ...result }
}

function handleDelete(body) {
  const result = store().deleteEntry({
    id: asId(body.id),
    topic: body.topic ? String(body.topic) : null,
    hard: true,
  })
  return { ok: true, ...result }
}

function handleAdd(body) {
  const topic = String(body.topic || '').trim()
  if (!topic) throw new Error('缺少主题：手动录入必须先指定主题')
  const title = String(body.title || '').trim()
  const text = String(body.body || '').trim()
  if (!title) throw new Error('标题不能为空')
  if (!text) throw new Error('正文不能为空')
  const card = {
    kind: body.kind === 'qa' ? 'qa' : 'point',
    title,
    body: text,
    q: body.q ? String(body.q).trim() : undefined,
    tags: tagList(body.tags),
    appliesTo: body.appliesTo ? String(body.appliesTo).trim() : null,
    // 手动录入的知识：来源就是用户本人，直接按已核实处理
    source: { type: 'user', ref: String(body.source || '手动录入（Web UI）').trim() },
    verified: body.verified === undefined ? true : !!body.verified,
  }
  const result = store().planSave({ topic, cards: [card], dryRun: false })
  return { ok: true, ...result }
}

const UPDATABLE = ['title', 'body', 'q', 'tags', 'kind', 'appliesTo', 'verified']

function handleUpdate(body) {
  const raw = body.fields && typeof body.fields === 'object' ? body.fields : body
  const fields = {}
  for (const key of UPDATABLE) {
    if (raw[key] === undefined) continue
    fields[key] = key === 'tags' ? tagList(raw[key]) : raw[key]
  }
  if (!Object.keys(fields).length) throw new Error('没有可更新的字段')
  const result = store().updateEntry({
    id: asId(body.id),
    topic: body.topic ? String(body.topic) : null,
    fields,
  })
  return { ok: true, ...result }
}

const POST_ROUTES = {
  '/archive': handleArchive,
  '/restore': handleRestore,
  '/delete': handleDelete,
  '/add': handleAdd,
  '/update': handleUpdate,
}

/**
 * 路由处理器。抽成工厂是为了能在测试里塞一个假的 getOrigin，
 * 不必真的起一个 webServer。
 */
export function createHandler({ getOrigin = () => '' } = {}) {
  const guard = createOriginGuard(getOrigin)
  return async function handler(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { error: '请求路径不合法' })
    }
    const route = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname
    const method = String(req.method || 'GET').toUpperCase()

    try {
      if (method === 'GET' || method === 'HEAD') {
        if (route === '/overview') return sendJson(res, 200, handleOverview())
        if (route === '/entries') return sendJson(res, 200, handleEntries(url.searchParams))
        if (route === '/search') return sendJson(res, 200, handleSearch(url.searchParams))
        return sendJson(res, 404, { error: `未知接口 ${route}` })
      }
      if (method === 'POST') {
        const denied = guard(req)
        if (denied) return sendJson(res, 403, { error: denied })
        const action = POST_ROUTES[route]
        if (!action) return sendJson(res, 404, { error: `未知接口 ${route}` })
        const body = await readBody(req)
        return sendJson(res, 200, action(body))
      }
      return sendJson(res, 405, { error: `不支持的请求方法 ${method}` })
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function apply(ctx) {
  const handler = createHandler({
    getOrigin: () => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return ''
      }
    },
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'learning-kb-ui: /kb/api routes',
  )
}

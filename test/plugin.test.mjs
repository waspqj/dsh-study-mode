// 学习模式 KB 插件 · 插件级自测（node test/plugin.test.mjs）
// 用 mock ctx 跑通：工具注册 → 建主题 → 预览 → 落盘 → 检索 → 更新 → 归档 → 列出。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-plugin-'))
process.env.DSH_LEARN_ROOT = root

const { apply, name, inject } = await import('../plugin/tools.js')

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log('  ok  ' + label)
  } catch (error) {
    console.error('  FAIL ' + label + ': ' + error.message)
    process.exitCode = 1
  }
}

console.log('插件元信息')
await check('导出 name / inject / apply', async () => {
  assert.equal(name, 'learning-kb')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

const registered = new Map()
const approvalCalls = []
let approvalOutcome = 'unavailable'
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  on() {},
  get(name) {
    if (name !== 'approval') return undefined
    return {
      request(payload) {
        approvalCalls.push(payload)
        return Promise.resolve(approvalOutcome)
      },
    }
  },
}
apply(ctx, {})

console.log('工具注册')
await check('注册了 6 个工具', async () => {
  assert.deepEqual(
    Array.from(registered.keys()).sort(),
    ['learn_delete', 'learn_entries', 'learn_save', 'learn_search', 'learn_topics', 'learn_update'],
  )
})
await check('每个工具都有 schema 与 execute', async () => {
  for (const tool of registered.values()) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

const exec = { agent: { id: 'sess-1' } }
const topics = registered.get('learn_topics')
const search = registered.get('learn_search')
const save = registered.get('learn_save')
const update = registered.get('learn_update')
const remove = registered.get('learn_delete')
const entries = registered.get('learn_entries')

console.log('主题管理')
await check('新建主题并绑定当前会话', async () => {
  const result = topics.execute({ action: 'create', name: 'MySQL 进阶', description: '存储引擎与事务', keywords: ['innodb'] }, exec)
  assert.equal(result.current.slug, 'mysql-进阶')
  assert.equal(result.current.count, 0)
})
await check('未绑定会话看不到该主题', async () => {
  const other = topics.execute({ action: 'current' }, { agent: { id: 'sess-2' } })
  assert.equal(other.current, null)
  assert.equal(other.topics.length, 1)
})
await check('按关键词模糊查找主题', async () => {
  const result = topics.execute({ action: 'find', name: 'innodb' }, exec)
  assert.equal(result.found.slug, 'mysql-进阶')
})

console.log('写入：确认闸门')
let entryId = ''
const card = {
  title: '间隙锁',
  body: '间隙锁锁住索引记录之间的间隙，阻止插入。',
  tags: ['lock'],
  source: { type: 'file', ref: '课件第 5 页', locator: 'p.5' },
  appliesTo: 'MySQL 8.0',
}
await check('确认通道不可用时 learn_save 降级为预览、不落盘', async () => {
  const result = await save.execute({ cards: [card] }, exec)
  assert.equal(result.status, 'preview')
  assert.equal(result.dryRun, true)
  assert.equal(result.plan[0].action, 'create')
  assert.equal(entries.execute({}, exec).total, 0, '预览不应写盘')
})
await check('没预览过的内容带 approved=true 会被拒', async () => {
  await assert.rejects(
    () => save.execute({ approved: true, cards: [{ title: '没预览', body: '正文' }] }, exec),
    /还没有预览过/,
  )
})
await check('审批放行时一次调用就写盘', async () => {
  approvalOutcome = 'allowed-once'
  const before = approvalCalls.length
  const result = await save.execute({ cards: [card] }, exec)
  assert.equal(result.status, 'written')
  assert.equal(result.total, 1)
  assert.equal(approvalCalls.length, before + 1, '应弹过一次确认框')
  assert.match(approvalCalls[approvalCalls.length - 1].reason, /间隙锁/, '确认框里应显示卡片标题')
  assert.equal(approvalCalls[approvalCalls.length - 1].toolName, 'learn_save')
  entryId = entries.execute({}, exec).entries[0].id
  approvalOutcome = 'unavailable'
})
await check('用户拒绝时库不落盘', async () => {
  approvalOutcome = 'rejected'
  const before = entries.execute({}, exec).total
  const result = await save.execute({ cards: [{ title: '被拒的卡片', body: '正文' }] }, exec)
  assert.equal(result.status, 'rejected')
  assert.equal(entries.execute({}, exec).total, before, '拒绝后库不能变')
  approvalOutcome = 'unavailable'
})
await check('入库条目带出处类型/核实标记/适用范围', async () => {
  const entry = entries.execute({}, exec).entries[0]
  assert.equal(entry.source.type, 'file')
  assert.equal(entry.source.locator, 'p.5')
  assert.equal(entry.verified, false)
  assert.equal(entry.appliesTo, 'MySQL 8.0')
})
await check('检索命中并带出处', async () => {
  const result = await search.execute({ query: '间隙锁' }, exec)
  assert.equal(result.scope, 'mysql-进阶')
  assert.equal(result.hits[0].title, '间隙锁')
  assert.equal(result.hits[0].source.type, 'file')
  assert.equal(result.hits[0].appliesTo, 'MySQL 8.0')
})
await check('整体库检索也能命中', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'all' }, exec)
  assert.equal(result.scope, 'all')
  assert.equal(result.hits.length, 1)
})
await check('未绑定主题时仍按整体库检索（整体库这一级不跳过），并提示去绑定主题', async () => {
  const result = await search.execute({ query: '间隙锁' }, { agent: { id: 'sess-3' } })
  assert.equal(result.currentTopic, null)
  assert.equal(result.hits.length, 1, '整体库应该能查到')
  assert.match(result.note, /没绑定主题/)
})

await check('scope=auto 标出当前主题的命中', async () => {
  const result = await search.execute({ query: '间隙锁' }, exec)
  assert.equal(result.hits[0].fromCurrent, true)
  assert.equal(result.hits[0].topic, 'mysql-进阶')
})

await check('scope=topic 只查当前主题', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'topic' }, exec)
  assert.equal(result.scope, 'mysql-进阶')
  assert.equal(result.hits.length, 1)
})

await check('scope=auto 当前主题命中不够时用其它主题补齐', async () => {
  const otherExec = { agent: { id: 'sess-other' } }
  topics.execute({ action: 'create', name: '其它主题' }, otherExec)
  const otherCard = { title: '另一种锁', body: '另一种锁的机制说明。' }
  await save.execute({ cards: [otherCard] }, otherExec)
  await save.execute({ approved: true, cards: [otherCard] }, otherExec)
  const result = await search.execute({ query: '另一种锁' }, exec)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].fromCurrent, false)
  assert.equal(result.hits[0].topic, '其它主题')
})

console.log('修改与归档')
await check('更新条目并升版本（版本号 = 时间戳）', async () => {
  const before = entries.execute({}, exec).entries[0].version
  const result = update.execute({ id: entryId, verified: true }, exec)
  assert.ok(result.version >= 1e12, '版本号应该是时间戳：' + result.version)
  assert.ok(result.version > Number(before), '新版本号要比旧的大')
  const entry = entries.execute({}, exec).entries[0]
  assert.equal(entry.verified, true)
})
await check('归档后检索不再返回', async () => {
  const result = remove.execute({ id: entryId }, exec)
  assert.equal(result.mode, 'archived')
  assert.equal((await search.execute({ query: '间隙锁' }, exec)).hits.length, 0)
  assert.equal(entries.execute({ status: 'archived' }, exec).total, 1)
})
await check('归档条目可恢复（再次写入即恢复原条目）', async () => {
  const restored = [{ title: '间隙锁', body: '（恢复）间隙锁阻止插入。' }]
  await save.execute({ cards: restored }, exec) // 先预览
  const result = await save.execute({ approved: true, cards: restored }, exec)
  assert.equal(result.plan[0].action, 'restore')
  assert.equal(entries.execute({ status: 'active' }, exec).total, 1)
  assert.equal(entries.execute({ status: 'archived' }, exec).total, 0)
  assert.equal((await search.execute({ query: '间隙锁' }, exec)).hits.length, 1)
})

console.log('渲染')
await check('预览渲染标注「未写入」', async () => {
  const result = await save.execute({ cards: [{ title: '渲染测试', body: 'x' }] }, exec)
  const rendered = save.output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /预览，未写入/)
})
await check('检索渲染含命中与出处', async () => {
  const result = await search.execute({ query: '间隙锁', scope: 'all' }, exec)
  const rendered = search.output.render({}, result)
  assert.match(rendered[0].text, /间隙锁/)
  assert.match(rendered[0].text, /来源 文件/)
})

await check('设置默认主题后，新会话自动落到它', async () => {
  topics.execute({ action: 'default', name: 'MySQL 进阶' }, exec)
  const fresh = topics.execute({ action: 'current' }, { agent: { id: 'sess-brand-new' } })
  assert.equal(fresh.current.slug, 'mysql-进阶')
  assert.equal(fresh.currentFromDefault, true)
})
await check('清除默认主题', async () => {
  topics.execute({ action: 'default', name: '' }, exec)
  const fresh = topics.execute({ action: 'current' }, { agent: { id: 'sess-brand-new-2' } })
  assert.equal(fresh.current, null)
})

console.log('磁盘落盘')
await check('落盘为 JSONL 且含新字段', async () => {
  const file = path.join(root, 'topics', 'mysql-进阶', 'kb.jsonl')
  assert.ok(fs.existsSync(file))
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  const entry = JSON.parse(lines[0])
  assert.equal(entry.source.type, 'file')
  assert.equal(entry.appliesTo, 'MySQL 8.0')
  assert.equal(entry.status, 'active')
  assert.equal(entry.verified, true)
})

console.log('同主题近似重复检测')
await check('内容相近、标题不同 → 疑似重复提示', async () => {
  const dedupeExec = { agent: { id: 'sess-dedupe' } }
  topics.execute({ action: 'create', name: '去重测试主题' }, dedupeExec)
  const first = { title: '间隙锁要点', body: '间隙锁锁住索引记录之间的间隙，阻止其他事务插入新行。' }
  await save.execute({ cards: [first] }, dedupeExec)
  await save.execute({ approved: true, cards: [first] }, dedupeExec)
  const second = { title: '间隙锁要点补充', body: '间隙锁锁住索引记录之间的间隙，阻止其他事务插入新行。' }
  const result = await save.execute({ cards: [second] }, dedupeExec)
  assert.ok(result.similar.length >= 1, "应识别出同主题的相近内容")
  assert.equal(result.similar[0].title, '间隙锁要点')
  assert.ok(Array.isArray(result.nearby), "应返回同主题相关条目清单")
})

await check('内容不相近 → 不报疑似重复', async () => {
  const dedupeExec = { agent: { id: 'sess-dedupe' } }
  const result = await save.execute({ cards: [{ title: '完全另一件事', body: '讲的是缓冲池刷脏页的机制，跟锁没有关系。' }] }, dedupeExec)
  assert.equal(result.similar.length, 0)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

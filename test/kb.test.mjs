// 学习模式知识库 · 存储层自测 v2（node test/kb.test.mjs）
// 覆盖：主题元数据与模糊查找、会话绑定、dryRun 预览/落盘、同标题更新、
//       结构化 source、verified/appliesTo、跨主题相似与冲突、更新/归档/删除、
//       条目过滤、并发写保护、读取缓存。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore, normalizeSource, normalizeTitle, slugify } from '../plugin/store.js'
import { jaccard, rankDocs, tokenize, tokenSet } from '../plugin/rank.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-test-'))
const store = createStore(root)

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL ' + name + ': ' + error.message)
    process.exitCode = 1
  }
}

console.log('slug / 归一化')
check('中文主题保留', () => assert.equal(slugify('InnoDB 事务'), 'innodb-事务'))
check('标点被清理', () => assert.equal(slugify('MySQL 8.0 入门!'), 'mysql-80-入门'))
check('标题归一化忽略标点空格', () => {
  assert.equal(normalizeTitle('Redo Log， 两阶段提交'), normalizeTitle('redo log 两阶段提交'))
})
check('字符串来源被猜成类型', () => {
  assert.equal(normalizeSource('https://x.dev/a').type, 'web')
  assert.equal(normalizeSource('课件第 3 页.pdf').type, 'file')
  assert.equal(normalizeSource('用户口述').type, 'user')
})
check('结构化来源原样保留', () => {
  const source = normalizeSource({ type: 'file', ref: 'MySQL进阶/113.png', locator: '第 5 页' })
  assert.equal(source.type, 'file')
  assert.equal(source.locator, '第 5 页')
})

console.log('主题与绑定')
check('创建主题并带描述/关键词', () => {
  const slug = store.createTopic('MySQL 进阶', { description: 'InnoDB 与事务', keywords: ['innodb', '锁'] })
  assert.equal(slug, 'mysql-进阶')
  const topic = store.listTopics()[0]
  assert.equal(topic.description, 'InnoDB 与事务')
  assert.deepEqual(topic.keywords, ['innodb', '锁'])
})
check('模糊查找命中关键词', () => {
  assert.equal(store.findTopic('innodb').slug, 'mysql-进阶')
  assert.equal(store.findTopic('锁').slug, 'mysql-进阶')
  assert.equal(store.findTopic('完全无关的东西'), null)
})
check('绑定与会话隔离', () => {
  store.bindTopic('s1', 'mysql-进阶')
  assert.equal(store.currentTopic('s1'), 'mysql-进阶')
  assert.equal(store.currentTopic('s2'), null)
})

console.log('dryRun 与写入')
let redoId = ''
check('dryRun 只预览不落盘', () => {
  const result = store.planSave({
    topic: 'dry-run-专题',
    sessionId: 's1',
    dryRun: true,
    cards: [{ title: 'redo log 两阶段提交', body: 'prepare 写 redo，commit 写 binlog。', tags: ['redo'] }],
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.plan[0].action, 'create')
  assert.equal(store.readEntries('dry-run-专题').length, 0, 'dryRun 不应写盘')
  assert.ok(
    !fs.existsSync(path.join(root, 'topics', 'dry-run-专题', 'kb.jsonl')),
    'dryRun 不应创建主题文件',
  )
})
check('dryRun=false 才落盘', () => {
  const result = store.planSave({
    topic: 'mysql-进阶',
    sessionId: 's1',
    dryRun: false,
    cards: [{ title: 'redo log 两阶段提交', body: 'prepare 写 redo，commit 写 binlog。', tags: ['redo'], source: { type: 'file', ref: '课件第 5 页', locator: 'p.5' }, appliesTo: 'MySQL 8.0' }],
  })
  assert.equal(result.dryRun, false)
  assert.equal(result.total, 1)
  const entry = store.readEntries('mysql-进阶')[0]
  redoId = entry.id
  assert.equal(entry.source.type, 'file')
  assert.equal(entry.appliesTo, 'MySQL 8.0')
  assert.equal(entry.verified, false)
})
check('同标题再次写入变为更新且不重复', () => {
  const result = store.planSave({
    topic: 'mysql-进阶',
    sessionId: 's1',
    dryRun: false,
    cards: [{ title: 'redo log 两阶段提交', body: '（修订）prepare 写 redo。' }],
  })
  assert.equal(result.plan[0].action, 'update')
  assert.equal(result.plan[0].version, 2)
  assert.equal(result.total, 1)
})

console.log('跨主题相似与冲突')
check('写入间隙锁卡片', () => {
  const result = store.planSave({
    topic: 'mysql-进阶',
    sessionId: 's1',
    dryRun: false,
    cards: [{ title: '间隙锁', body: '间隙锁锁住索引记录之间的间隙，阻止插入。', tags: ['lock'] }],
  })
  assert.equal(result.plan[0].action, 'create')
})
check('其它主题的同名条目会被提示', () => {
  store.createTopic('InnoDB 专题', { description: '锁与日志' })
  const result = store.planSave({
    topic: 'InnoDB 专题',
    sessionId: 's2',
    dryRun: true,
    cards: [{ title: '间隙锁', body: '间隙锁锁住索引记录之间的间隙，阻止插入。' }],
  })
  assert.ok(result.related.length >= 1, '应提示其它主题的相近条目')
  assert.equal(result.related[0].topic, 'mysql-进阶')
})
check('标题相同正文差异大 → 判为冲突', () => {
  const result = store.planSave({
    topic: 'InnoDB 专题',
    sessionId: 's2',
    dryRun: true,
    cards: [{ title: 'redo log 两阶段提交', body: 'InnoDB 崩溃恢复依赖 redo 与 binlog 的一致性，5.7 走 prepare 阶段两阶段提交。' }],
  })
  const conflict = result.related.find(item => item.conflict)
  assert.ok(conflict, '应检测到冲突')
  assert.equal(conflict.topic, 'mysql-进阶')
})

console.log('检索')
const docs = () =>
  ['mysql-进阶', 'InnoDB 专题'].flatMap(slug =>
    store.readEntries(slug).map(entry => ({ ...entry, topicSlug: slug })),
  )
check('中文 bigram 能召回', () => {
  const hits = rankDocs(docs(), '间隙锁是什么', 3)
  assert.ok(hits.length > 0)
})
check('精确整句命中排在第一', () => {
  const hits = rankDocs(docs(), 'redo log', 3)
  assert.equal(hits[0].title, 'redo log 两阶段提交')
  assert.equal(hits[0].strength, 'strong')
})
check('不相关查询不返回噪声', () => {
  assert.equal(rankDocs(docs(), '量子计算 拓扑 编译', 3).length, 0)
})
check('分词：中文出 bigram，英文出词', () => {
  const tokens = tokenize('Redo Log 间隙锁')
  assert.ok(tokens.includes('redo'))
  assert.ok(tokens.includes('log'))
  assert.ok(tokens.includes('间隙'))
  assert.ok(tokens.includes('隙锁'))
})
check('Jaccard 相似度合理', () => {
  assert.equal(jaccard(tokenSet('间隙锁'), tokenSet('间隙锁')), 1)
  assert.equal(jaccard(tokenSet('间隙锁'), tokenSet('量子计算')), 0)
})

console.log('更新 / 归档 / 过滤')
check('更新条目并升版本', () => {
  const result = store.updateEntry({ id: redoId, fields: { verified: true, appliesTo: 'MySQL 5.7 / 8.0' } })
  assert.equal(result.version, 3)
  const entry = store.readEntries('mysql-进阶').find(item => item.id === redoId)
  assert.equal(entry.verified, true)
  assert.equal(entry.appliesTo, 'MySQL 5.7 / 8.0')
})
check('归档后不再参与检索', () => {
  const result = store.deleteEntry({ id: redoId })
  assert.equal(result.mode, 'archived')
  const entry = store.readEntries('mysql-进阶').find(item => item.id === redoId)
  assert.equal(entry.status, 'archived')
})
check('列出条目可按状态过滤', () => {
  const active = store.listEntries({ topic: 'mysql-进阶' })
  assert.equal(active.total, 1, '间隙锁仍活跃')
  const archived = store.listEntries({ topic: 'mysql-进阶', status: 'archived' })
  assert.equal(archived.total, 1)
  const all = store.listEntries({ topic: 'mysql-进阶', status: 'all' })
  assert.equal(all.total, 2)
})

console.log('并发保护与缓存')
check('读后被外部改过则拒绝写入', () => {
  const file = path.join(root, 'topics', 'mysql-进阶', 'kb.jsonl')
  const realStatSync = fs.statSync
  let counter = 0
  let armed = false
  // 模拟：另一个人在「读完」与「写入」之间改了文件（首次 stat 之后文件就变了）
  fs.statSync = (target, ...rest) => {
    const stat = realStatSync(target, ...rest)
    if (armed && String(target) === file) {
      counter++
      if (counter >= 2) return { ...stat, mtimeMs: stat.mtimeMs + 5000 }
    }
    return stat
  }
  armed = true
  try {
    assert.throws(
      () =>
        store.planSave({
          topic: 'mysql-进阶',
          sessionId: 's1',
          dryRun: false,
          cards: [{ title: '新卡片', body: '正文' }],
        }),
      /被其他会话改过/,
    )
  } finally {
    armed = false
    fs.statSync = realStatSync
  }
})
check('外部改动会被下次读取看到（合并而非覆盖）', () => {
  const file = path.join(root, 'topics', 'mysql-进阶', 'kb.jsonl')
  fs.appendFileSync(file, JSON.stringify({ id: 'x', title: '外部写入', body: '别的会话写的' }) + '\n')
  const entries = store.readEntries('mysql-进阶')
  assert.ok(entries.some(entry => entry.title === '外部写入'))
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

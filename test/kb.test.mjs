// 学习模式知识库 · 存储层自测 v2（node test/kb.test.mjs）
// 覆盖：主题元数据与模糊查找、会话绑定、dryRun 预览/落盘、同标题更新、
//       结构化 source、verified/appliesTo、跨主题相似与冲突、更新/归档/删除、
//       条目过滤、并发写保护、读取缓存。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore, normalizeSource, normalizeTitle, slugify } from '../plugin/store.js'
import { jaccard, rankDocs, tokenize, tokenSet, createRanker } from '../plugin/rank.js'

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
  // 版本号规则（2026-10-23）：写入时刻的时间戳，不是自增整数
  assert.ok(result.plan[0].version >= 1e12, '版本号应该是时间戳：' + result.plan[0].version)
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
// 2026-10-22 用户实测反馈：「每次问一个问题都会有好多个根本没有关联的卡片」。
// 根因是疑问词 bigram（什么/么是/什么是）当内容词参与打分 —— 任何带「什么」
// 的条目都能进榜。下面两条把这个行为钉住。
check('疑问词不参与打分：只靠「什么」不该进榜', () => {
  const corpus = [
    { id: 'lru', title: '什么是LRU cache', body: 'LRU 用哈希表加双向链表实现。', tags: [], topicSlug: 't' },
    { id: 'uf', title: '什么是并查集', body: '并查集支持合并与查询两个操作。', tags: [], topicSlug: 't' },
    { id: 'tx', title: '什么是事务', body: '事务有 ACID 四个特性。', tags: [], topicSlug: 't' },
  ]
  const hits = rankDocs(corpus, '什么是LRU cache', 3)
  assert.deepEqual(hits.map(item => item.id), ['lru'])
})
check('分数远低于最佳分的不进榜', () => {
  const corpus = [
    { id: 'graph', title: '图的理解存储与遍历', body: '邻接矩阵与邻接表。', tags: [], topicSlug: 't' },
    { id: 'engine', title: '存储引擎是可插拔的', body: 'InnoDB 与 MyISAM 可切换。', tags: [], topicSlug: 't' },
  ]
  const hits = rankDocs(corpus, '图的理解存储和遍历是什么样的', 5)
  assert.equal(hits[0].id, 'graph')
  assert.ok(!hits.some(item => item.id === 'engine'), '「存储」一个通用词不该把无关条目带进来')
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
check('更新条目并升版本（版本号 = 时间戳）', () => {
  const before = store.readEntries('mysql-进阶').find(item => item.id === redoId).version
  const result = store.updateEntry({ id: redoId, fields: { verified: true, appliesTo: 'MySQL 5.7 / 8.0' } })
  assert.ok(result.version >= 1e12, '版本号应该是时间戳：' + result.version)
  assert.ok(result.version > Number(before), '新版本号要比旧的大')
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

// 原子写（审计 P0-1）：写到一半失败不能毁掉旧文件，也不能留 .tmp 残渣
check('原子写：正常写完不留 .tmp 残留', () => {
  const slug = '原子写'
  store.planSave({ topic: slug, sessionId: 's-atomic', dryRun: false, cards: [{ title: '卡片A', body: '正文A' }] })
  const leftovers = fs.readdirSync(path.join(root, 'topics', slug)).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.ok(store.readEntries(slug).some(entry => entry.title === '卡片A'))
})
check('原子写：写到一半失败，旧文件完好且清掉 .tmp', () => {
  const slug = '原子写'
  const file = path.join(root, 'topics', slug, 'kb.jsonl')
  const before = fs.readFileSync(file, 'utf8')
  const realWriteFileSync = fs.writeFileSync
  // store 的原子写走 fs.writeFileSync(fd, ...)，只在这条路径上炸
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === 'number') throw new Error('模拟磁盘写满')
    return realWriteFileSync(target, ...rest)
  }
  try {
    assert.throws(
      () =>
        store.planSave({
          topic: slug,
          sessionId: 's-atomic',
          dryRun: false,
          cards: [{ title: '卡片B', body: '正文B' }],
        }),
      /模拟磁盘写满/,
    )
  } finally {
    fs.writeFileSync = realWriteFileSync
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, '旧文件必须一字不差')
  const leftovers = fs.readdirSync(path.join(root, 'topics', slug)).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '失败的临时文件必须清掉')
})

// 跨天备份轮转（审计 P0-2）
check('跨天写入会先留一份日快照', () => {
  const slug = '备份测试'
  store.planSave({ topic: slug, sessionId: 's-bak', dryRun: false, cards: [{ title: '昨天的卡片', body: '昨天写的' }] })
  const file = path.join(root, 'topics', slug, 'kb.jsonl')
  // 把文件时间改成昨天，模拟「跨天了才又动这个主题」
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
  fs.utimesSync(file, yesterday, yesterday)
  const before = fs.readFileSync(file, 'utf8')
  store.planSave({ topic: slug, sessionId: 's-bak', dryRun: false, cards: [{ title: '今天的卡片', body: '今天写的' }] })
  const day = new Date()
  const key =
    day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0')
  const snapshot = path.join(root, 'backups', slug, `kb-${key}.jsonl`)
  assert.ok(fs.existsSync(snapshot), '应该有当天的日快照')
  assert.equal(fs.readFileSync(snapshot, 'utf8'), before, '快照内容 = 跨天前那一刻的内容')
})
check('同一天内反复写不重复备份', () => {
  const slug = '备份测试'
  const dir = path.join(root, 'backups', slug)
  const before = fs.readdirSync(dir).filter(name => /^kb-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).length
  store.planSave({ topic: slug, sessionId: 's-bak', dryRun: false, cards: [{ title: '又一张', body: '还是今天' }] })
  const after = fs.readdirSync(dir).filter(name => /^kb-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).length
  assert.equal(after, before, '同一天不该再堆一份快照')
})
check('日快照最多留 7 份', () => {
  const slug = '备份测试'
  const dir = path.join(root, 'backups', slug)
  // 造 9 天的历史快照，触发一次轮转
  for (let i = 1; i <= 9; i++) {
    const day = `2026-0${i < 10 ? '1' : '2'}-${String(i).padStart(2, '0')}`
    fs.writeFileSync(path.join(dir, `kb-${day}.jsonl`), 'x\n')
  }
  const file = path.join(root, 'topics', slug, 'kb.jsonl')
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
  fs.utimesSync(file, yesterday, yesterday)
  const today = new Date()
  const key =
    today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
  fs.writeFileSync(path.join(dir, `kb-${key}.jsonl`), 'x\n')
  // 再写一次，触发轮转
  store.planSave({ topic: slug, sessionId: 's-bak', dryRun: false, cards: [{ title: '触发轮转', body: '写一下' }] })
  const count = fs.readdirSync(dir).filter(name => /^kb-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).length
  assert.equal(count, 7, '轮转后只应剩 7 份')
})

// 共享检索器（审计 P1-3）：建一次、反复用，结果必须和一次性检索完全一致
check('createRanker 与 rankDocs 结果完全一致', () => {
  const docs = [
    { id: 'a', title: 'InnoDB 事务隔离级别', body: '读已提交 重复读 幻读 可重复读', tags: ['mysql'], q: '隔离级别有哪几种' },
    { id: 'b', title: 'redo log 循环写', body: '物理日志 循环使用 满了就覆盖', tags: ['mysql'], q: 'redo log 是什么' },
    { id: 'c', title: 'MVCC 可见性判断', body: 'ReadView 判断版本可见性', tags: ['mysql'], q: 'MVCC 怎么工作' },
  ]
  const ranker = createRanker(docs)
  for (const query of ['事务隔离级别', 'redo log 是什么', 'MVCC 可见性', '完全对不上的问题']) {
    const a = rankDocs(docs, query, 3).map(h => `${h.id}:${h.score}`).join('|')
    const b = ranker.search(query, 3).map(h => `${h.id}:${h.score}`).join('|')
    assert.equal(b, a, `查询「${query}」结果不一致`)
  }
})
check('createRanker 反复检索互不影响', () => {
  const docs = [
    { id: 'a', title: '间隙锁', body: '范围锁 防止幻读', tags: [] },
    { id: 'b', title: '临键锁', body: '记录锁 + 间隙锁', tags: [] },
  ]
  const ranker = createRanker(docs)
  const first = ranker.search('间隙锁', 2).map(h => h.id)
  const second = ranker.search('间隙锁', 2).map(h => h.id)
  const third = ranker.search('临键锁', 2).map(h => h.id)
  assert.deepEqual(first, second, '同一查询两次结果要一样')
  assert.deepEqual(third, ['b'], '换一个查询结果应该跟着变')
})

// 插件自己的 AI 模型设置（2026-10-23「模型要能切换」）
console.log('插件 AI 模型设置')
check('默认跟随会话', () => {
  const pref = store.getAiModel()
  assert.equal(pref.mode, 'session')
  assert.equal(pref.provider, null)
  assert.equal(pref.model, null)
})
check('可固定到某个模型，且落盘（另开 store 也读得到）', () => {
  const saved = store.setAiModel({
    mode: 'fixed',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  })
  assert.equal(saved.mode, 'fixed')
  assert.equal(saved.provider, 'deepseek-official')
  assert.equal(saved.reasoningEffort, 'low')
  assert.equal(createStore(root).getAiModel().model, 'deepseek-flash', '必须写进 settings.json')
})
check('可改回跟随会话', () => {
  assert.equal(store.setAiModel({ mode: 'session' }).mode, 'session')
  assert.equal(store.getAiModel().provider, null)
  assert.equal(createStore(root).getAiModel().mode, 'session', '改回也要落盘')
})
check('fixed 缺 provider/model 要报错，不能存半截设置', () => {
  assert.throws(() => store.setAiModel({ mode: 'fixed', provider: '', model: 'x' }), /必须同时给出/)
  assert.throws(() => store.setAiModel({ mode: 'fixed', provider: 'p', model: '  ' }), /必须同时给出/)
  assert.equal(store.getAiModel().mode, 'session', '报错后不能留下坏设置')
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

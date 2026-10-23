// 学习模式知识库 · 存储层自测 v2（node test/kb.test.mjs）
// 覆盖：主题元数据与模糊查找、会话绑定、dryRun 预览/落盘、同标题更新、
//       结构化 source、verified/appliesTo、跨主题相似与冲突、更新/归档/删除、
//       条目过滤、并发写保护、读取缓存。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore, normalizeSource, normalizeTitle, slugify } from '../plugin/store.js'
import { jaccard, rankDocs, tokenize, tokenSet, createRanker, splitQuerySegments } from '../plugin/rank.js'

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

// 点名多个方向：2026-10-23 用户实测「STL、智能指针、RAII、C++11 新特性的相关知识点」
// 返回的 10 张卡里一条智能指针、一条 RAII、一条 STL 组件都没有 ——
// 模型把方向改写成更窄的词（STL → vector 迭代器）分头检索，点名的那几条直接被挤出候选池。
console.log('多方向查询：拆开召回再合池')
check('顿号分隔的方向会被拆开，尾部套话要摘掉', () => {
  assert.deepEqual(splitQuerySegments('STL、智能指针、RAII、C++11 新特性的相关知识点'), [
    'STL',
    '智能指针',
    'RAII',
    'C++11 新特性',
  ])
  assert.deepEqual(splitQuerySegments('vector，list'), ['vector', 'list'])
})
check('普通问句不拆（没有分隔符就当一整句）', () => {
  assert.deepEqual(splitQuerySegments('什么是 LRU cache'), [])
  assert.deepEqual(splitQuerySegments('间隙锁是什么'), [])
  assert.deepEqual(splitQuerySegments(''), [])
})
check('只有一个方向时也不拆', () => {
  assert.deepEqual(splitQuerySegments('智能指针、智能指针'), [])
})
check('方向太多就不拆（免得把一句普通问句切碎）', () => {
  assert.deepEqual(splitQuerySegments('a1、a2、a3、a4、a5、a6、a7'), [])
})
check('每个方向用自己的词召回，第一名就是该方向的条目（按方向分批的前提）', () => {
  // 生产路径里 rerankByDirections 就是「每个方向各跑一次 rankDocs」，
  // 所以这里钉住：方向词原样召回时，各自的第一名必须是对应条目。
  const docs = [
    { id: 'stl', title: 'STL 组件与容器分类', body: '容器 迭代器 算法 适配器', tags: ['STL'] },
    { id: 'ptr', title: '智能指针与完美转发', body: 'shared_ptr unique_ptr 引用折叠', tags: ['智能指针'] },
    { id: 'raii', title: 'RAII 资源管理思想', body: '构造获取 析构释放', tags: ['RAII'] },
    { id: 'c11', title: 'C++11 新特性与左值右值', body: '右值引用 移动语义 auto', tags: ['C++11'] },
    { id: 'misc', title: 'C语言与C++的区别', body: '面向过程 面向对象', tags: ['C++'] },
  ]
  const segments = splitQuerySegments('STL、智能指针、RAII、C++11 新特性')
  assert.equal(segments.length, 4)
  const tops = segments.map(seg => rankDocs(docs, seg, 1)[0]?.id)
  assert.deepEqual(tops, ['stl', 'ptr', 'raii', 'c11'], '每个方向的第一名都要是自己的条目')
})

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

console.log('按领域（appliesTo）列清单')
// 2026-10-23 用户踩坑：问「C++ 的常考点」只拿到 tag=C++ 的 34 条，另外 17 条 C++ 相关的
// 被 tag 的精确匹配物理删掉了。领域过滤是这件事的正解，这里把语义钉死。
const domainSlug = store.createTopic('领域测试')
store.planSave({
  topic: domainSlug,
  sessionId: 's-domain',
  dryRun: false,
  cards: [
    { title: '虚函数表', body: '正文', appliesTo: 'C++', tags: ['C++', '多态'], source: { type: 'file', ref: 'a.pdf', locator: 'p.23' } },
    { title: '智能指针', body: '正文', appliesTo: 'C++', tags: ['C++11', '智能指针'], source: { type: 'file', ref: 'a.pdf', locator: 'p.9' } },
    { title: 'C++17 新特性', body: '正文', appliesTo: 'C++17', tags: ['新特性'], source: { type: 'file', ref: 'a.pdf', locator: 'p.11' } },
    { title: '内存对齐', body: '正文', appliesTo: 'C语言', tags: ['C语言', '内存'], source: { type: 'file', ref: 'a.pdf', locator: 'p.7' } },
    { title: 'epoll 原理', body: '正文', appliesTo: '网络', tags: ['epoll'], source: { type: 'file', ref: 'a.pdf', locator: 'p.40' } },
    { title: '没有领域的条目', body: '正文', tags: ['杂项'], source: { type: 'user' } },
  ],
})

check('领域值大小写/空格归一后再比较', () => {
  assert.equal(store.normDomain('  C++  '), 'c++')
  assert.equal(store.normDomain('C ++'), 'c++')
})
check('逗号分隔与数组两种写法等价', () => {
  assert.deepEqual(store.domainNeedles('C++, C语言'), ['c++', 'c语言'])
  assert.deepEqual(store.domainNeedles(['C++', 'C语言']), ['c++', 'c语言'])
  assert.deepEqual(store.domainNeedles(''), [])
  assert.deepEqual(store.domainNeedles(undefined), [])
})
check('appliesTo 传字符串只返回该领域（含同族写法）', () => {
  const res = store.listEntries({ topic: domainSlug, appliesTo: 'C++' })
  // C++ 两条 + C++17 一条（"C++" 包含于 "C++17"，同族单向兼容）
  assert.equal(res.total, 3)
  assert.ok(res.entries.every(e => String(e.appliesTo || '').startsWith('C++')))
})
check('appliesTo 传数组是「任一命中」的并集', () => {
  const res = store.listEntries({ topic: domainSlug, appliesTo: ['C++', 'C语言'] })
  assert.equal(res.total, 4, 'C++ 三条 + C语言 一条')
})
check('未标注领域的条目不会被领域过滤捞出来', () => {
  const res = store.listEntries({ topic: domainSlug, appliesTo: 'C++' })
  assert.ok(!res.entries.some(e => e.title === '没有领域的条目'))
})
check('不传 appliesTo 时行为不变', () => {
  const res = store.listEntries({ topic: domainSlug })
  assert.equal(res.total, 6)
})
check('清单按出处页码排（原始文档顺序）', () => {
  const res = store.listEntries({ topic: domainSlug })
  const pages = res.entries.map(e => store.locatorPage(e.source))
  const known = pages.filter(p => p !== Number.MAX_SAFE_INTEGER)
  assert.deepEqual(known, known.slice().sort((a, b) => a - b), '有页码的必须升序')
})
check('facets 给出领域与标签分布', () => {
  const res = store.listEntries({ topic: domainSlug })
  const cpp = res.facets.appliesTo.find(d => d.value === 'C++')
  assert.equal(cpp.count, 2)
  assert.equal(res.facets.unscoped, 1, '一条没填领域')
  const tag = res.facets.tags.find(t => t.value === 'C++')
  assert.equal(tag.count, 1)
  assert.ok(res.facets.appliesTo.length >= 3)
})

// ---------------------------------------------------------------- 关键词收窄
// 2026-10-23 用户实测：问「STL、智能指针、RAII、C++11 的相关知识点」，
// learn_entries 当时没有任何按文字收窄的口子，模型只能把整个主题列出来
// （实测两个主题 251 条全刷成卡片）。query 就是补这个口子。
check('query 拆词：中英文逗号顿号分号斜杠空白都能分', () => {
  assert.deepEqual(store.queryTerms('STL、智能指针、RAII、C++11'), ['stl', '智能指针', 'raii', 'c++11'])
  assert.deepEqual(store.queryTerms('STL, 智能指针'), ['stl', '智能指针'])
  assert.deepEqual(store.queryTerms('a|b/c d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(store.queryTerms(''), [])
})
check('query 只列沾这些词的条目（命中任一即可）', () => {
  const res = store.listEntries({ topic: domainSlug, query: '智能指针' })
  assert.equal(res.total, 1)
  assert.equal(res.entries[0].title, '智能指针')
})
check('query 多个方向取并集', () => {
  const res = store.listEntries({ topic: domainSlug, query: '智能指针、epoll' })
  assert.equal(res.total, 2)
  assert.ok(res.entries.some(e => e.title === '智能指针'))
  assert.ok(res.entries.some(e => e.title === 'epoll 原理'))
})
check('termStats 报出每个方向各命中几条（0 条 = 库里真没有）', () => {
  const res = store.listEntries({ topic: domainSlug, query: '智能指针、RAII' })
  const stats = Object.fromEntries(res.termStats.map(s => [s.term, s.count]))
  assert.equal(stats['智能指针'], 1)
  assert.equal(stats['raii'], 0, '库里没有 RAII，模型要能据此如实说没有')
  assert.equal(res.terms.length, 2)
})
check('不带 query 时 termStats 为 null（不添乱）', () => {
  const res = store.listEntries({ topic: domainSlug })
  assert.equal(res.termStats, null)
  assert.equal(res.terms, null)
})
check('query 与 appliesTo 可以叠加', () => {
  const res = store.listEntries({ topic: domainSlug, query: '新特性', appliesTo: 'C++' })
  assert.equal(res.total, 1)
  assert.equal(res.entries[0].title, 'C++17 新特性')
})

// ---------------------------------------------------------------- 主题的领域画像
// 定位「内容在哪个主题」用：会话绑的是 mysql-进阶，模型不知道 C++ 在「面试」，
// 就把两个主题都列了一遍（251 张卡）。主题列表里带上领域分布就不用猜了。
check('主题列表带领域分布（模型据此定位该查哪个主题）', () => {
  const topic = store.listTopics().find(t => t.slug === domainSlug)
  const cpp = topic.domains.find(d => d.value === 'C++')
  assert.equal(cpp.count, 2)
  assert.ok(topic.domains.find(d => d.value === '网络'), '其它领域也要在')
})
check('主题列表带标签分布（领域没标的主题靠它认出来）', () => {
  const topic = store.listTopics().find(t => t.slug === domainSlug)
  assert.ok(topic.tags.length > 0)
  assert.ok(topic.tags.every(t => typeof t.value === 'string' && t.count >= 1))
})


// ---------------------------------------------------------------- 跨模块实例
// 2026-10-23 用户实测：「同意，出卡片预览」这个按钮一直失败。
// 根因是提议/批次登记在进程内存里，宿主把两个半侧当成两个模块实例加载时，
// 工具侧登记的提议 UI 侧查不到。改成落盘 .pending.json 之后这里钉死。
check('提议登记能跨模块实例取回（宿主两个半侧各读一份模块）', async () => {
  const inst1 = await import('../plugin/store.js')
  const inst2 = await import('../plugin/store.js?inst=2')
  assert.notEqual(inst1, inst2, '查询串不同必须是两个模块实例，否则这条用例没意义')
  const id = inst1.registerProposal({
    topicArg: '跨实例主题',
    slug: '跨实例主题',
    topicName: '跨实例主题',
    items: [{ title: 'RAII', why: '库里没有' }],
    sessionId: null,
  })
  const back = inst2.getProposal(id)
  assert.ok(back, '另一个实例必须能取回 —— 否则「同意」按钮永远报「已过期」')
  assert.equal(back.items[0].title, 'RAII')
  inst1.dropProposal(id)
  assert.equal(inst2.getProposal(id), null, '作废之后两边都该查不到')
})
check('待写入批次也能跨模块实例取回', async () => {
  const inst1 = await import('../plugin/store.js')
  const inst2 = await import('../plugin/store.js?inst=3')
  const batchId = inst1.registerSaveBatch({
    topicArg: '跨实例主题',
    slug: '跨实例主题',
    cards: [{ title: 'X', body: 'y' }],
    sessionId: null,
  })
  const back = inst2.getSaveBatch(batchId)
  assert.ok(back, '另一个实例要能取到这批卡片，不然「确认写入」也点不动')
  assert.equal(back.cards[0].title, 'X')
  inst1.dropSaveBatch(batchId)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

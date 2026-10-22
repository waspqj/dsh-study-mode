// 正文重排器的断言：结构对不对 + 是不是真的一个字没丢
import assert from 'node:assert/strict'
import { formatBody } from '../plugin/format.js'

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

/**
 * 去掉分隔符和所有空白后的"净字符"：
 * 重排器只允许丢分隔符（；/→）和空白，其余必须一字不差、顺序不变。
 */
function skeleton(text) {
  return String(text).replace(/[；→]/g, '').replace(/\s+/g, '')
}
function formattedSkeleton(text) {
  return String(text)
    .replace(/^- /gm, '')
    .replace(/\s+/g, '')
}

console.log('正文重排（无损）')

await check('并列分号 → 列表项', () => {
  const out = formatBody('优点：A 比 B 快；C 更省内存；D 最简单。')
  assert.equal(out, '- 优点：A 比 B 快\n- C 更省内存\n- D 最简单。')
})

await check('箭头链 → 列表，短引导语单独成行', () => {
  const out = formatBody('按层看：连接层（A）→ 服务层（B）→ 存储引擎层（C）。')
  assert.equal(out, '按层看：\n- 连接层（A）\n- 服务层（B）\n- 存储引擎层（C）。')
})

await check('长引导语不单独成行', () => {
  const out = formatBody('这里先讲连接层和服务层的分工再讲别的→A→B。')
  assert.ok(out.startsWith('- 这里先讲'), '长引导语应留在第一项里')
})

await check('多句 → 段落，段间空行', () => {
  const out = formatBody('第一句。第二句。')
  assert.equal(out, '第一句。\n\n第二句。')
})

await check('括号里的分号不拆', () => {
  const out = formatBody('两个选项（如 A；B）都行；剩下的随便。')
  assert.equal(out, '- 两个选项（如 A；B）都行\n- 剩下的随便。')
})

await check('已有换行的正文不动', () => {
  assert.equal(formatBody('- 已有结构\n- 不动'), null)
})

await check('含 ①②③ 的正文不动（渲染层自己会拆）', () => {
  assert.equal(formatBody('①第一点；②第二点。'), null)
})

await check('没有可拆结构的正文不动', () => {
  assert.equal(formatBody('就一句话，没法拆。'), null)
  assert.equal(formatBody(''), null)
  assert.equal(formatBody(null), null)
})

await check('无损：除分隔符外一个字都不丢、顺序不变', () => {
  const samples = [
    '优点：TRUNCATE 后空间归还操作系统（共享表空间不回收）；性能更好；可用 DATA DIRECTORY 放到其他目录。',
    '按层看：连接层（权限校验）→ 服务层（SQL 接口）→ 存储引擎层（可插拔）。',
    '第一句。第二句含分号：A；B。',
    '无分号无箭头只有一句话。',
  ]
  for (const sample of samples) {
    const out = formatBody(sample)
    if (out === null) continue
    assert.equal(formattedSkeleton(out), skeleton(sample), '重排后丢了字：' + sample)
  }
})

await check('无损：真实库里的样本同样一字不丢', () => {
  const sample =
    'MySQL 8.0 服务器由连接池、服务管理工具与公共组件、NoSQL 接口、SQL 接口、解析器、优化器、缓存、存储引擎、文件系统组成。按层看：连接层（权限校验、保存连接信息、线程池化、限制连接数）→ 服务层（SQL 接口、解析器、优化器、缓存、服务管理组件）→ 存储引擎层（可插拔，负责读写数据）→ 文件系统层（程序以及数据库文件与日志）。外部通过 MySQL Connectors（各编程语言连接器）和 MySQL Shell（高级客户端，可用 JS/Python 调 API）访问。'
  const out = formatBody(sample)
  assert.ok(out, '这条应该能排')
  assert.equal(formattedSkeleton(out), skeleton(sample))
  assert.ok(out.includes('\n- 连接层（'), '层应成为列表项')
})

console.log('')
console.log(passed + ' 项断言通过')
if (process.exitCode) console.error('有失败用例')

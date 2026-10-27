// 生成本次发布的「说明文字」（node scripts/release-notes.mjs）
//
// 为什么要有这个脚本：
//   每次发布要写三处说明 —— git commit 的正文、git tag 的说明、npm 上的更新日志。
//   三处各写一遍必然对不上（改了一处忘了另一处）。所以让它们**都从 CHANGELOG.md 取**：
//   这个脚本把当前版本那一节读出来，三处都用同一份文字。
//
// 用法：
//   node scripts/release-notes.mjs              # 打印当前版本的说明（纯文本，给 commit/tag 用）
//   node scripts/release-notes.mjs --markdown    # 打印 markdown（给 npm/Gitee 发布说明用）
//   node scripts/release-notes.mjs --check       # 只检查 CHANGELOG 是否跟版本对得上（不改东西）
//
// 退出码：0 = 对得上；1 = 对不上（check.mjs 也会查一遍，双保险）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const changelogPath = path.join(root, 'CHANGELOG.md')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const args = process.argv.slice(2)
const markdown = args.includes('--markdown')
const checkOnly = args.includes('--check')

if (!fs.existsSync(changelogPath)) {
  console.error('缺 CHANGELOG.md：每次发布都要更新它（scripts/check.mjs 会卡住没更新的发布）')
  process.exit(1)
}

const text = fs.readFileSync(changelogPath, 'utf8')
const lines = text.split('\n')

/** 找到「## <版本> — <日期>」那一节，返回 {version, date, body}。 */
function findSection(target) {
  const head = /^##\s+(\S+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(head)
    if (!m) continue
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) break
      body.push(lines[j])
    }
    return { version: m[1], date: m[2], body }
  }
  return null
}

const section = findSection(version)

if (!section) {
  console.error(
    `CHANGELOG.md 里没有 ${version} 这一节。\n` +
      `每次发布都要在 CHANGELOG.md 顶部加一节：\n` +
      `  ## ${version} — ${new Date().toISOString().slice(0, 10)}\n` +
      `  ### 用户能感知到的变化\n  ### 为什么改（根因）\n  ### 怎么验的`,
  )
  process.exit(1)
}

// 「用户能感知到的变化」这一节是给用户看的说明；没有它就说明这节写得太敷衍。
const userFacing = /###\s+用户能感知到的变化/.test(section.body.join('\n'))
const verified = /###\s+怎么验的/.test(section.body.join('\n'))

if (!userFacing || !verified) {
  console.error(
    `CHANGELOG.md 的 ${version} 一节不完整：\n` +
      `  ${userFacing ? '✓' : '✗'} 「### 用户能感知到的变化」这一节要写\n` +
      `  ${verified ? '✓' : '✗'} 「### 怎么验的」这一节要写（测试/自检结果）`,
  )
  process.exit(1)
}

if (checkOnly) {
  console.log(`CHANGELOG.md 与版本对得上：${version}（${section.date}）`)
  process.exit(0)
}

/** 抽出「用户能感知到的变化」下面的正文 —— 这就是给用户看的说明。 */
function userFacingBody() {
  const start = section.body.findIndex(line => /###\s+用户能感知到的变化/.test(line))
  const rest = section.body.slice(start + 1)
  const end = rest.findIndex(line => /^###\s+/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

const summary = userFacingBody()

if (markdown) {
  console.log(`## ${version} — ${section.date}\n`)
  console.log(summary)
} else {
  console.log(summary)
}

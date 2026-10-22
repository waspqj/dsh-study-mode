// 学习模式预设 · 一键自检（node scripts/check.mjs）
// 校验：本地插件可加载且导出正确、persona 关键规则没被改掉、工具无重复挂载。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const problems = []

function fail(message) {
  problems.push(message)
}

const patchPath = path.join(root, 'cordis.patch.yml')
const patch = fs.readFileSync(patchPath, 'utf8')

// 1. 本地插件引用必须可解析：优先包名（bundle main），兼容 file:// 绝对地址
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const pkgName = pkg.name
const usesPackageName = patch.includes(`name: '${pkgName}'`)
const urlMatch = patch.match(/name:\s*'(file:\/\/\/[^']+)'/)

if (usesPackageName) {
  // main / '.' 现在是 UI+路由半侧（裸包名必须留给它，浏览器半侧扫描才认），
  // 工具半侧在 './tools' 子路径上 —— 这里验的是工具半侧的导出契约。
  const toolsEntry = pkg.exports && pkg.exports['./tools']
  if (!toolsEntry) {
    fail("package.json 缺 exports['./tools']：预设里的工具行指不到实现")
  } else if (!fs.existsSync(path.join(root, toolsEntry))) {
    fail(`exports['./tools'] 指向的文件不存在：${toolsEntry}`)
  } else {
    await verifyPlugin(pathToFileURL(path.join(root, toolsEntry)).href)
  }
  if (!pkg.main) fail('package.json 缺 main：bundle 入口需要一个明确的半侧')
} else if (urlMatch) {
  const target = fileURLToPath(urlMatch[1])
  if (!fs.existsSync(target)) {
    fail(`插件文件不存在：${target}（工作区位置变了？改成包名引用 ${pkgName} 可免维护）`)
  } else {
    await verifyPlugin(urlMatch[1])
  }
} else {
  fail(`patch 里找不到本地插件引用（应为 name: '${pkgName}'）`)
}

async function verifyPlugin(specifier) {
  try {
    const mod = await import(specifier)
    if (typeof mod.apply !== 'function') fail('插件缺少 apply 导出')
    if (mod.name !== 'learning-kb') fail(`插件 name 应为 learning-kb，实际 ${mod.name}`)
    if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) fail('插件 inject 应包含 tools')
    checkToolSchemas(mod)
  } catch (error) {
    fail(`插件无法加载：${error.message}`)
  }
}

// 工具参数必须是标准 JSON Schema：宿主只按 parameters.properties 投影给模型。
// 用私有 DSL 写（参数名直接摊在顶层、required 是布尔）会让模型看不见参数名，
// 调用时参数被丢掉 —— 表现为 learn_save 一直报「cards 不能为空」。
function checkToolSchemas(mod) {
  const captured = new Map()
  const mockCtx = {
    tools: {
      register(definition) {
        captured.set(definition.name, definition)
        return () => {}
      },
    },
    on() {},
  }
  try {
    mod.apply(mockCtx, {})
  } catch (error) {
    fail(`插件 apply 失败：${error.message}`)
    return
  }
  if (!captured.size) {
    fail('插件没有注册任何工具')
    return
  }
  for (const [toolName, definition] of captured) {
    const schema = definition.parameters
    if (!schema || schema.type !== 'object' || !schema.properties || !Object.keys(schema.properties).length) {
      fail(`工具 ${toolName} 的 parameters 不是标准 JSON Schema（需 {type:"object", properties:{...}}）`)
      continue
    }
    for (const [key, spec] of Object.entries(schema.properties)) {
      if (typeof spec.type !== 'string') fail(`工具 ${toolName}.${key} 缺 type`)
      if (typeof spec.description !== 'string') fail(`工具 ${toolName}.${key} 缺 description`)
      if (typeof spec.required === 'boolean') fail(`工具 ${toolName}.${key} 用了布尔 required`)
    }
    if (schema.required) {
      if (!Array.isArray(schema.required)) {
        fail(`工具 ${toolName} 的 required 必须是数组`)
      } else {
        for (const key of schema.required) {
          if (!(key in schema.properties)) fail(`工具 ${toolName}.required 里的 ${key} 不在 properties 中`)
        }
      }
    }
  }
}

// 2. persona 的关键规则不能被改丢
const required = [
  '素材纪律',
  '模型知识·未验证',
  '不许联网',
  'learn_update',
  'learn_delete',
  'learn_search 就够',
  'scope=auto',
  '写库只用 learn_save',
  '确认框',
]
for (const marker of required) {
  if (!patch.includes(marker)) fail(`persona 缺少关键规则：${marker}`)
}

// 3. 文件工具不要与宿主 dsh-ops 重复挂载
if (patch.includes("'@deepseek-ai/dsh-tool-fs'")) {
  fail('预设里挂了 dsh-tool-fs，会与宿主 dsh-ops 的 ops_* 文件工具重复')
}

// 4. 预设里该有的插件行
for (const row of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-ask-user']) {
  if (!patch.includes(row)) fail(`预设缺少插件行：${row}`)
}

// 5. 工具白名单：学习模式只留「读被指名的文件」这一类
const pluginSource = fs.readFileSync(path.join(root, 'plugin', 'tools.js'), 'utf8')
if (!pluginSource.includes('tools.restrict')) {
  fail('插件没有调用 ctx.tools.restrict：学习模式应限制可用工具，素材纪律要变成机制保证')
}
if (!pluginSource.includes('MUST_KEEP')) {
  fail('插件缺少 MUST_KEEP（宿主 dsh-ops 接管面不变量清单，缺了会导致 READINESS_BLOCKED）')
}
if (!pluginSource.includes('DENY_TOOLS')) {
  fail('插件缺少 DENY_TOOLS')
}
if (pluginSource.includes('KEEP_TOOLS')) {
  fail('插件里还留着旧的 KEEP_TOOLS 白名单：allow 模式会砍掉宿主接管面导致 agent 不可用，必须用 deny')
}
for (const keep of ['ops_replace', 'ops_write_file', 'ops_edit_file', 'ops_diff', 'ops_stat', 'ops_copy', 'ops_move', 'ops_remove']) {
  if (!pluginSource.includes(keep)) fail(`MUST_KEEP 清单缺少 ${keep}：宿主 hide-official 少了它会 READINESS_BLOCKED`)
}

// 6. 知识库 Web UI 的接线：package.json 的 exports/dsh.client、patch 的全局行、两份 bundle 的契约
//    （三处必须同时成立：少一处就是「界面不出现」或「会话一多就撞路由」）
const exportsMap = pkg.exports || {}
for (const key of ['.', './tools', './client']) {
  const target = exportsMap[key]
  if (!target) fail(`package.json 的 exports 缺少 "${key}"：插件行/浏览器半侧会解析不到入口`)
  else if (!fs.existsSync(path.join(root, target))) fail(`exports["${key}"] 指向的文件不存在：${target}`)
}

const clientMeta = pkg.dsh && pkg.dsh.client
if (!clientMeta) fail('package.json 缺 dsh.client：浏览器半侧不会被扫描和注入')
else if (clientMeta.platform !== 'web') fail(`dsh.client.platform 应为 'web'，现在是 ${clientMeta.platform}`)
else if (!Array.isArray(clientMeta.inject)) fail('dsh.client.inject 应该是数组（可以为空）')

let routePrefix = null
const uiEntry = path.join(root, 'plugin', 'index.js')
if (!fs.existsSync(uiEntry)) {
  fail('缺少 plugin/index.js（UI 宿主半侧）：知识库面板没有接口')
} else {
  const uiModule = await import(pathToFileURL(uiEntry).href)
  if (uiModule.name !== 'learning-kb-ui') fail(`plugin/index.js 的 name 应为 learning-kb-ui，现在是 ${uiModule.name}`)
  if (typeof uiModule.apply !== 'function') fail('plugin/index.js 没有导出 apply')
  if (!Array.isArray(uiModule.inject) || !uiModule.inject.includes('webServer')) {
    fail('plugin/index.js 必须 inject webServer')
  }
  routePrefix = uiModule.ROUTE_PREFIX
  if (routePrefix !== '/kb/api') fail(`ROUTE_PREFIX 应为 /kb/api，现在是 ${routePrefix}`)
}

// 全局行必须是顶层 insert（4 空格）；如果被塞进预设（10 空格），
// 每个学习模式会话都会注册同一批路由，第二个会话启动就撞 (kind, path)
if (!/^ {4}- id: learning-kb-ui$/m.test(patch)) {
  fail('patch 缺少顶层（全局）行 learning-kb-ui：路由必须在进程级注册，不能跟着预设走')
}
if (/^ {10}- id: learning-kb-ui$/m.test(patch)) {
  fail('learning-kb-ui 被塞进了预设里：路由重复注册会让第二个学习模式会话崩溃')
}
// 浏览器半侧的扫描只认裸包名：exactPackageSpecifier 要求 @scope/name 恰好两段。
// 写成 '@scope/name/ui' 会被判成 undefined 直接跳过，而且不报错 ——
// 线上表现就是「侧边栏没有图标、日志里也没有任何错误」，排查成本极高。
const bareRow = "name: '" + pkgName + "'"
const uiSubpathRow = "name: '" + pkgName + "/ui'"
const toolsSubpathRow = "name: '" + pkgName + "/tools'"
if (!patch.includes(bareRow)) {
  fail('patch 里 learning-kb-ui 那一行的 name 必须是裸包名 ' + pkgName + '：子路径会让浏览器半侧被静默跳过')
}
if (patch.includes(uiSubpathRow)) {
  fail('patch 里还在用子路径 /ui：子路径行不参与浏览器半侧扫描，侧边栏图标不会出现')
}
if (!patch.includes(toolsSubpathRow)) {
  fail('预设里的工具行应指向 ' + pkgName + '/tools（裸名让给了 UI / 路由半边）')
}
if (exportsMap['./tools'] === undefined) {
  fail('package.json 的 exports 缺少 "./tools"：工具半侧靠它被预设引用')
}
if (!/^ {10}- id: learning-kb$/m.test(patch)) {
  fail('预设的 plugins 里缺少工具行 learning-kb')
}

const toolsEntry = path.join(root, 'plugin', 'tools.js')
if (!fs.existsSync(toolsEntry)) {
  fail('缺少 plugin/tools.js：预设里的工具行没有实现')
} else {
  const toolsModule = await import(pathToFileURL(toolsEntry).href)
  if (toolsModule.name !== 'learning-kb') fail('plugin/tools.js 的 name 应为 learning-kb，现在是 ' + toolsModule.name)
  if (typeof toolsModule.apply !== 'function') fail('plugin/tools.js 没有导出 apply')
  if (!Array.isArray(toolsModule.inject) || !toolsModule.inject.includes('tools')) fail('plugin/tools.js 必须 inject tools')
}

// 包里只能有一个 package.json 边界：plugin/ 或 client/ 下再放一个，
// 宿主的 nearestPackage 会先撞上它（名字对不上就跳过，但这是个不必要的陷阱），
// 而且 clientPath 会按那个目录去算，指到不存在的 client/index.js。
for (const nested of ['plugin', 'client']) {
  const nestedPkg = path.join(root, nested, 'package.json')
  if (fs.existsSync(nestedPkg)) {
    fail(nested + '/package.json 是多余的嵌套包边界：整个插件只应有一个 package.json')
  }
}

const clientEntry = path.join(root, 'client', 'index.js')
if (!fs.existsSync(clientEntry)) {
  fail('缺少 client/index.js：侧边栏图标与主面板不会出现')
} else {
  const clientSource = fs.readFileSync(clientEntry, 'utf8')
  if (!clientSource.includes('window.__ModuleLoader__.load(')) {
    fail('client/index.js 没有走 __ModuleLoader__.load：宿主不会认这个浏览器插件')
  }
  if (!new RegExp(`id:\\s*['"]${pkgName.replace(/[/@]/g, (m) => '\\' + m)}['"]`).test(clientSource)) {
    fail(`client/index.js 的模块 id 必须是包名 ${pkgName}：不一致时浏览器端加载不到`)
  }
  if (!clientSource.includes("'sidebar.panellist'")) {
    fail('client/index.js 没有注册 sidebar.panellist：侧边栏不会多出图标')
  }
  if (!/PANEL_ID\s*=\s*['"]learning-kb['"]/.test(clientSource)) {
    fail('client/index.js 的 PANEL_ID 应为 learning-kb')
  }
  const revMatch = clientSource.match(/const UI_REV = '([^']+)'/)
  if (!revMatch) fail('client/index.js 缺少 UI_REV：界面上看不出页面跑的是哪份 bundle')
  else if (revMatch[1] !== pkg.version) fail(`client/index.js 的 UI_REV (${revMatch[1]}) 与 package.json 的 version (${pkg.version}) 不一致`)
  const apiMatch = clientSource.match(/const API = '([^']+)'/)
  if (!apiMatch) fail('client/index.js 没有声明 API 前缀')
  else if (routePrefix && apiMatch[1] !== routePrefix) {
    fail(`client 的接口前缀 ${apiMatch[1]} 与宿主 ROUTE_PREFIX ${routePrefix} 不一致`)
  }
  // 浏览器端只能 require 宿主已注入的模块：写别的会 404 或解析失败
  const allowed = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  for (const match of clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    if (!allowed.has(match[2])) {
      fail(`client/index.js 里 require('${match[2]}') 不在宿主提供的模块清单里，浏览器会解析失败`)
    }
  }
}

if (problems.length) {
  console.error('自检未通过：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('自检通过：插件可加载且导出正确、工具参数是标准 JSON Schema、persona 关键规则齐全、工具无重复挂载、知识库 UI 三处接线一致。')

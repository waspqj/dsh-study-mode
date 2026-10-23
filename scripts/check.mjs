// 学习模式预设 · 一键自检（node scripts/check.mjs）
// 校验：本地插件可加载且导出正确、persona 关键规则没被改掉、工具无重复挂载。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const problems = []
// 工具 description / 参数说明也进模型的提示词 —— 关键规则可能放在那里
const toolPromptText = []

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
  // 工具的 description / 参数说明也是模型看得见的提示词，
  // 关键规则挪到那里以后，关键规则的检查要一并覆盖（见下方 marker 检查）。
  for (const definition of captured.values()) {
    toolPromptText.push(String(definition.description || ''))
    for (const value of Object.values(definition.parameters?.properties || {})) {
      toolPromptText.push(String(value.description || ''))
      for (const item of value.items?.properties ? Object.values(value.items.properties) : []) {
        toolPromptText.push(String(item.description || ''))
      }
    }
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
  // 2026-10-23：写入改成「先预览、用户点头再写」，persona 必须说清落盘方式
  '确认写入',
  // 2026-10-23：回答里漏出条目 id、把命中列成目录（用户实测「用户想要知道这些编号吗」）
  '不要出现条目 id',
  '先定位、再枚举',
  // 2026-10-23：定位主题靠主题列表里的领域分布（整库倒出来会刷 251 张卡）
  '先 learn_topics',
  // 2026-10-23：提议要显眼（用结构化提问，别埋在正文最后一行）；
  // 「库里有」和「库里没有」要分开写（用户实测：混在一起效果不好）
  'ask_user_question',
  '「库里有」和「库里没有」要分开写',
  // 2026-10-23：回答文本太挤、满屏代码片（用户实测「简直看不下去」）
  '回答排版',
  '不要给普通词套反引号',
  // 分点靠列表而不是散文（软换行会合并成空格），出处标记要跟卡片标题对上
  '分点用 markdown 列表',
  '跟卡片对得上号',
  // 2026-10-23：每个卡片分小点、不省字；工具调用全部做完再写回答（否则被折进过程组），
  // 但也不能因为怕折叠就既不提议也不出卡片
  '一张卡片 = 一个粗体小标题',
  '卡片里没有的内容单独一条小点',
  '工具调用全部做完，最后写回答',
  '别跳过这步直接说「不补」',
  // 2026-10-23：模型把「X、Y 的相关知识点」当成清单题，用 learn_entries 倒出 39 条
  '先分清用户要的是什么',
  '不是枚举题',
  // 2026-10-23：模型把方向改写成更窄的词分头检索，点名的智能指针 / RAII / STL 组件全被挤出候选池
  '不要自己把方向改写成更窄的词',
  // 2026-10-23：主题没标领域时传 appliesTo 会把整个主题清零 → 退化成别处的皮命中
  '传 appliesTo 前先确认这个主题有没有领域',
  // 2026-10-23 用户：领域只用来筛范围性问题，具体问题不许先猜领域
  '具体问题不要传 appliesTo',
  // 2026-10-23：具体问题命中最多 2 条、相关最多 3 条（用户实测「皮命中太多」）
  '具体问题要的是少而准',
  // 2026-10-22：回答里自发补了一张大对照表，用户要求「这类展开只出现在 AI 校验补充里」
  '不许自发改写',
  '对照表',
  '3 句以内',
]
for (const marker of required) {
  // 规则可能在 persona 里，也可能在工具 description 里（同一事实只说一次）
  if (!patch.includes(marker) && !toolPromptText.some(text => text.includes(marker))) {
    fail(`persona 缺少关键规则：${marker}`)
  }
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

// 7. 会话内卡片的三处接线：工具的 presentationMeta、宿主的卡片接口、浏览器的工具视图
//    （少一处就是「对话里没有卡片」或「点了没反应」）
const toolsSource = fs.readFileSync(path.join(root, 'plugin', 'tools.js'), 'utf8')
if (!toolsSource.includes('presentationMeta')) {
  fail('plugin/tools.js 没有 presentationMeta：结构化卡片到不了浏览器（宿主只把 render 的文本发给界面）')
}
if (!toolsSource.includes('kbCards')) {
  fail('plugin/tools.js 的 presentationMeta 没有产出 kbCards：浏览器拿不到卡片数据')
}
// 大模型重排：宿主侧必须真的接上，并且必须带回 kbRelated 与降级原因
if (!toolsSource.includes('rerankHits')) {
  fail('plugin/tools.js 没有调用 rerankHits：检索还是纯文字匹配，同义词永远对不上')
}
if (!toolsSource.includes('kbRelated')) {
  fail('plugin/tools.js 的 presentationMeta 没有产出 kbRelated：相关补充卡片到不了界面')
}
if (!fs.existsSync(path.join(root, 'plugin', 'rerank.js'))) {
  fail('缺少 plugin/rerank.js：重排层没有落点')
}
{
  const rerankSource = fs.readFileSync(path.join(root, 'plugin', 'rerank.js'), 'utf8')
  if (!rerankSource.includes('fallbackSplit')) {
    fail('plugin/rerank.js 没有降级路径：模型抽风时会连卡片一起没了')
  }
  if (!rerankSource.includes("DSH_KB_RERANK")) {
    fail('plugin/rerank.js 没有关闭开关：离线/调试时没法跳过重排')
  }
}
const cardSource = fs.readFileSync(path.join(root, 'plugin', 'card.js'), 'utf8')
if (!cardSource.includes('buildReviewPrompt') || !cardSource.includes('buildAskPrompt')) {
  fail('plugin/card.js 缺少提示词拼装：校验与追问的上下文隔离会失控')
}
if (!fs.existsSync(path.join(root, 'plugin', 'llm.js'))) {
  fail('缺少 plugin/llm.js：隔离的模型调用没有落点')
}
const uiSource = fs.readFileSync(path.join(root, 'plugin', 'index.js'), 'utf8')
for (const route of ['/card/review', '/card/apply', '/card/ask', '/card/verify', '/card/rollback']) {
  if (!uiSource.includes(route)) fail(`plugin/index.js 缺少卡片接口 ${route}`)
}
// 过期卡片：会话里的快照可能已经被别的端改过，界面要提前知道并禁用编辑类按钮
if (!uiSource.includes('/card/versions')) {
  fail('plugin/index.js 缺少 /card/versions：界面没法知道手里这张卡是不是旧版')
}
// 版本号规则（2026-10-23 用户定）：时间戳，回退时连版本号一起回原版
const storeSource = fs.readFileSync(path.join(root, 'plugin', 'store.js'), 'utf8')
for (const bit of ['stampVersion', 'nextVersion', 'originalVersion']) {
  if (!storeSource.includes(bit)) {
    fail(`plugin/store.js 缺少 ${bit}：版本号不是时间戳 / 回退时版本号回不去`)
  }
}
const formatSource = fs.readFileSync(path.join(root, 'plugin', 'format.js'), 'utf8')
for (const bit of ['formatVersion', 'shortVersion']) {
  if (!formatSource.includes(bit)) {
    fail(`plugin/format.js 缺少 ${bit}：时间戳版本号显示不出来`)
  }
}
const llmSource = fs.readFileSync(path.join(root, 'plugin', 'llm.js'), 'utf8')
if (!llmSource.includes("ctx.get('llm')") && !llmSource.includes('ctx.get("llm")')) {
  fail('plugin/llm.js 没有软探测 llm 服务：模型不可用时应该降级，而不是整块插件起不来')
}
// 2026-10-22：模型选择写死过一次，用户切了模型校验还用老的。
// 必须每次调用都去问宿主的 agentDefaultModel，而不是用常量。
if (!llmSource.includes("get('agentDefaultModel')")) {
  fail('plugin/llm.js 没有读宿主的 agentDefaultModel：校验用的模型不会跟当前会话对齐')
}
if (!llmSource.includes('resolveSelection')) {
  fail('plugin/llm.js 缺少 resolveSelection：模型选择无法按调用时解析')
}
// token 用量：必须从 llm.stream 的 usage chunk 里收，界面才有得显示
for (const bit of ['normalizeUsage', 'mergeUsage', "'usage'"]) {
  if (!llmSource.includes(bit)) {
    fail(`plugin/llm.js 缺少 ${bit}：收不到 token 用量，界面上就没法显示花了多少`)
  }
}
// 换模型后不能又变成「模型没有返回内容」：
//   · block-end（整块正文）也要认 —— pi-ai 适配器（MiniMax 走这条）不一定给 text-delta
//   · 只有思考没有正文时，要说清是 maxTokens 被思考吃掉了
for (const bit of ['block-end', 'reasoning-delta', 'noText']) {
  if (!llmSource.includes(bit)) {
    fail(`plugin/llm.js 缺少 ${bit}：思考型模型下会一直「模型没有返回内容」`)
  }
}
if (!uiSource.includes('usage')) {
  fail('plugin/index.js 没把 usage 带出去：校验 / 追问的 token 用量到不了界面')
}
if (!toolsSource.includes('kbTokens')) {
  fail('plugin/tools.js 没把检索重排的用量发出去：搜索那部分花的钱用户看不到')
}
{
  const clientText = fs.readFileSync(path.join(root, 'client', 'index.js'), 'utf8')
  if (!clientText.includes("'tool.call.toolview'")) {
    fail('client/index.js 没有注册 tool.call.toolview：对话里的工具结果不会出现知识卡片')
  }
  for (const key of ['learn_search', 'learn_save', 'learn_entries']) {
    if (!clientText.includes(`key: '${key}'`)) {
      fail(`client/index.js 没有为 ${key} 注册工具卡片视图`)
    }
  }
  if (!clientText.includes('kbCards')) {
    fail('client/index.js 没有读 kbCards：拿不到工具结果里的结构化卡片')
  }
  // 工具行在「过程组」里，答完会被整组隐藏；回答下方那一排才是「答完也能看见」的位置
  if (!clientText.includes("'conversation.chat.turnTail'")) {
    fail('client/index.js 没有注册 conversation.chat.turnTail：答完就看不见卡片了')
  }
  if (!clientText.includes('kbTurnDefinition') || !clientText.includes("events.register(kbTurnDefinition)")) {
    fail('client/index.js 没有注册 kb-cards Turn Definition：回答下方永远拿不到卡片')
  }
  if (!clientText.includes('turnCardsOf')) {
    fail('client/index.js 缺少 turnCardsOf：turnTail 不会去读 turn.data')
  }
  // 时序坑：apply() 可能比 ui-conversation provide 服务更早跑完，这时 ctx.get
  // 拿到的是 undefined。只写 ctx.get 就会静默跳过注册，卡片永远不出现 ——
  // 必须有 ctx.inject(['uiConversation'], …) 这条「等它出现再注册」的路。
  if (!clientText.includes("ctx.inject(['uiConversation']")) {
    fail("client/index.js 没有用 ctx.inject(['uiConversation'], …) 等 uiConversation 就绪：apply 早于服务注册时卡片整块失效")
  }
  if (clientText.includes('useChat(')) {
    fail('client/index.js 还在用 useChat 读 chat snapshot：turn 是 TurnLocation 对象，读不到卡片')
  }
  // 大模型重排：命中 / 相关补充两档，相关补充折叠在命中后面
  if (!clientText.includes('kbRelated')) {
    fail('client/index.js 没有读 kbRelated：相关补充卡片无处显示')
  }
  if (!clientText.includes('kb-related-head')) {
    fail('client/index.js 缺少相关补充的折叠区（kb-related-head）')
  }
  if (!clientText.includes('turnPayloadOf')) {
    fail('client/index.js 仍只取一组卡片：命中和相关补充要分开读')
  }
  // AI 校验面板 / 工作台：按区块排版，不能退回"一行标签一行按钮"的 11.5px 小字
  for (const shape of ['kb-vsec', 'kb-vbtn', 'kb-vsec-desc']) {
    if (!clientText.includes(shape)) {
      fail(`client/index.js 缺少校验面板的分区块样式 ${shape}：用户反馈「太小、分不清楚」`)
    }
  }
  if (clientText.includes('kb-verify-row')) {
    fail('client/index.js 又用回了 kb-verify-row：那是「一行标签一行按钮」的旧样式')
  }
  // 正文编辑框用纯文本：框里不显示 **粗体** / `代码` 这类标记，写回时再合回原标记。
  // 少了 toPlainBody，编辑框又会变成一堆符号；少了 mergeMarkup，看一眼再保存就把标记洗掉了。
  for (const fn of ['toPlainBody', 'mergeMarkup']) {
    if (!clientText.includes(fn)) {
      fail(`client/index.js 缺少 ${fn}：编辑框应显示纯文本，保存时保留未改动行的原标记`)
    }
  }
  // 校验结果缓存：同一张卡、同一版正文、同一个模型重复点开不该再调模型，
  // 但必须留一个「重新校验」的强制重跑入口，否则用户想看新结果时被缓存挡住。
  for (const bit of ['reviewCacheGet', 'reviewCacheSet', 'reviewCacheClear']) {
    if (!clientText.includes(bit)) {
      fail(`client/index.js 缺少 ${bit}：重复点「AI 校验补充」会反复调用大模型`)
    }
  }
  if (!clientText.includes("translate('workRunAgain')")) {
    fail('client/index.js 没有「重新校验」入口：命中缓存后用户没法强制重跑')
  }
  // token 用量 + 「查看当前版本」（要显示改完之后那一版，不是库里旧的）
  for (const bit of ['kb-token-note', 'addTokenUsage', 'workViewCurrent', 'kb-current']) {
    if (!clientText.includes(bit)) {
      fail(`client/index.js 缺少 ${bit}：token 用量 / 查看当前版本没有接线`)
    }
  }
  // 旧版卡片的「AI 校验补充」「编辑」必须禁用（别让用户点下去撞版本冲突的墙）
  for (const bit of ['useCardStale', 'actStaleHint', 'card/versions']) {
    if (!clientText.includes(bit)) {
      fail(`client/index.js 缺少 ${bit}：过期卡片的编辑类按钮没有禁用`)
    }
  }
}

if (problems.length) {
  console.error('自检未通过：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('自检通过：插件可加载且导出正确、工具参数是标准 JSON Schema、persona 关键规则齐全、工具无重复挂载、知识库 UI 三处接线一致。')

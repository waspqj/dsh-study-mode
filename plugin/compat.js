// 跨版本兼容探针
//
// 为什么要有这个文件：
//   插件靠的是 DSH 宿主的一组服务（webServer / tools / llm / agentDefaultModel）。
//   这些名字、方法签名在 DSH 换版本时都可能变，而变的时候**没有任何编译期检查**
//   —— 插件是运行时被 require 进宿主的。出问题的表现偏偏是最难查的那种：插件
//   静静地不生效。侧边栏少一格、面板空白、工具不出现，日志里还未必有东西
//   （2026-10-22 已经在 locale 重复注册上栽过一次）。
//
//   所以这里把「插件到底依赖哪些宿主能力」写成一张显式清单，启动时逐条探测，
//   缺哪条就报哪条，界面直接把结论显示出来。清单本身也是给人看的文档：想知道
//   这个插件挑不挑 DSH 版本，看下面两张表就够了。
//
// 探测原则：
//   1. **只读不写**。探针不去调用会改状态的方法，也不注册任何东西。
//   2. **失败不抛**。任何一步探不到都当成「这条不可用」，绝不让探针把插件带崩。
//   3. **区分必需与降级**。缺 REQUIRED 就没法提供知识库面板；缺 OPTIONAL 只是
//      模型相关功能不可用，读写知识库照常。

/**
 * 从上下文里安全地取一个服务。
 *
 * ctx.get 是「不管 inject 直接读服务表」（Cordis 语义），所以对没写成硬依赖的
 * 服务用它是安全的；但不同版本对未知名字的处理不一样 —— 有的返回 undefined，
 * 有的可能抛 —— 所以两条路都试一遍，取不到就是 null。
 */
function service(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const found = ctx.get(name)
      if (found !== undefined && found !== null) return found
    }
  } catch {
    // 这个版本不认识这个名字（或服务还没就绪）：继续走属性访问兜底
  }
  try {
    const direct = ctx && ctx[name]
    return direct === undefined ? null : direct
  } catch {
    return null
  }
}

/** 某个对象上的方法在不在（探针只需要「能不能调」，不关心它怎么实现）。 */
function hasMethod(target, method) {
  try {
    return Boolean(target && typeof target[method] === 'function')
  } catch {
    return false
  }
}

/**
 * 插件**必需**的宿主能力：缺任何一条，知识库面板/工具就起不来。
 *
 * 每一项的 probe 只做形状检查，不调用业务方法 —— 探针不该有副作用，
 * 也不该因为一次探测就走一遍模型或写一次文件。
 */
export const REQUIRED_HOST_API = [
  {
    id: 'webServer.register',
    label: 'webServer 路由注册（/kb/api/*）',
    probe: (ctx) => hasMethod(service(ctx, 'webServer'), 'register'),
  },
  {
    id: 'webServer.getOrigin',
    label: 'webServer 同源地址',
    probe: (ctx) => hasMethod(service(ctx, 'webServer'), 'getOrigin'),
  },
  {
    id: 'tools.register',
    label: 'tools 工具注册（learn_* 五个工具）',
    probe: (ctx) => hasMethod(service(ctx, 'tools'), 'register'),
  },
]

/**
 * 插件**可选**的宿主能力：缺了只是降级，不该拦着用户用知识库。
 *
 * llm / agentDefaultModel 在代码里本来就是软探测（见 plugin/llm.js 的注释），
 * 所以这里如实标成 optional —— 把「降级」和「坏了」分开，界面才能说对话。
 */
export const OPTIONAL_HOST_API = [
  {
    id: 'llm',
    label: 'llm 模型调用（卡片校验 / 追问 / 检索重排）',
    probe: (ctx) => Boolean(service(ctx, 'llm')),
  },
  {
    id: 'agentDefaultModel',
    label: 'agentDefaultModel 模型对齐（跟会话模型走）',
    probe: (ctx) => Boolean(service(ctx, 'agentDefaultModel')),
  },
]

/**
 * 读宿主发布的版本号。
 *
 * clientModules.release 是 DSH 自己写进每个 boot graph 的「发布身份」
 * （dsh-client-modules 的 package.json version，DSH 各包按同一版本线发布），
 * 所以它等于当前 DSH 的版本号。取不到就返回 null —— 绝不编一个版本出来。
 *
 * 没有用 process.version 或读磁盘上的 package.json：前者是 Node 的版本、
 * 与 DSH 无关；后者要猜安装路径，桌面端和 CLI 端还不一样。
 */
export function probeRuntime(ctx) {
  const modules = service(ctx, 'clientModules')
  const release = modules && modules.release
  const version = release && typeof release.version === 'string' ? release.version : null
  const commit = release && typeof release.commit === 'string' ? release.commit : null
  return { version, commit }
}

/** 跑一条探针，任何异常都归成 false（探针不许把插件带崩）。 */
function runProbe(item, ctx) {
  try {
    return item.probe(ctx) === true
  } catch {
    return false
  }
}

/**
 * 汇总一份兼容报告。纯函数，便于单测：给什么 ctx 就出什么结论。
 *
 * @returns {{
 *   ok: boolean,
 *   missing: string[],
 *   degraded: string[],
 *   runtime: { version: string|null, commit: string|null },
 *   checks: Array<{ id: string, label: string, required: boolean, ok: boolean }>,
 * }}
 */
export function probeCompat(ctx) {
  const checks = []
  for (const item of REQUIRED_HOST_API) {
    checks.push({ id: item.id, label: item.label, required: true, ok: runProbe(item, ctx) })
  }
  for (const item of OPTIONAL_HOST_API) {
    checks.push({ id: item.id, label: item.label, required: false, ok: runProbe(item, ctx) })
  }
  const missing = checks.filter((check) => check.required && !check.ok).map((check) => check.id)
  const degraded = checks.filter((check) => !check.required && !check.ok).map((check) => check.id)
  return {
    // 只有必需项全在才算「可用」；可选缺失走 degraded，不影响 ok
    ok: missing.length === 0,
    missing,
    degraded,
    runtime: probeRuntime(ctx),
    checks,
  }
}

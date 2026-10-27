// 跨版本兼容探针 · 自测（node test/compat.test.mjs）
//
// 探针的价值全在「判断对不对」：它说 ok，插件就得真的能跑；它报缺，缺的就得是
// 真缺。所以这里拿假 ctx 把各种宿主形态都摆一遍 —— 完整的、少 tools 的、
// 只有 llm 的、ctx.get 会抛的、服务是空对象的。
//
// 另外两条不变量单独测：
//   1. 探针**绝不许抛**（它自己炸了不能把插件带崩）；
//   2. 探针**只读**（不能因为探一次就去调业务方法）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 宿主半侧在 import 时就会解析知识库根目录，指到临时目录，别碰本机真库
process.env.DSH_LEARN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-compat-'))

import {
  REQUIRED_HOST_API,
  OPTIONAL_HOST_API,
  probeCompat,
  probeRuntime,
} from '../plugin/compat.js'
import { createHandler } from '../plugin/index.js'

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

/** 一个「什么都齐全」的宿主上下文替身。 */
function fullCtx(overrides = {}) {
  const services = {
    webServer: { register() {}, getOrigin: () => 'http://127.0.0.1:1' },
    tools: { register() {} },
    llm: { stream() {} },
    agentDefaultModel: { currentSelection() {} },
    clientModules: { release: { version: '0.2.1-rc.3', commit: 'be72761' } },
    ...overrides,
  }
  const ctx = {
    get(name) {
      return services[name]
    },
  }
  for (const [key, value] of Object.entries(services)) ctx[key] = value
  return ctx
}

console.log('兼容探针 · 正常宿主')

await check('能力齐全 → ok，不报缺', () => {
  const report = probeCompat(fullCtx())
  assert.equal(report.ok, true)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.degraded, [])
})

await check('运行时版本从 clientModules.release 读', () => {
  const report = probeCompat(fullCtx())
  assert.equal(report.runtime.version, '0.2.1-rc.3')
  assert.equal(report.runtime.commit, 'be72761')
})

await check('checks 覆盖两张清单，且带 required 标记', () => {
  const report = probeCompat(fullCtx())
  const required = report.checks.filter((c) => c.required).map((c) => c.id)
  const optional = report.checks.filter((c) => !c.required).map((c) => c.id)
  assert.deepEqual(required, REQUIRED_HOST_API.map((i) => i.id))
  assert.deepEqual(optional, OPTIONAL_HOST_API.map((i) => i.id))
})

console.log('兼容探针 · 缺能力')

await check('缺 tools → ok=false，missing 只报它', () => {
  const ctx = fullCtx({ tools: undefined })
  const report = probeCompat(ctx)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing, ['tools.register'])
})

await check('缺 llm 只是降级，不影响 ok', () => {
  const ctx = fullCtx({ llm: undefined })
  const report = probeCompat(ctx)
  assert.equal(report.ok, true)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.degraded, ['llm'])
})

await check('缺 agentDefaultModel 也只是降级', () => {
  const ctx = fullCtx({ agentDefaultModel: undefined })
  const report = probeCompat(ctx)
  assert.equal(report.ok, true)
  assert.deepEqual(report.degraded, ['agentDefaultModel'])
})

await check('webServer 在但没 register → 算缺（形状检查，不是只看有没有对象）', () => {
  const ctx = fullCtx({ webServer: { getOrigin: () => '' } })
  const report = probeCompat(ctx)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing, ['webServer.register'])
})

await check('服务是空对象 → 算缺，不是「存在就行」', () => {
  const ctx = fullCtx({ tools: {} })
  assert.equal(probeCompat(ctx).ok, false)
})

console.log('兼容探针 · 异常形态')

await check('ctx 为 null → 不抛，全报缺', () => {
  const report = probeCompat(null)
  assert.equal(report.ok, false)
  assert.equal(report.missing.length, REQUIRED_HOST_API.length)
})

await check('ctx.get 直接抛 → 不抛出去，仍能给出报告', () => {
  const ctx = {
    get() {
      throw new Error('这个版本不认这个名字')
    },
  }
  const report = probeCompat(ctx)
  assert.equal(report.ok, false)
  assert.equal(report.missing.length, REQUIRED_HOST_API.length)
})

await check('ctx.get 抛错但属性可读 → 走属性兜底', () => {
  const ctx = {
    webServer: { register() {}, getOrigin: () => '' },
    tools: { register() {} },
    llm: { stream() {} },
    agentDefaultModel: { currentSelection() {} },
    clientModules: { release: { version: '9.9.9' } },
    get() {
      throw new Error('boom')
    },
  }
  const report = probeCompat(ctx)
  assert.equal(report.ok, true)
  assert.equal(report.runtime.version, '9.9.9')
})

await check('没有 clientModules → 版本是 null，不编一个出来', () => {
  const report = probeRuntime(fullCtx({ clientModules: undefined }))
  assert.equal(report.version, null)
  assert.equal(report.commit, null)
})

await check('clientModules.release 结构不对 → 版本仍是 null', () => {
  assert.equal(probeRuntime(fullCtx({ clientModules: { release: { version: 42 } } })).version, null)
  assert.equal(probeRuntime(fullCtx({ clientModules: {} })).version, null)
})

await check('探针只读：不调用任何业务方法', () => {
  const touched = []
  const spy = (name) => () => {
    touched.push(name)
    return null
  }
  const ctx = fullCtx({
    webServer: { register: spy('webServer.register'), getOrigin: spy('webServer.getOrigin') },
    tools: { register: spy('tools.register') },
    llm: { stream: spy('llm.stream') },
    agentDefaultModel: { currentSelection: spy('agentDefaultModel.currentSelection') },
  })
  probeCompat(ctx)
  assert.deepEqual(touched, [], '探针不该调用业务方法，实际调了：' + touched.join(', '))
})

await check('重复探测结论稳定（无隐藏状态）', () => {
  const ctx = fullCtx()
  assert.deepEqual(probeCompat(ctx), probeCompat(ctx))
})

console.log('兼容探针 · 路由接线（不依赖 DSH 重启）')

/** 最小 res 替身：sendJson 只用到 writeHead / end。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers || {})) {
        this.headers[String(key).toLowerCase()] = value
      }
      return this
    },
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
    },
  }
}

async function callGet(url, ctx) {
  const res = fakeRes()
  const handler = createHandler({ ctx, getOrigin: () => 'http://127.0.0.1:1' })
  await handler({ method: 'GET', url }, res)
  let payload = null
  try {
    payload = JSON.parse(res.body)
  } catch {
    payload = res.body
  }
  return { status: res.statusCode, payload, headers: res.headers }
}

await check('GET /kb/api/compat 返回探针报告', async () => {
  const { status, payload, headers } = await callGet('/kb/api/compat', fullCtx())
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.missing, [])
  assert.equal(payload.runtime.version, '0.2.1-rc.3')
})

await check('缺能力时 /compat 如实报 missing', async () => {
  const { status, payload } = await callGet('/kb/api/compat', fullCtx({ tools: undefined }))
  assert.equal(status, 200)
  assert.equal(payload.ok, false)
  assert.deepEqual(payload.missing, ['tools.register'])
})

await check('未知路由仍然是 404（没把 /compat 之后的路由吞掉）', async () => {
  const { status, payload } = await callGet('/kb/api/nope', fullCtx())
  assert.equal(status, 404)
  assert.match(String(payload.error), /未知接口/)
})

await check('探针不会污染已有接口：/overview 仍正常', async () => {
  const { status, payload } = await callGet('/kb/api/overview', fullCtx())
  assert.equal(status, 200)
  assert.ok(Array.isArray(payload.topics), '/overview 应仍返回 topics 数组')
})

console.log('')
console.log(passed + ' assertions passed')

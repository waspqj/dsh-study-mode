// 学习模式 KB 插件 · 工具 schema 与边界自测（node test/tools-schema.test.mjs）
//
// 这组用例锁的是一次真实故障的根因：工具 parameters 早先写成私有 DSL
// （参数名直接摊在顶层、required 是布尔值），宿主投影给模型时 properties 为空，
// 模型看不见参数名 → 调用时参数被丢掉 → learn_save 一直报「cards 不能为空」，
// 模型换 14 种参数形状盲试。所以这里对 schema 形状做硬断言。
//
// 风格与仓库其它脚本一致：无分号。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'study-kb-schema-'))
process.env.DSH_LEARN_ROOT = root

const { apply, MUST_KEEP, DENY_TOOLS } = await import('../plugin/tools.js')

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

const registered = new Map()
const listeners = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  on(event, listener) {
    listeners.set(event, listener)
  },
}
apply(ctx, {})

const exec = { agent: { id: 'sess-schema' } }
const topics = registered.get('learn_topics')
const search = registered.get('learn_search')
const save = registered.get('learn_save')

console.log('工具参数 schema 必须是标准 JSON Schema')
await check('每个工具的 parameters 形如 {type:"object", properties:{...}}', async () => {
  for (const tool of registered.values()) {
    const schema = tool.parameters
    assert.equal(schema.type, 'object', tool.name + ' 的 parameters.type 应为 object')
    assert.ok(schema.properties, tool.name + ' 缺 properties')
    assert.ok(
      Object.keys(schema.properties).length > 0,
      tool.name + ' 的 properties 为空 —— 模型会看不见任何参数名',
    )
  }
})
await check('每个参数都有 type 与 description', async () => {
  for (const tool of registered.values()) {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.equal(typeof spec.type, 'string', tool.name + '.' + key + ' 缺 type')
      assert.equal(typeof spec.description, 'string', tool.name + '.' + key + ' 缺 description')
    }
  }
})
await check('参数里不能出现布尔 required（标准 JSON Schema 的 required 是顶层数组）', async () => {
  for (const tool of registered.values()) {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.ok(
        typeof spec.required !== 'boolean',
        tool.name + '.' + key + ' 用了布尔 required，会被宿主投影丢掉',
      )
    }
  }
})
await check('顶层 required 是数组，且每一项都在 properties 里', async () => {
  for (const tool of registered.values()) {
    const required = tool.parameters.required
    if (required === undefined) continue
    assert.ok(Array.isArray(required), tool.name + ' 的 required 必须是数组')
    for (const key of required) {
      assert.ok(key in tool.parameters.properties, tool.name + '.required 里的 ' + key + ' 不在 properties 中')
    }
  }
})
await check('learn_save.cards 的 items 也是标准对象 schema', async () => {
  const items = save.parameters.properties.cards.items
  assert.equal(items.type, 'object')
  assert.ok(items.properties.title, 'cards.items 缺 title')
  assert.ok(items.properties.body, 'cards.items 缺 body')
  assert.deepEqual(items.required, ['title', 'body'])
})
await check('learn_save 的 cards 是唯一必填项', async () => {
  assert.deepEqual(save.parameters.required, ['cards'])
})

console.log('learn_save 入参健壮性')
await check('先建一个主题供后面的写入用例使用', async () => {
  topics.execute({ action: 'create', name: '测试主题' }, exec)
  assert.equal(topics.execute({ action: 'current' }, exec).current.slug, '测试主题')
})
await check('cards 传 JSON 字符串也能吃下', async () => {
  const result = await save.execute({ cards: JSON.stringify([{ title: '字符串入参', body: '正文' }]) }, exec)
  assert.equal(result.plan[0].title, '字符串入参')
})
await check('cards 传单个对象也能吃下', async () => {
  const result = await save.execute({ cards: { title: '单对象', body: '正文' } }, exec)
  assert.equal(result.plan[0].title, '单对象')
})
await check('cards 缺失时报错直接说清正确形状', async () => {
  await assert.rejects(() => save.execute({}, exec), /cards 不能为空/)
  await assert.rejects(() => save.execute({ cards: [] }, exec), /cards 不能为空/)
})
await check('卡片缺 body 时报错点名是哪一张', async () => {
  await assert.rejects(() => save.execute({ cards: [{ title: '只有标题的卡' }] }, exec), /只有标题的卡/)
})
await check('cards 是坏 JSON 时报清楚', async () => {
  await assert.rejects(() => save.execute({ cards: 'not json' }, exec), /JSON/)
})

console.log('不该产生的副作用')
await check('learn_topics action=use 遇到不存在的主题会报错，不建空主题', async () => {
  const before = topics.execute({ action: 'list' }, exec).topics.length
  assert.throws(() => topics.execute({ action: 'use', name: '不存在的幽灵主题' }, exec), /不存在/)
  const after = topics.execute({ action: 'list' }, exec).topics.length
  assert.equal(after, before, 'use 不该新建主题')
})
await check('learn_search 指定不存在的主题只给提示，不建空主题', async () => {
  const before = topics.execute({ action: 'list' }, exec).topics.length
  const result = await search.execute({ query: '间隙锁', topic: '不存在的幽灵主题' }, exec)
  assert.equal(result.needTopic, true)
  assert.equal(result.hits.length, 0)
  const after = topics.execute({ action: 'list' }, exec).topics.length
  assert.equal(after, before, '检索不该新建主题')
})
await check('learn_search 指定存在的主题能正常检索', async () => {
  const result = await search.execute({ query: '间隙锁', topic: '测试主题' }, exec)
  assert.equal(result.needTopic, undefined)
  assert.equal(result.scope, '测试主题')
})

console.log('工具限制：不能动宿主接管面')
await check('注册了 agent/created 监听', async () => {
  assert.ok(listeners.get('agent/created'), '应注册 agent/created 监听')
})

await check('deny 列表绝不包含 ops_* / pwsh / MUST_KEEP 里的工具', async () => {
  for (const name of DENY_TOOLS) {
    assert.ok(!name.startsWith('ops_'), `ops_ 系列不能被限制：${name}`)
    assert.notEqual(name, 'pwsh', 'pwsh 属于 dsh-ops 接管面')
    assert.ok(!MUST_KEEP.includes(name), `MUST_KEEP 里的工具不能被限制：${name}`)
  }
})

await check('MUST_KEEP 覆盖宿主 hide-official 要求的 8 个 OPS 替身', async () => {
  const required = ['ops_replace', 'ops_write_file', 'ops_edit_file', 'ops_diff', 'ops_stat', 'ops_copy', 'ops_move', 'ops_remove']
  for (const name of required) {
    assert.ok(MUST_KEEP.includes(name), `MUST_KEEP 缺 ${name}`)
  }
})

await check('实际限制时不会砍掉接管面（模拟宿主调用）', async () => {
  const applied = []
  const fakeTools = {
    get(name) {
      return { name }
    },
    restrict(filter) {
      applied.push(filter)
      return () => applied.pop()
    },
  }
  listeners.get('agent/created').call({ ctx: { tools: fakeTools } })
  assert.equal(applied.length, 1, '应调用了一次 restrict')
  const deny = applied[0].deny
  for (const name of MUST_KEEP) assert.ok(!deny.includes(name), `${name} 不该被限制`)
})

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项断言通过`)

// 学习知识库 Web UI · 最小 React 替身（从 client.test.mjs 抽出来共用）
//
// 浏览器半侧由宿主注入 react，本机 profile 没装 —— 这里自己写一个最小的替身：
// createElement / useState / useEffect / useRef / useCallback / useMemo，
// 加上「跑一遍渲染 → 执行 effect → 等异步 → 状态变了再渲染」的小循环。
// 抽出来是为了让 ux.test.mjs 能用**真实知识库数据**渲染界面做体检。

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------- 最小 React
function makeReact() {
  const flatten = (list, out = []) => {
    for (const item of list) {
      if (Array.isArray(item)) flatten(item, out)
      else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
    }
    return out
  }

  // 每个组件实例一个 hook 帧：不能全局共用一个数组 —— 组件挂载/卸载会让
  // 光标错位，A 组件的 useState 会被 B 组件读到（真实 React 里靠 fiber 隔离）。
  const frames = new Map()
  const instanceCounts = new Map()
  let currentFrame = null
  let dirty = false
  let pending = []
  let expanded = null

  function enterFrame(id) {
    let frame = frames.get(id)
    if (!frame) {
      frame = { values: [], deps: [], cleanup: [], cursor: 0 }
      frames.set(id, frame)
    }
    frame.cursor = 0
    const previous = currentFrame
    currentFrame = frame
    return () => {
      currentFrame = previous
    }
  }

  const slot = () => {
    if (!currentFrame) throw new Error('hook 在组件外被调用')
    return currentFrame.cursor++
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: flatten(children) }
    },
    useState(initial) {
      const frame = currentFrame
      const index = slot()
      if (!(index in frame.values)) {
        frame.values[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(frame.values[index]) : next
        if (!Object.is(value, frame.values[index])) {
          frame.values[index] = value
          dirty = true
        }
      }
      return [frame.values[index], set]
    },
    useRef(initial) {
      const frame = currentFrame
      const index = slot()
      if (!(index in frame.values)) frame.values[index] = { current: initial }
      return frame.values[index]
    },
    useCallback(fn) {
      slot()
      return fn
    },
    useMemo(factory) {
      slot()
      return factory()
    },
    useEffect(fn, deps) {
      const frame = currentFrame
      const index = slot()
      const previous = frame.deps[index]
      const changed =
        !previous ||
        !deps ||
        previous.length !== deps.length ||
        deps.some((dep, position) => !Object.is(dep, previous[position]))
      if (changed) {
        frame.deps[index] = deps
        pending.push({ frame, index, fn })
      }
    },
    /**
     * useLayoutEffect：真实 React 里在**绘制前**同步跑。
     *
     * 界面用它来「保持视口」——展开更多卡片时把滚动位置还原回去，
     * 否则用户点一下就被弹到底部（2026-10-26 用户反馈）。
     * 这个替身里跟 useEffect 一样入队（渲染后执行），效果上够用。
     */
    useLayoutEffect(fn, deps) {
      const frame = currentFrame
      const index = slot()
      const previous = frame.deps[index]
      const changed =
        !previous ||
        !deps ||
        previous.length !== deps.length ||
        deps.some((dep, position) => !Object.is(dep, previous[position]))
      if (changed) {
        frame.deps[index] = deps
        pending.push({ frame, index, fn })
      }
    },
  }

  function reset() {
    instanceCounts.clear()
    dirty = false
    pending = []
  }

  function expand(node) {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(expand).filter((item) => item !== null)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anonymous'
      const ordinal = instanceCounts.get(name) || 0
      instanceCounts.set(name, ordinal + 1)
      const props = { ...node.props, children: node.children.length === 1 ? node.children[0] : node.children }
      const restore = enterFrame(name + '#' + ordinal)
      try {
        return expand(node.type(props))
      } finally {
        restore()
      }
    }
    return { tag: node.type, props: node.props, children: expand(node.children) }
  }

  function stringify(node) {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(stringify).join('')
    const attrs = [
      'className',
      'title',
      'placeholder',
      'value',
      'type',
      'id',
      'width',
      'height',
      'viewBox',
      'fill',
      'stroke',
      'disabled',
    ]
      .filter((key) => node.props[key] !== undefined && node.props[key] !== '' && node.props[key] !== false)
      .map((key) => `${key}=${JSON.stringify(node.props[key])}`)
      .join(' ')
    return `<${node.tag}${attrs ? ' ' + attrs : ''}>${stringify(node.children)}</${node.tag}>`
  }

  /** 跑一轮渲染 + effect，状态变了就再来一轮（最多 12 轮） */
  async function run(component, props = {}) {
    for (let pass = 0; pass < 12; pass++) {
      reset()
      expanded = expand(React.createElement(component, props))
      const jobs = pending
      pending = []
      for (const job of jobs) {
        const previous = job.frame.cleanup[job.index]
        if (typeof previous === 'function') previous()
        const cleanup = job.fn()
        job.frame.cleanup[job.index] = typeof cleanup === 'function' ? cleanup : null
      }
      await sleep(8)
      if (!dirty) break
    }
    return { html: stringify(expanded), tree: expanded }
  }

  return {
    React,
    run,
    /** 丢掉所有 hook 帧 = 模拟「重新挂载」，用来测初始化状态 */
    forget() {
      frames.clear()
      reset()
      expanded = null
    },
  }
}

/** 深度优先找第一个满足条件的元素 */
function find(node, predicate) {
  if (!node || typeof node === 'string') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.children, predicate)
}

/** 深度优先找全部满足条件的元素 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

/** 元素内的纯文本（展开后的 children 是数组，要递归拼） */
function textOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

export { makeReact, find, findAll, textOf, sleep }

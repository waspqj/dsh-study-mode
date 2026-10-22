// 网络可达性探针（node scripts/probe-network.mjs）
//
// 为什么有这个脚本：
//   2026-10-22 本会话里 web_fetch 连续报
//     web fetch failed: TypeError: fetch failed
//   现象像“工具坏了”，实际是**网络层没拿到响应**。`TypeError: fetch failed`
//   是 undici 对网络层失败的统一包装，而 dsh-tool-web 把 error.cause
//   （ENOTFOUND / ETIMEDOUT / 证书错误）丢掉了，所以看起来像 bug。
//
// 实测结论（2026-10-22，本机，每条至少 2 次）：
//   raw.githubusercontent.com 的**首次请求经常挂死到超时，重试就成功**：
//     第 1 次  timeout 15s
//     第 2 次  200 18868B / 286ms
//   同一 URL 连续两次结果不一样 —— 是“首次连接被打断”的网络现象，不是工具 bug。
//   控制组：cdn.jsdelivr.net / github.com / api.github.com / registry.npmjs.org /
//   example.com / baidu.com 都是首次即 200；pbs.twimg.com 是真连不上（持续超时）。
//
// 以后碰上的处理顺序：
//   1. **重试一次**（大多数情况第二次就成）；
//   2. 还不行就换镜像：GitHub 原始文件走
//      https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>（实测首次 200）；
//   3. 还不行就别纠缠，改读本地源码（DSH 自己的代码都在 app.asar 里）。
//
// 用法：node scripts/probe-network.mjs [额外 URL ...]

const TARGETS = [
  'https://example.com',
  'https://www.baidu.com',
  'https://github.com',
  'https://api.github.com',
  'https://raw.githubusercontent.com',
  'https://registry.npmjs.org',
  'https://cdn.jsdelivr.net',
  'https://pbs.twimg.com',
]

const urls = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS
const TIMEOUT_MS = 8000

for (const url of urls) {
  const started = Date.now()
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    console.log(String(response.status).padEnd(4) + String(Date.now() - started).padStart(6) + 'ms  ' + url)
  } catch (error) {
    const cause = error && error.cause
    const detail = cause
      ? [cause.code, cause.errno, cause.syscall, cause.hostname && '@' + cause.hostname].filter(Boolean).join(' ')
      : ''
    console.log('ERR ' + String(Date.now() - started).padStart(6) + 'ms  ' + url + '  | ' + error.message + (detail ? ' | cause: ' + detail : ''))
  }
}

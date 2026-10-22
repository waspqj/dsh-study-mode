/**
 * 学习知识库 · Web UI 的浏览器半侧
 *
 * 形态：侧边栏「学习知识库」图标 → 主面板（左主题、右条目、顶部搜索）。
 * 数据来自宿主半侧 plugin/ui.js 的 /kb/api/*（同源 fetch）。
 *
 * 为什么手写、不走构建：
 *   插件包是 link: 进 profile 的，没有打包步骤。宿主只给浏览器注入
 *   window.__ModuleLoader__，可 require 的只有 react / react-dom /
 *   @deepseek-ai/dsh-client-ui-primitives 这几个宿主已加载的模块。
 *   所以这里不写 JSX、不 import 组件库，用 React.createElement + 原生 DOM，
 *   样式用 DSH 的主题 CSS 变量，跟随明暗主题。
 *
 * 注册方式照 dsh-context：同一个 id 同时用作 sidebar.panellist 的 id
 * 和 main 的 key —— 侧边栏按钮点下去就切到这张主面板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-study-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // 加载纪律：整块主体包进 try/catch。浏览器半侧抛错时，宿主只会让这个插件"消失"
    // （侧边栏那一格直接没了，控制台也不一定有人看），排查成本极高。所以这里
    // 兜一层：失败就换成"故障面板"，仍然占住那一格，把错误原文显示在面板里。
    let fault = null
    let ReactFace = null
    try {
      ReactFace = require('react')
    } catch (error) {
      fault = describeError(error)
    }
    if (!fault) {
      try {
        install(ReactFace, exports)
      } catch (error) {
        fault = describeError(error)
      }
    }
    if (fault) {
      if (typeof console !== 'undefined') console.error('[learning-kb] 加载失败：' + fault)
      installFault(ReactFace, exports, fault)
    }
    return module.exports

    // 注意：下面这一整块比上一级多缩进了两级以外的缩进保持原样（未重新对齐），
    // 只做了「包进函数」这一件事，避免大范围改动引入新风险。
    function install(React, exports) {
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /** 面板 id：panellist 的 id 与 main 的 key 必须是同一个 */
    const PANEL_ID = 'learning-kb'
    /** UI 版本号：与 package.json 的 version 一致（check.mjs 会断言），一眼看出页面跑的是哪份 bundle */
    const UI_REV = '0.3.14'

    /** 接口前缀，与 plugin/ui.js 的 ROUTE_PREFIX 一致 */
    const API = '/kb/api'
    /** 侧边栏排位：插件(0) 插件市场(1) 自动化任务(10) 上下文洞察(20) → 知识库(30) */
    const PANEL_ORDER = 30

    // ---------------------------------------------------------------- 词典
    // 值必须是字符串：locale 字典不支持函数，带参数的话术在组件里拼。
    const DICT = {
      zh: {
        title: '学习知识库',
        searchPlaceholder: '搜索关键词：标题 / 正文 / 标签',
        allTopics: '全部主题',
        refresh: '刷新',
        add: '新增',
        addTitle: '新增一条知识',
        fieldTopic: '主题',
        fieldKind: '类型',
        fieldTitle: '标题',
        fieldQ: '问题（问答卡片才填）',
        fieldBody: '要点 / 正文',
        fieldTags: '标签（逗号分隔）',
        save: '保存',
        cancel: '取消',
        kindPoint: '要点',
        kindQa: '问答',
        statusActive: '活跃',
        statusArchived: '已归档',
        statusAll: '全部',
        loading: '正在读取…',
        emptyTopic: '这个主题还没有条目',
        emptyAll: '知识库还是空的',
        emptySearch: '没有命中，换个关键词试试',
        unverified: '未核实',
        archivedTag: '已归档',
        archive: '归档',
        restore: '恢复',
        remove: '删除',
        confirmRemove: '确认删除？',
        removeHint: '删除不可恢复；只想藏起来请用「归档」',
        archivedNote: '归档后不进检索，可随时恢复',
        open: '展开详情',
        close: '关闭',
        sourceLabel: '来源',
        savedCreate: '已新增',
        savedUpdate: '已更新同名条目',
        savedRestore: '已恢复同名条目',
        saveFailed: '保存失败',
        noTopic: '还没有主题：先在「学习模式」会话里建一个，或点「新增」直接输入主题名',
        newTopic: '新建主题（输入名称）',
        expand: '展开',
        collapse: '收起',
        rootPath: '存储位置',
        needTopic: '请先选主题或输入主题名',
        needTitle: '标题不能为空',
        needBody: '正文不能为空',
        searchScope: '检索只覆盖活跃条目',
      },
      en: {
        title: 'Knowledge Base',
        searchPlaceholder: 'Search title / body / tags',
        allTopics: 'All topics',
        refresh: 'Refresh',
        add: 'Add',
        addTitle: 'New entry',
        fieldTopic: 'Topic',
        fieldKind: 'Kind',
        fieldTitle: 'Title',
        fieldQ: 'Question (Q&A only)',
        fieldBody: 'Body',
        fieldTags: 'Tags (comma separated)',
        save: 'Save',
        cancel: 'Cancel',
        kindPoint: 'Point',
        kindQa: 'Q&A',
        statusActive: 'Active',
        statusArchived: 'Archived',
        statusAll: 'All',
        loading: 'Loading…',
        emptyTopic: 'No entries in this topic yet',
        emptyAll: 'The knowledge base is empty',
        emptySearch: 'No hit, try another keyword',
        unverified: 'unverified',
        archivedTag: 'archived',
        archive: 'Archive',
        restore: 'Restore',
        remove: 'Delete',
        confirmRemove: 'Confirm delete?',
        removeHint: 'Delete is permanent; use Archive to hide it instead',
        archivedNote: 'Archived entries stay out of retrieval and can be restored',
        open: 'Open details',
        close: 'Close',
        sourceLabel: 'Source',
        savedCreate: 'Created',
        savedUpdate: 'Updated the entry with the same title',
        savedRestore: 'Restored the entry with the same title',
        saveFailed: 'Save failed',
        noTopic: 'No topics yet: create one in a learning-mode session first',
        newTopic: 'New topic name',
        expand: 'Expand',
        collapse: 'Collapse',
        rootPath: 'Storage',
        needTopic: 'Pick a topic first',
        needTitle: 'Title is required',
        needBody: 'Body is required',
        searchScope: 'Search only covers active entries',
      },
    }

    // ---------------------------------------------------------------- 样式
    const CSS = `
.kb-root{--kb-surface:var(--kb-panel-bg,var(--dsw-alias-bg-base));display:flex;flex-direction:column;height:100%;min-height:0;background:var(--kb-surface);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.kb-head{display:flex;align-items:center;gap:8px;padding:12px 16px 8px;flex:none}
.kb-head h2{margin:0;font-size:15px;font-weight:600}
.kb-path{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60ch}
.kb-grow{flex:1 1 auto;min-width:0}
.kb-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 9px;cursor:pointer;white-space:nowrap}
.kb-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-btn.primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:500}
.kb-btn.primary:hover{opacity:.9}
.kb-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-btn.danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.kb-btn:disabled{opacity:.45;cursor:default}
.kb-search{display:flex;align-items:center;gap:8px;padding:0 16px 10px;flex:none;flex-wrap:wrap}
.kb-input,.kb-select,.kb-textarea{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 9px;outline:none}
.kb-input:focus,.kb-select:focus,.kb-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.kb-search .kb-input{flex:1 1 220px;min-width:140px}
.kb-textarea{resize:vertical;min-height:84px;font-family:inherit}
.kb-body{display:flex;flex:1 1 auto;min-height:0;border-top:1px solid var(--dsw-alias-border-l1)}
.kb-rail{flex:0 0 168px;overflow:auto;padding:8px 6px;background:var(--kb-rail-bg,var(--dsw-alias-bg-layer-1));border-right:1px solid var(--dsw-alias-border-l1)}
.kb-topic{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);overflow:hidden}
.kb-topic:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-topic.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.kb-topic .kb-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-topic .kb-n{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kb-list{flex:1 1 auto;min-width:0;overflow:auto;padding:10px 16px 28px}
.kb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:stretch}
@media (max-width:820px){.kb-grid{grid-template-columns:minmax(0,1fr)}}
.kb-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:6px}
.kb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 16px}
.kb-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;padding:6px 16px}
.kb-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px 6px;background:var(--kb-rail-bg,var(--dsw-alias-bg-layer-1));cursor:pointer;transition:border-color .12s ease,background .12s ease}
.kb-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-card.archived{opacity:.72}
.kb-card-head{display:flex;align-items:center;gap:5px;min-width:0}
.kb-card-title{flex:1 1 auto;min-width:0;font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-badge{flex:none;font-size:10px;line-height:1.6;padding:0 4px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.kb-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.kb-badge.idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary)}
.kb-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kb-q{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-text{margin-top:3px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.kb-tags{display:flex;gap:4px;margin-top:4px;overflow:hidden;max-height:18px}
.kb-tag{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:0 4px}
.kb-card-foot{display:flex;align-items:center;gap:6px;margin-top:4px;padding-right:76px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.kb-rev{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.8;font-variant-numeric:tabular-nums;margin-right:2px}
.kb-score{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kb-card-acts{position:absolute;right:5px;bottom:4px;display:flex;gap:4px;padding:2px 3px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent);opacity:0;pointer-events:none;transition:opacity .12s ease}
.kb-card:hover .kb-card-acts,.kb-card:focus-within .kb-card-acts{opacity:1;pointer-events:auto}
.kb-mini{font:inherit;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 6px;cursor:pointer;white-space:nowrap}
.kb-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-mini.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-mini.danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.kb-mini:disabled{opacity:.45;cursor:default}
.kb-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.58);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.kb-modal{--kb-surface:var(--kb-modal-bg,var(--dsw-alias-bg-overlay,#fff));display:flex;flex-direction:column;width:min(920px,94vw);height:auto;max-height:88vh;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;background:var(--kb-surface)}
.kb-modal-head{display:flex;align-items:flex-start;gap:8px;padding:16px 20px 8px}
.kb-modal-title{flex:1 1 auto;min-width:0;font-size:18px;font-weight:600;line-height:1.4;word-break:break-word}
.kb-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 20px 14px}
.kb-modal-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.kb-modal-q{font-size:13.5px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;word-break:break-word}
.kb-modal-text{font-size:14.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
.kb-blocks{word-break:break-word}
.kb-p{margin:0 0 9px;white-space:pre-wrap}
.kb-p:last-child{margin-bottom:0}
.kb-blocks>.kb-p:first-child{font-size:15.5px;font-weight:600;line-height:1.65;margin:0 0 15px;color:var(--dsw-alias-label-primary)}
.kb-list{margin:0 0 9px;padding:0;list-style:none}
.kb-li{display:flex;gap:8px;align-items:flex-start;margin:0 0 7px}
.kb-li-marker{flex:none;min-width:16px;color:var(--dsw-alias-brand-primary);font-weight:700}
.kb-li-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;line-height:1.8}
.kb-quote{margin:0 0 10px;padding:7px 10px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:0 6px 6px 0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.kb-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--kb-surface,var(--dsw-alias-bg-base)));border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--kb-surface,var(--dsw-alias-bg-base)));color:var(--dsw-alias-label-primary)}
.kb-strong{font-weight:700}
mark.kb-hl-run{background:transparent;color:inherit;padding:0 1px;text-decoration:underline;text-decoration-color:var(--dsw-alias-state-warn-primary);text-decoration-thickness:2px;text-underline-offset:3px;text-decoration-skip-ink:none}
.kb-more{color:var(--dsw-alias-label-secondary)}
.kb-modal-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--kb-modal-bg,var(--dsw-alias-bg-overlay))}
.kb-modal-foot .kb-btn{font-size:13px;padding:5px 12px}
.kb-modal-meta{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kb-form{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}
.kb-form label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kb-form .kb-row{display:flex;gap:8px}
.kb-form .kb-row > label{flex:1 1 0;min-width:0}
.kb-form-foot{display:flex;gap:8px;align-items:center}
`

    /**
     * 弹窗底色：把主题 token 的半透明颜色算成**真正不透明**的实色。
     *
     * 为什么不能直接用 token：这个皮肤（open-sea-skin）下 bg-base / layer-1 /
     * overlay 都可能带 alpha，因为它们的设计用途是“叠在壁纸上的提亮层”。
     * 一层层叠上去依然透光（2026-10-22 用户两次反馈“还是太透明”）。
     *
     * 做法：探针 span 把 token 解析成 rgba，再按明暗两侧压平成 rgb。
     * alpha=1 时原样返回；否则与近黑 / 近白混合，得到不透明但色相一致的实色。
     */
    const SOLID_VAR = '--kb-modal-bg'

    /** canvas 上下文（惰性创建）：把任意色彩空间转成真实 RGBA 时用。 */
    let colorCanvasCtx = null

    function getColorCtx() {
      if (colorCanvasCtx !== null) return colorCanvasCtx
      try {
        colorCanvasCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      } catch {
        colorCanvasCtx = false
      }
      return colorCanvasCtx
    }

    /**
     * 任意 CSS 颜色字符串 → [r, g, b, a]。
     * 主题 token 可能是 rgb()/rgba()，也可能是 oklch()/color(srgb …) 这类新色彩空间；
     * 只认 rgba() 的话，后者的 alpha 会直接丢掉，底色压不实（面板就一直透光）。
     * 所以先走正则快速路径，再拿 canvas 画一像素读回来做兜底。
     */
    function parseColor(raw) {
      const text = String(raw || '').trim()
      if (!text) return null
      const matched = text.match(/rgba?\(([^)]+)\)/)
      if (matched) {
        const nums = matched[1]
          .split(/[,\s/]+/)
          .map((value) => parseFloat(value))
          .filter((value) => !Number.isNaN(value))
        if (nums.length >= 3) return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1]
      }
      const ctx = getColorCtx()
      if (!ctx) return null
      try {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = '#000000'
        ctx.fillStyle = text
        ctx.fillRect(0, 0, 1, 1)
        const data = ctx.getImageData(0, 0, 1, 1).data
        if (data[3] === 0) return [data[0], data[1], data[2], 0]
        return [data[0], data[1], data[2], data[3] / 255]
      } catch {
        return null
      }
    }

    function flattenToken(token) {
      if (typeof document === 'undefined' || !document.body) return null
      let probe = null
      try {
        probe = document.createElement('span')
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0'
        probe.style.color = `var(${token})`
        document.body.appendChild(probe)
        const raw = (typeof getComputedStyle === 'function' ? getComputedStyle(probe).color : '') || ''
        const rgba = parseColor(raw)
        if (!rgba) return null
        const [r, g, b] = rgba
        const alpha = rgba[3]
        if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`
        const light = r + g + b > 384
        const base = light ? [250, 250, 252] : [22, 23, 27]
        const mix = (channel, under) => Math.round(channel * alpha + under * (1 - alpha))
        return `rgb(${mix(r, base[0])}, ${mix(g, base[1])}, ${mix(b, base[2])})`
      } catch {
        return null
      } finally {
        if (probe && probe.parentNode) probe.parentNode.removeChild(probe)
      }
    }

    function applySolidSurface() {
      if (typeof document === 'undefined' || !document.documentElement) return
      const overlay = flattenToken('--dsw-alias-bg-overlay')
      const layer1 = flattenToken('--dsw-alias-bg-layer-1')
      const layer2 = flattenToken('--dsw-alias-bg-layer-2')
      const base = flattenToken('--dsw-alias-bg-base')
      if (overlay || layer1) document.documentElement.style.setProperty(SOLID_VAR, overlay || layer1)
      if (base) document.documentElement.style.setProperty('--kb-panel-bg', base)
      if (layer1) document.documentElement.style.setProperty('--kb-rail-bg', layer1)
      if (layer2) document.documentElement.style.setProperty('--kb-chip-bg', layer2)
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      applySolidSurface()
      if (!document.head) return
      let el = document.getElementById('kb-style')
      if (!el) {
        el = document.createElement('style')
        el.id = 'kb-style'
        document.head.appendChild(el)
      }
      // 必须每次覆盖内容：宿主热重载时模块是新的、DOM 里的 <style> 还是旧的，
      // 只判断 “id 已存在就 return” 会让新样式永远不生效（2026-10-22 踩过：
      // 改了两轮「不透明」用户还说透，因为旧样式标签一直没被换掉）。
      if (el.textContent !== CSS) el.textContent = CSS
    }

    // ---------------------------------------------------------------- 数据
    async function apiGet(path, params, signal) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const query = search.toString()
      const res = await fetch(`${API}${path}${query ? '?' + query : ''}`, {
        signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`)
      return json
    }

    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`)
      return json
    }

    function fmtTime(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    // ---------------------------------------------------------------- 图标
    function BookIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
        h('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }),
      )
    }

    // ---------------------------------------------------------------- 条目卡片
    function Badge(props) {
      return h('span', { className: 'kb-badge' + (props.tone ? ' ' + props.tone : '') }, props.children)
    }

    /** 卡片上按钮要吞掉点击，否则会连带把详情浮层打开 */
    function withStop(fn) {
      return (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        fn()
      }
    }

    // ---------------------------------------------------------------- 正文解析
    // 极简 Markdown 子集：段落、列表（- / • / ① / 1.）、行内枚举、**粗体**、`代码`、> 引用、【高亮】。
    // 纯函数，不碰 React，方便直接单测；渲染时切成节点，不用 innerHTML（没有 XSS 面）。

    /** 行内标记：粗体 / 代码 / 高亮。代码优先切，免得代码里的星号被当成粗体。 */
    function parseInline(text) {
      const runs = []
      const codePattern = /`([^`]+)`/g
      let last = 0
      let match
      while ((match = codePattern.exec(text))) {
        if (match.index > last) runs.push(...parsePlain(text.slice(last, match.index)))
        runs.push({ text: match[1], code: true })
        last = match.index + match[0].length
      }
      if (last < text.length) runs.push(...parsePlain(text.slice(last)))
      return runs.length ? runs : [{ text: '' }]
    }

    /** 【高亮】优先于粗体切分，【】里的内容不再解释别的标记。 */
    function parsePlain(text) {
      const runs = []
      const hlPattern = /【([^】]+)】/g
      let last = 0
      let match
      while ((match = hlPattern.exec(text))) {
        if (match.index > last) runs.push(...splitBold(text.slice(last, match.index)))
        runs.push({ text: match[1], hl: true })
        last = match.index + match[0].length
      }
      if (last < text.length) runs.push(...splitBold(text.slice(last)))
      return runs
    }

    function splitBold(text) {
      const runs = []
      const boldPattern = /\*\*([^*]+)\*\*/g
      let last = 0
      let match
      while ((match = boldPattern.exec(text))) {
        if (match.index > last) runs.push({ text: text.slice(last, match.index) })
        runs.push({ text: match[1], bold: true })
        last = match.index + match[0].length
      }
      if (last < text.length) runs.push({ text: text.slice(last) })
      return runs
    }

    /** 行首的「术语：解释」——术语短且无标点时就加粗，纯渲染、不改数据。 */
    const LEAD_TERM = /^([^，。；、：:]{1,12})[：:]/

    function boldLeadTerm(runs) {
      if (!runs.length) return runs
      const first = runs[0]
      if (first.bold || first.code || first.hl) return runs
      const text = String(first.text == null ? '' : first.text)
      const match = LEAD_TERM.exec(text)
      if (!match) return runs
      const term = match[1].trim()
      if (!term) return runs
      const rest = text.slice(match[0].length)
      return [{ text: term, bold: true }, { text: '：' + rest }, ...runs.slice(1)]
    }

    /** 行首是列表记号：- * + • / 1. 1) / ① */
    const LINE_LIST = /^(\s*)([-*+•]|\d{1,2}[.)]|[①-⑳])\s+(.*)$/

    /**
     * 段落里行内连写的枚举（①②③ / 1. 2. 3.）。
     * 存量卡片常常一整段写完，拆出来才有层次；不拆也不会错。
     */
    function enumerationItems(text) {
      const pattern = /[①-⑳]|\d{1,2}[.)、]/g
      const marks = []
      let match
      while ((match = pattern.exec(text))) {
        const marker = match[0]
        const end = match.index + marker.length
        const after = text[end] ?? ''
        // 8.0 这类版本号不是枚举
        if (/^\d/.test(marker) && /^\d/.test(after)) continue
        const before = match.index === 0 ? '' : text[match.index - 1]
        // 记号前面得是边界，否则多半是普通词里带的符号
        if (before !== '' && !/[\s。；，、：:）)]/.test(before)) continue
        marks.push({ marker, start: match.index, end })
      }
      if (marks.length === 0) return null
      if (marks.length === 1 && marks[0].start !== 0) return null
      // 全是数字记号时必须连号，否则可能只是巧合
      if (marks.every((item) => /^\d/.test(item.marker))) {
        for (let i = 1; i < marks.length; i++) {
          const prev = Number(marks[i - 1].marker.match(/^\d+/)[0])
          const cur = Number(marks[i].marker.match(/^\d+/)[0])
          if (cur !== prev + 1) return null
        }
      }
      const items = []
      if (marks[0].start > 0) {
        const head = text.slice(0, marks[0].start).trim()
        if (head) items.push({ marker: '', text: head })
      }
      for (let i = 0; i < marks.length; i++) {
        const next = marks[i + 1]
        items.push({
          marker: marks[i].marker,
          text: text.slice(marks[i].end, next ? next.start : text.length).trim(),
        })
      }
      return items
    }

    /** 正文 → 块序列：p 段落 / list 列表 / quote 引用 */
    function parseBody(text) {
      const blocks = []
      const lines = String(text ?? '').split(/\r\n|\r|\n/)
      let paragraph = []
      let list = null
      const flushParagraph = () => {
        if (paragraph.length === 0) return
        const joined = paragraph.join('\n')
        paragraph = []
        const items = enumerationItems(joined)
        if (items) {
          blocks.push({
            type: 'list',
            items: items.map((item) => ({ marker: item.marker, runs: parseInline(item.text) })),
          })
          return
        }
        blocks.push({ type: 'p', runs: parseInline(joined) })
      }
      const flushList = () => {
        if (list) {
          blocks.push(list)
          list = null
        }
      }
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, '')
        if (!line.trim()) {
          flushParagraph()
          flushList()
          continue
        }
        const quote = /^>\s?(.*)$/.exec(line)
        if (quote) {
          flushParagraph()
          flushList()
          blocks.push({ type: 'quote', runs: parseInline(quote[1]) })
          continue
        }
        const item = LINE_LIST.exec(line)
        const inline = enumerationItems(line)
        if (inline && inline.length > 1) {
          // 一行里连写多个记号（1. … 2. … 3. …）：整行拆成列表，别只吃掉第一个
          flushParagraph()
          flushList()
          blocks.push({
            type: 'list',
            items: inline.map((entry) => ({ marker: entry.marker, runs: parseInline(entry.text) })),
          })
          continue
        }
        if (item) {
          flushParagraph()
          if (!list) list = { type: 'list', items: [] }
          list.items.push({ marker: item[2], runs: parseInline(item[3]) })
          continue
        }
        flushList()
        paragraph.push(line)
      }
      flushParagraph()
      flushList()
      for (const block of blocks) {
        if (block.type === 'list') {
          for (const item of block.items) item.runs = boldLeadTerm(item.runs)
        } else {
          block.runs = boldLeadTerm(block.runs)
        }
      }
      return blocks
    }

    function renderRuns(runs, key) {
      return runs.map((run, index) => {
        const props = { key: key + index }
        if (run.code) {
          props.className = 'kb-code'
          return h('code', props, run.text)
        }
        if (run.hl) {
          props.className = 'kb-hl-run'
          return h('mark', props, run.text)
        }
        if (run.bold) {
          props.className = 'kb-strong'
          return h('strong', props, run.text)
        }
        return h('span', props, run.text)
      })
    }

    /** 详情浮层：完整块结构 */
    function BodyBlocks(props) {
      const blocks = parseBody(props.body)
      return h(
        'div',
        { className: 'kb-blocks' },
        blocks.map((block, index) => {
          const key = 'b' + index + '-'
          if (block.type === 'list') {
            return h(
              'ul',
              { className: 'kb-list', key: 'b' + index },
              block.items.map((item, itemIndex) =>
                h(
                  'li',
                  { className: 'kb-li', key: 'b' + index + 'i' + itemIndex },
                  h('span', { className: 'kb-li-marker' }, /[-*+•]/.test(item.marker) ? '•' : item.marker),
                  h('span', { className: 'kb-li-text' }, renderRuns(item.runs, key + 'i' + itemIndex + '-')),
                ),
              ),
            )
          }
          if (block.type === 'quote') {
            return h('blockquote', { className: 'kb-quote', key: 'b' + index }, renderRuns(block.runs, key))
          }
          return h('p', { className: 'kb-p', key: 'b' + index }, renderRuns(block.runs, key))
        }),
      )
    }

    /** 列表卡片：只取第一块当摘要（第一段或第一条），其余用省略号收尾 */
    function CardBody(props) {
      const blocks = parseBody(props.body)
      if (blocks.length === 0) return null
      const first = blocks[0]
      const runs = first.type === 'list' ? (first.items[0] ? first.items[0].runs : []) : first.runs
      const more = blocks.length > 1 || (first.type === 'list' && first.items.length > 1)
      return h(
        'span',
        { className: 'kb-preview' },
        renderRuns(runs, 'c-'),
        more ? h('span', { className: 'kb-more' }, '…') : null,
      )
    }

    function EntryCard(props) {
      const { entry, t, onOpen, onArchive, onRestore, onDelete, busy, score, coverage } = props
      const [confirming, setConfirming] = useState(false)
      const timer = useRef(null)
      const archived = entry.status === 'archived'

      useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current)
        },
        [],
      )

      const askDelete = () => {
        if (!confirming) {
          setConfirming(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setConfirming(false), 4000)
          return
        }
        if (timer.current) clearTimeout(timer.current)
        setConfirming(false)
        onDelete(entry)
      }

      return h(
        'article',
        {
          className: 'kb-card' + (archived ? ' archived' : ''),
          onClick: () => onOpen(entry),
          role: 'button',
          tabIndex: 0,
          title: t('open'),
        },
        h(
          'div',
          { className: 'kb-card-head' },
          h('span', { className: 'kb-card-title' }, entry.title),
          entry.kind === 'qa' ? h(Badge, null, t('kindQa')) : null,
          entry.verified ? null : h(Badge, { tone: 'warn' }, t('unverified')),
          archived ? h(Badge, { tone: 'idle' }, t('archivedTag')) : null,
        ),
        entry.q ? h('div', { className: 'kb-q' }, 'Q ' + entry.q) : null,
        h('div', { className: 'kb-text' }, h(CardBody, { body: entry.body })),
        entry.tags && entry.tags.length
          ? h(
              'div',
              { className: 'kb-tags' },
              entry.tags.slice(0, 3).map((tag) => h('span', { className: 'kb-tag', key: tag }, tag)),
            )
          : null,
        h(
          'div',
          { className: 'kb-card-foot' },
          typeof score === 'number' ? h('span', { className: 'kb-score' }, 'score ' + score) : null,
          // 版本号放左边：右下角是操作按钮浮现的位置，放右边会与「归档/删除」重合
          h('span', { className: 'kb-score' }, 'v' + entry.version + (entry.updatedAt ? ' · ' + fmtTime(entry.updatedAt) : '')),
          h('span', { className: 'kb-grow' }),
        ),
        h(
          'div',
          { className: 'kb-card-acts' },
          archived
            ? h('button', { className: 'kb-mini', disabled: busy, onClick: withStop(() => onRestore(entry)) }, t('restore'))
            : h(
                'button',
                { className: 'kb-mini', disabled: busy, onClick: withStop(() => onArchive(entry)), title: t('archivedNote') },
                t('archive'),
              ),
          h(
            'button',
            {
              className: 'kb-mini danger',
              disabled: busy,
              onClick: withStop(askDelete),
              title: confirming ? t('removeHint') : t('remove'),
            },
            confirming ? t('confirmRemove') : t('remove'),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 详情浮层
    function EntryModal(props) {
      const { entry, t, busy, score, coverage, onClose, onArchive, onRestore, onDelete } = props
      const [confirming, setConfirming] = useState(false)
      const timer = useRef(null)
      const archived = entry.status === 'archived'

      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        // 每次打开时重算一次：用户可能在两次开关之间切了明暗主题
        applySolidSurface()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          if (timer.current) clearTimeout(timer.current)
        }
      }, [onClose])

      const askDelete = () => {
        if (!confirming) {
          setConfirming(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setConfirming(false), 4000)
          return
        }
        if (timer.current) clearTimeout(timer.current)
        setConfirming(false)
        onDelete(entry)
      }

      const source = entry.source && entry.source.ref ? String(entry.source.ref) : ''
      const stop = (fn) => (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        fn()
      }

      return h(
        'div',
        { className: 'kb-overlay', onClick: onClose },
        h(
          'div',
          { className: 'kb-modal', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'kb-modal-head' },
            h('div', { className: 'kb-modal-title' }, entry.title),
            h('button', { className: 'kb-btn', onClick: onClose }, t('close')),
          ),
          h(
            'div',
            { className: 'kb-modal-body' },
            h(
              'div',
              { className: 'kb-modal-badges' },
              h(Badge, null, entry.kind === 'qa' ? t('kindQa') : t('kindPoint')),
              entry.verified ? null : h(Badge, { tone: 'warn' }, t('unverified')),
              archived ? h(Badge, { tone: 'idle' }, t('archivedTag')) : null,
            ),
            entry.q ? h('div', { className: 'kb-modal-q' }, 'Q ' + entry.q) : null,
            h('div', { className: 'kb-modal-text' }, h(BodyBlocks, { body: entry.body })),
          ),
          h(
            'div',
            { className: 'kb-modal-foot' },
            h(
              'span',
              { className: 'kb-modal-meta' },
              (entry.topicName || entry.topic || '') + ' · v' + entry.version + (entry.updatedAt ? ' · ' + fmtTime(entry.updatedAt) : ''),
            ),
            typeof score === 'number'
              ? h(
                  'span',
                  { className: 'kb-modal-meta' },
                  'score ' + score + (coverage !== undefined ? ' · 覆盖 ' + Math.round(coverage * 100) + '%' : ''),
                )
              : null,
            source ? h('span', { className: 'kb-modal-meta' }, t('sourceLabel') + '：' + source) : null,
            h('span', { className: 'kb-grow' }),
            archived
              ? h('button', { className: 'kb-btn', disabled: busy, onClick: () => onRestore(entry) }, t('restore'))
              : h('button', { className: 'kb-btn', disabled: busy, onClick: () => onArchive(entry) }, t('archive')),
            h(
              'button',
              { className: 'kb-btn danger', disabled: busy, onClick: stop(askDelete), title: confirming ? t('removeHint') : t('remove') },
              confirming ? t('confirmRemove') : t('remove'),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 新增表单
    function AddForm(props) {
      const { t, topics, defaultTopic, onCancel, onSaved } = props
      const [topic, setTopic] = useState(defaultTopic || (topics[0] ? topics[0].slug : '__new__'))
      const [customTopic, setCustomTopic] = useState('')
      const [kind, setKind] = useState('point')
      const [title, setTitle] = useState('')
      const [q, setQ] = useState('')
      const [body, setBody] = useState('')
      const [tags, setTags] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const save = async () => {
        const target = (topic === '__new__' ? customTopic : topic).trim()
        if (!target) return setError(t('needTopic'))
        if (!title.trim()) return setError(t('needTitle'))
        if (!body.trim()) return setError(t('needBody'))
        setBusy(true)
        setError('')
        try {
          const result = await apiPost('/add', {
            topic: target,
            kind,
            title: title.trim(),
            q: kind === 'qa' ? q.trim() : '',
            body: body.trim(),
            tags,
          })
          onSaved(result)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'kb-form' },
        h('div', { className: 'kb-card-title' }, t('addTitle')),
        h(
          'div',
          { className: 'kb-row' },
          h(
            'label',
            null,
            t('fieldTopic'),
            h(
              'select',
              { className: 'kb-select', value: topic, onChange: (event) => setTopic(event.target.value) },
              topics.map((item) => h('option', { key: item.slug, value: item.slug }, `${item.name} (${item.activeCount})`)),
              h('option', { value: '__new__' }, t('newTopic')),
            ),
          ),
          h(
            'label',
            null,
            t('fieldKind'),
            h(
              'select',
              { className: 'kb-select', value: kind, onChange: (event) => setKind(event.target.value) },
              h('option', { value: 'point' }, t('kindPoint')),
              h('option', { value: 'qa' }, t('kindQa')),
            ),
          ),
        ),
        topic === '__new__'
          ? h('input', {
              className: 'kb-input',
              placeholder: t('newTopic'),
              value: customTopic,
              onChange: (event) => setCustomTopic(event.target.value),
            })
          : null,
        h('input', {
          className: 'kb-input',
          placeholder: t('fieldTitle'),
          value: title,
          onChange: (event) => setTitle(event.target.value),
        }),
        kind === 'qa'
          ? h('input', {
              className: 'kb-input',
              placeholder: t('fieldQ'),
              value: q,
              onChange: (event) => setQ(event.target.value),
            })
          : null,
        h('textarea', {
          className: 'kb-textarea',
          placeholder: t('fieldBody'),
          value: body,
          onChange: (event) => setBody(event.target.value),
        }),
        h('input', {
          className: 'kb-input',
          placeholder: t('fieldTags'),
          value: tags,
          onChange: (event) => setTags(event.target.value),
        }),
        error ? h('div', { className: 'kb-err' }, error) : null,
        h(
          'div',
          { className: 'kb-form-foot' },
          h('button', { className: 'kb-btn primary', disabled: busy, onClick: save }, t('save')),
          h('button', { className: 'kb-btn', disabled: busy, onClick: onCancel }, t('cancel')),
        ),
      )
    }

    // ---------------------------------------------------------------- 主面板
    /** 由 apply 注入的翻译函数（locale 服务就绪后才拿得到） */
    let translate = (key) => (DICT.zh[key] !== undefined ? DICT.zh[key] : key)
    const t = (key) => translate(key)

    function Panel() {
      const [overview, setOverview] = useState(null)
      const [topic, setTopic] = useState('')
      const [status, setStatus] = useState('active')
      const [query, setQuery] = useState('')
      const [debounced, setDebounced] = useState('')
      const [entries, setEntries] = useState([])
      const [hits, setHits] = useState([])
      const [poolSize, setPoolSize] = useState(0)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busyId, setBusyId] = useState('')
      const [adding, setAdding] = useState(false)
      const [detail, setDetail] = useState(null)
      const [tick, setTick] = useState(0)
      const alive = useRef(true)
      const noticeTimer = useRef(null)

      const refresh = useCallback(() => setTick((value) => value + 1), [])

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
        }
      }, [])

      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 260)
        return () => clearTimeout(timer)
      }, [query])

      // 总览：主题清单与计数
      useEffect(() => {
        const controller = new AbortController()
        apiGet('/overview', {}, controller.signal)
          .then((data) => {
            if (alive.current) setOverview(data)
          })
          .catch((err) => {
            if (err && err.name === 'AbortError') return
            setError(err instanceof Error ? err.message : String(err))
          })
        return () => controller.abort()
      }, [tick])

      // 条目 / 检索
      useEffect(() => {
        const controller = new AbortController()
        setLoading(true)
        setError('')
        const run = debounced
          ? apiGet('/search', { q: debounced, topic: topic || 'all', limit: 40 }, controller.signal).then((data) => {
              if (!alive.current) return
              setHits(data.hits || [])
              setPoolSize(data.poolSize || 0)
            })
          : apiGet('/entries', { topic: topic || 'all', status }, controller.signal).then((data) => {
              if (!alive.current) return
              setEntries(data.entries || [])
              setHits([])
            })
        run
          .catch((err) => {
            if (err && err.name === 'AbortError') return
            setError(err instanceof Error ? err.message : String(err))
          })
          .finally(() => {
            if (alive.current) setLoading(false)
          })
        return () => controller.abort()
      }, [topic, status, debounced, tick])

      const flash = (message) => {
        setNotice(message)
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 5000)
      }

      const mutate = async (path, payload, message) => {
        setBusyId(payload.id)
        setError('')
        try {
          await apiPost(path, payload)
          flash(message)
          refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusyId('')
        }
      }

      const topics = (overview && overview.topics) || []
      const totalActive = (overview && overview.activeTotal) || 0
      const totalAll = (overview && overview.total) || 0
      const searching = debounced.length > 0
      const list = searching ? hits : entries

      return h(
        'div',
        { className: 'kb-root' },
        h(
          'div',
          { className: 'kb-head' },
          h('h2', null, t('title')),
          h(
            'span',
            { className: 'kb-path', title: (overview && overview.root) || '' },
            `${totalActive} 条活跃 · ${totalAll} 条合计 · ${topics.length} 个主题`,
          ),
          h('span', { className: 'kb-grow' }),
          h('span', { className: 'kb-rev', title: '当前加载的界面版本' }, 'UI ' + UI_REV),
          h('button', { className: 'kb-btn', onClick: refresh, disabled: loading }, t('refresh')),
          h('button', { className: 'kb-btn primary', onClick: () => setAdding(!adding) }, t('add')),
        ),
        h(
          'div',
          { className: 'kb-search' },
          h('input', {
            className: 'kb-input',
            placeholder: t('searchPlaceholder'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'select',
            {
              className: 'kb-select',
              value: status,
              onChange: (event) => setStatus(event.target.value),
              disabled: searching,
              title: searching ? t('searchScope') : '',
            },
            h('option', { value: 'active' }, t('statusActive')),
            h('option', { value: 'archived' }, t('statusArchived')),
            h('option', { value: 'all' }, t('statusAll')),
          ),
        ),
        notice ? h('div', { className: 'kb-ok' }, notice) : null,
        error ? h('div', { className: 'kb-err' }, error) : null,
        h(
          'div',
          { className: 'kb-body' },
          h(
            'aside',
            { className: 'kb-rail' },
            h(
              'div',
              { className: 'kb-topic' + (topic ? '' : ' on'), onClick: () => setTopic('') },
              h('span', { className: 'kb-name' }, t('allTopics')),
              h('span', { className: 'kb-n' }, String(totalActive)),
            ),
            topics.map((item) =>
              h(
                'div',
                {
                  key: item.slug,
                  className: 'kb-topic' + (topic === item.slug ? ' on' : ''),
                  onClick: () => setTopic(item.slug),
                  title: item.description || item.slug,
                },
                h('span', { className: 'kb-name' }, item.name),
                h('span', { className: 'kb-n' }, String(status === 'active' ? item.activeCount : item.count)),
              ),
            ),
          ),
          h(
            'section',
            { className: 'kb-list' },
            adding
              ? h(AddForm, {
                  t,
                  topics,
                  defaultTopic: topic || (overview && overview.defaultTopic) || '',
                  onCancel: () => setAdding(false),
                  onSaved: (result) => {
                    setAdding(false)
                    const plan = (result && result.plan) || []
                    const action = plan[0] && plan[0].action
                    const similar = (result && result.similar) || []
                    const map = { create: 'savedCreate', update: 'savedUpdate', restore: 'savedRestore' }
                    let message = map[action] ? t(map[action]) : t('savedCreate')
                    if (similar.length) message += `；注意：库里有 ${similar.length} 条相似条目，已一并写入，扫一眼是否重复`
                    flash(message)
                    refresh()
                  },
                })
              : null,
            h(
              'div',
              { className: 'kb-note' },
              loading
                ? t('loading')
                : searching
                  ? `命中 ${hits.length} 条（检索池 ${poolSize} 条活跃知识）`
                  : `${entries.length} 条`,
            ),
            !loading && !searching && topics.length === 0 && !adding ? h('div', { className: 'kb-note' }, t('noTopic')) : null,
            !loading && list.length === 0 && (searching || topics.length > 0)
              ? h('div', { className: 'kb-note' }, searching ? t('emptySearch') : topic ? t('emptyTopic') : t('emptyAll'))
              : null,
            h(
              'div',
              { className: 'kb-grid' },
              list.map((entry) =>
              h(EntryCard, {
                key: (entry.topic || '') + ':' + entry.id,
                entry,
                t,
                score: searching ? entry.score : undefined,
                coverage: searching ? entry.coverage : undefined,
                busy: busyId === entry.id,
                onOpen: (item) => setDetail(item),
                onArchive: (item) => mutate('/archive', { topic: item.topic, id: item.id }, t('archive')),
                onRestore: (item) => mutate('/restore', { topic: item.topic, id: item.id }, t('restore')),
                onDelete: (item) => mutate('/delete', { topic: item.topic, id: item.id }, t('remove')),
              }),
              ),
            ),
          ),
        ),
        detail
          ? h(EntryModal, {
              entry: detail,
              t,
              busy: busyId === detail.id,
              score: searching ? detail.score : undefined,
              coverage: searching ? detail.coverage : undefined,
              onClose: () => setDetail(null),
              onArchive: (item) => {
                setDetail(null)
                mutate('/archive', { topic: item.topic, id: item.id }, t('archive'))
              },
              onRestore: (item) => {
                setDetail(null)
                mutate('/restore', { topic: item.topic, id: item.id }, t('restore'))
              },
              onDelete: (item) => {
                setDetail(null)
                mutate('/delete', { topic: item.topic, id: item.id }, t('remove'))
              },
            })
          : null,
      )
    }

    // ---------------------------------------------------------------- 注册
    function apply(ctx) {
      // 注意：宿主会热重载浏览器半侧（bundle 改了就重新 apply）。所以这里
      // 每个注册动作都必须可重入，否则第二次 apply 抬错就会把整个插件搞掉。
      try {
        ensureStyle()
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[learning-kb] 注入样式失败', error)
      }

      // 词典注册必须挂在 ctx.effect 上：effect 的回调返回值就是回收函数，
      // 宿主重载时它会调用、把命名空间释放掉，下一次 apply 才能重新注册。
      // 不挂 effect 的后果（2026-10-22 踩过）：第二次 apply 抛
      //   locale namespace "learning-kb" already has locale "zh"
      // apply 直接中断 → 侧边栏那一格消失，而面板上看不到任何错（错被宿主收走了）。
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          try {
            return ctx.locale.register(PANEL_ID, DICT)
          } catch (error) {
            if (typeof console !== 'undefined') console.warn('[learning-kb] 词典注册被跳过（界面仍用中文默认文案）', error)
            return () => {}
          }
        }, 'learning-kb: dictionaries')
      }

      const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(PANEL_ID) : (key) => key
      translate = (key) => {
        const value = bound(key)
        return value === undefined || value === null || value === key ? (DICT.zh[key] !== undefined ? DICT.zh[key] : key) : value
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: PANEL_ID }, () => h(Panel, null)),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => t('title'),
            locale: PANEL_ID,
          },
          (props) => h(BookIcon, { size: props && props.size }),
        ),
      )
    }

    exports.name = 'learning-kb-ui'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    exports.parseBody = parseBody
    }

    /** 把任意抛出物整理成可以贴进面板的文本 */
    function describeError(error) {
      if (error && error.stack) return String(error.stack)
      if (error && error.message) return String(error.message)
      return String(error)
    }

    /**
     * 故障面板：注册一个仍然占位、但会显示错误原文的条目。
     * 这样"插件静默消失"变成"点一下就能看到哪里炸了"。
     */
    function installFault(React, exports, message) {
      const id = 'learning-kb'
      const label = '知识库·异常'
      const make = React && typeof React.createElement === 'function' ? React.createElement : null
      exports.name = 'learning-kb-ui'
      exports.inject = ['slots']
      exports.apply = (ctx) => {
        const panel = () => {
          if (!make) return null
          return make(
            'div',
            {
              style: {
                height: '100%',
                overflow: 'auto',
                padding: '16px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '12px',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                color: 'var(--dsw-alias-state-error-primary)',
              },
            },
            '学习知识库加载失败，把这段发给助手：\n\n' + message,
          )
        }
        const icon = (props) => {
          if (!make) return null
          const size = props && typeof props.size === 'number' ? props.size : 18
          return make(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            },
            make('path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }),
            make('path', { d: 'M12 9v4' }),
            make('path', { d: 'M12 17h.01' }),
          )
        }
        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, locale: id }, panel))
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id, order: 30, label: () => label, locale: id }, icon),
          )
        } catch (error) {
          if (typeof console !== 'undefined') console.error('[learning-kb] 故障面板注册失败', error)
        }
      }
    }
  },
})

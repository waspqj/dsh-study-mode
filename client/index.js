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
    const UI_REV = '0.3.19'

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
        // 会话内卡片
        chatSearching: '正在检索知识库…',
        chatSaving: '正在整理知识卡片…',
        chatNoHit: '这次没有命中任何知识卡片',
        // 卡片角色（2026-10-23 用户反馈「卡片之间没有区分」）
        roleExisting: '库中已有',
        roleNew: '本次新增',
        roleUpdate: '本次更新',
        rolePreview: '待写入',
        cardPendingNote: '还没进库',
        cardCollapse: '收起',
        // 相关补充：点一行能看全文（2026-10-23 用户：「点开后没有卡片，只有文字，那也没有意义」）
        relOpenHint: '点开看全文',
        relCloseHint: '收起这一条',
        relNote: '相关条目 · 仅供参考，不是本轮答案',
        relMore: '再看',
        relLess: '收起后面的',
        proposalHead: '提议补',
        proposalAccept: '同意，出卡片预览',
        proposalLater: '算了',
        proposalGenerating: '生成中…',
        proposalConfirm: '确认写入',
        // 提议条里挑要补的条目、挑补到哪个主题
        proposalTopic: '补到',
        // 预览先行的写入条
        saveBarTitle: '这批卡片还没进库：',
        unitCards: '条',
        notWritten: '（未写入）',
        saveConfirm: '确认写入',
        saveWriting: '写入中…',
        saveDone: '已写入',
        groupExisting: '库中已有',
        groupNew: '本次新增',
        groupUpdate: '本次更新',
        groupPreview: '待写入',
        expandAll: '展开全部',
        collapseAll: '收起',
        actReview: 'AI 校验补充',
        actEdit: '编辑',
        actAsk: '问一下',
        actStaleNote: '库里已更新到',
        actStaleHint: '这条在别处被改过了，这里显示的是旧版；先刷新会话里的卡片再改',
        workTitle: '卡片工作台',
        workCapNote: '只改这张卡，不动库里别的',
        workModel: '模型',
        aiParseFailed: 'AI 没按格式回答，这次没有结果',
        aiParseFailedHint: '模型的回答不是 JSON，解析不了。点重试再问一次，或者把下面原文贴给我看。',
        aiRetry: '重试',
        workNoAdditions: 'AI 没找到可补充的要点',

        workModelTip: '跟当前会话选的模型一致；切了模型，下次校验就用新的',
        workRun: '让 AI 校验',
        workRunning: '校验中…',
        // 等待时把话说清楚：思考型模型一次校验要几十秒到两分钟，
        // 用户干等着会以为界面卡死了。2026-10-23 用户反馈「会卡很久」。
        workWaiting: '思考型模型正在想，通常要 30–120 秒（已等 ',
        workWaitingSec: ' 秒）',
        workWaitedShort: '还在想，别以为它坏了。',
        workThinking: '模型思考了 ',
        workRunAgain: '重新校验',
        workCachedNote: '用的是上次的结果，这次没调模型',
        workIssues: '发现的问题',
        workIssuesDesc: '可能和事实不符的地方；确认是错的就点忽略',
        workAdditions: '可补充的要点',
        workAdditionsDesc: '「采纳」会追加成一条 - 要点写进正文',
        workNoIssue: 'AI 没有发现事实性问题',
        workSuggested: 'AI 建议的正文',
        workSuggestedDesc: '整段改写建议，会覆盖当前正文，慎用',
        workUseSuggested: '用这段替换正文',
        workBody: '正文（可直接改）',
        workBodyDesc: '框里只显示文字：**粗体**、`代码`、【高亮】这类标记已隐去；没改动的行保存时保留原标记',
        workApply: '覆盖原卡片',
        workApplyConfirm: '确认覆盖？旧正文已备份，可一键回退。',
        workCancel: '取消',
        workSaved: '已写回',
        workCheckLead: '首行结论',
        workCheckBullet: '要点行',
        workCheckBacktick: '反引号成对',
        workCheckBracket: '【】成对',
        workAdopt: '采纳',
        workIgnore: '忽略',
        workViewCurrent: '查看当前版本',
        workViewCurrentHide: '收起当前版本',
        workCurrentDirty: '当前是未保存的修改 · 库里仍是 ',
        workCurrentSaved: '已保存 · ',
        askTitle: '只问这一条',
        askHint: '只使用这条卡片，不关联会话里的其它内容',
        askPlaceholder: '针对这条卡片提问…',
        askSend: '发送',
        askEmpty: '还没有追问。问点什么吧。',
        askClear: '清空',
        verifyTitle: '核实这条',
        verifyCapNote: '只记录谁确认的，不改卡片内容',
        verifySelfShort: '自己确认',
        verifySelfDesc: '你看着对，就直接标为已核实。',
        verifyAiShort: '让 AI 先查一遍',
        verifyAiDesc: '模型只读这张卡找事实性问题，不改写正文；有出入会列在下面。',
        verifySourceShort: '附上出处',
        verifySourceDesc: '填 URL 或课件页号，出处记进核实记录，作为一条证据。',
        verifyIssuesCap: 'AI 发现的问题',
        verifySourceSave: '存为来源并核实',
        verifySelf: '① 我自己看着对',
        verifySelfBtn: '标为已核实',
        verifyAi: '② 先让 AI 查一遍',
        verifyAiBtn: '开始校验',
        verifyNoIssue: 'AI 没有发现事实性问题',
        verifyNoIssueBtn: '无异议，标为已核实',
        verifyToFix: '去修改',
        verifySource: '③ 附上出处（可选）',
        verifySourcePh: 'URL / 课件页号…',
        verifySourceBtn: '填来源',
        verifyByUser: '用户确认',
        verifyByAi: 'AI 无异议',
        verifyBySource: '来源',
        verifyDone: '已标记为已核实',
        verifyReset: '内容已变更，核实状态已重置',
        rollback: '回退到原版',
        rollbackDone: '已回退到原版',
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
        // Cards in the conversation
        chatSearching: 'Searching the knowledge base…',
        chatSaving: 'Collecting knowledge cards…',
        chatNoHit: 'No knowledge card matched this time',
        // Card roles (2026-10-23: "cards are indistinguishable")
        roleExisting: 'In library',
        roleNew: 'New',
        roleUpdate: 'Updated',
        rolePreview: 'Not saved',
        cardPendingNote: 'not in the library yet',
        cardCollapse: 'Collapse',
        relOpenHint: 'Open the full text',
        relCloseHint: 'Collapse this one',
        relNote: 'Related · background only, not the answer',
        relMore: 'Show',
        relLess: 'Hide the rest',
        proposalHead: 'Suggested additions',
        proposalAccept: 'Generate preview',
        proposalLater: 'No thanks',
        proposalGenerating: 'Generating…',
        proposalConfirm: 'Write',
        proposalTopic: 'Add to',
        saveBarTitle: 'These cards are not in the library yet:',
        unitCards: 'cards',
        notWritten: '(not written)',
        saveConfirm: 'Write them',
        saveWriting: 'Writing…',
        saveDone: 'Written',
        groupExisting: 'In library',
        groupNew: 'New',
        groupUpdate: 'Updated',
        groupPreview: 'Not saved',
        expandAll: 'Expand all',
        collapseAll: 'Collapse',
        actReview: 'AI review',
        actEdit: 'Edit',
        actAsk: 'Ask',
        actStaleNote: 'stored version is now',
        actStaleHint: 'This entry was changed elsewhere; the copy here is older. Refresh the card before editing.',
        workTitle: 'Card workbench',
        workCapNote: 'Touches this card only',
        workModel: 'model',
        aiParseFailed: 'The AI did not answer in the expected format',
        aiParseFailedHint: 'Its reply was not JSON, so it could not be parsed. Retry, or show me the text below.',
        aiRetry: 'Retry',
        workNoAdditions: 'The AI found nothing to add',

        workModelTip: 'Matches the model selected in this session; switching it applies to the next review',
        workRun: 'Run AI review',
        workRunning: 'Reviewing…',
        workWaiting: 'The model is thinking; usually 30–120s (waited ',
        workWaitingSec: 's)',
        workWaitedShort: 'Still thinking — it is not frozen.',
        workThinking: 'Model thought ',
        workRunAgain: 'Run again',
        workCachedNote: 'Reused the previous result; the model was not called',
        workIssues: 'Issues found',
        workIssuesDesc: 'Possible factual errors; ignore the ones that are fine',
        workAdditions: 'Additions',
        workAdditionsDesc: 'Adopt appends the point to the body as a "- " line',
        workNoIssue: 'The AI found no factual problems',
        workSuggested: 'Suggested body',
        workSuggestedDesc: 'A full rewrite that replaces the current body; use with care',
        workUseSuggested: 'Replace the body with this',
        workBody: 'Body (edit directly)',
        workBodyDesc: 'Plain text only: bold/code/highlight markers are hidden; untouched lines keep their formatting when saved',
        workApply: 'Overwrite the card',
        workApplyConfirm: 'Overwrite? The old body is kept and can be restored in one click.',
        workCancel: 'Cancel',
        workSaved: 'Saved',
        workCheckLead: 'Lead line',
        workCheckBullet: 'Bullet lines',
        workCheckBacktick: 'Paired backticks',
        workCheckBracket: 'Paired 【】',
        workAdopt: 'Adopt',
        workIgnore: 'Ignore',
        workViewCurrent: 'View current version',
        workViewCurrentHide: 'Hide current version',
        workCurrentDirty: 'Unsaved changes · stored is still ',
        workCurrentSaved: 'Saved · ',
        askTitle: 'Ask this card only',
        askHint: 'Only this card is used; nothing else from the conversation',
        askPlaceholder: 'Ask about this card…',
        askSend: 'Send',
        askEmpty: 'No follow-up yet. Ask something.',
        askClear: 'Clear',
        verifyTitle: 'Verify this card',
        verifyCapNote: 'Records who confirmed it; never edits the card',
        verifySelfShort: 'Confirm it yourself',
        verifySelfDesc: 'Looks right to you? Mark it verified right away.',
        verifyAiShort: 'Let the AI check first',
        verifyAiDesc: 'The model only reads this card for factual problems; it never rewrites the body.',
        verifySourceShort: 'Attach a source',
        verifySourceDesc: 'A URL or page number is stored with the verification as evidence.',
        verifyIssuesCap: 'Problems the AI found',
        verifySourceSave: 'Save source and verify',
        verifySelf: '① I checked it myself',
        verifySelfBtn: 'Mark as verified',
        verifyAi: '② Let the AI check first',
        verifyAiBtn: 'Start review',
        verifyNoIssue: 'The AI found no factual problems',
        verifyNoIssueBtn: 'No objections — mark verified',
        verifyToFix: 'Go fix it',
        verifySource: '③ Attach a source (optional)',
        verifySourcePh: 'URL / page number…',
        verifySourceBtn: 'Add source',
        verifyByUser: 'confirmed by the user',
        verifyByAi: 'AI found no objection',
        verifyBySource: 'source',
        verifyDone: 'Marked as verified',
        verifyReset: 'The content changed, so the verification was reset',
        rollback: 'Restore the original body',
        rollbackDone: 'Restored the original body',
      },
    }

    // ---------------------------------------------------------------- 样式
    const CSS = `
.kb-root{--kb-surface:var(--kb-panel-bg,var(--dsw-alias-bg-base));--kb-line:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);--kb-card:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--kb-surface));--kb-card-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 15%,var(--kb-surface));--kb-rail:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--kb-surface));--kb-field:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--kb-surface));--kb-accent:#3b82f6;--kb-accent-soft:rgb(59 130 246 / .15);--kb-tag-fg:color-mix(in srgb,var(--kb-accent) 60%,var(--dsw-alias-label-primary));display:flex;flex-direction:column;height:100%;min-height:0;background:var(--kb-surface);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.kb-head{display:flex;align-items:center;gap:8px;padding:14px 18px 10px;flex:none}
.kb-head h2{margin:0;font-size:15.5px;font-weight:600}
.kb-path{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60ch}
.kb-grow{flex:1 1 auto;min-width:0}
.kb-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 9px;cursor:pointer;white-space:nowrap}
.kb-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-btn.primary{color:#fff;background:var(--kb-accent);border-color:var(--kb-accent);font-weight:500}
.kb-btn.primary:hover{opacity:.9}
.kb-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-btn.danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.kb-btn:disabled{opacity:.45;cursor:default}
.kb-search{display:flex;align-items:center;gap:10px;padding:0 18px 12px;flex:none;flex-wrap:wrap}
.kb-input,.kb-select,.kb-textarea{font:inherit;font-size:12.5px;height:34px;color:var(--dsw-alias-label-primary);background:var(--kb-field);border:1px solid var(--kb-line);border-radius:8px;padding:0 12px;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.kb-input:focus,.kb-select:focus,.kb-textarea:focus{border-color:var(--kb-accent);box-shadow:0 0 0 3px var(--kb-accent-soft)}
.kb-search .kb-input{flex:1 1 260px;min-width:160px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%239098a2' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='M15.4 15.4 20 20'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:11px center;padding-left:34px}
.kb-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 82%,transparent)}
.kb-textarea{resize:vertical;height:auto;min-height:84px;padding:7px 10px;font-family:inherit}
.kb-body{display:flex;flex:1 1 auto;min-height:0;border-top:1px solid var(--kb-line)}
.kb-rail{flex:0 0 188px;overflow:auto;padding:10px 8px;background:var(--kb-rail);border-right:1px solid var(--kb-line)}
.kb-topic{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;color:var(--dsw-alias-label-secondary);overflow:hidden;transition:background .12s ease,color .12s ease}
.kb-topic:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}
.kb-topic.on{background:color-mix(in srgb,var(--kb-tc,var(--kb-accent)) 16%,transparent);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 3px 0 0 var(--kb-tc,var(--kb-accent))}
.kb-topic .kb-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-topic .kb-n{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kb-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--kb-tc,var(--kb-accent));box-shadow:0 0 0 3px color-mix(in srgb,var(--kb-tc,var(--kb-accent)) 18%,transparent)}
.kb-rail-cap{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.9;padding:2px 10px 6px}
.kb-rail-foot{margin-top:8px;padding:6px 10px 2px;border-top:1px solid var(--kb-line);font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.8}
.kb-list{flex:1 1 auto;min-width:0;overflow:auto;padding:14px 18px 32px}
.kb-list::-webkit-scrollbar,.kb-rail::-webkit-scrollbar,.kb-modal-body::-webkit-scrollbar{width:8px;height:8px}
.kb-list::-webkit-scrollbar-track,.kb-rail::-webkit-scrollbar-track,.kb-modal-body::-webkit-scrollbar-track{background:transparent}
.kb-list::-webkit-scrollbar-thumb,.kb-rail::-webkit-scrollbar-thumb,.kb-modal-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);border-radius:999px}
.kb-list::-webkit-scrollbar-thumb:hover,.kb-rail::-webkit-scrollbar-thumb:hover,.kb-modal-body::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent)}
.kb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:stretch}
@media (max-width:820px){.kb-grid{grid-template-columns:minmax(0,1fr)}}
.kb-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:6px}
.kb-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:36px 16px;color:var(--dsw-alias-label-secondary);text-align:center}
.kb-empty-ico{width:30px;height:30px;opacity:.55;margin-bottom:2px}
.kb-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kb-empty-hint{font-size:11.5px;line-height:1.6;opacity:.85}
.kb-empty .kb-btn{margin-top:4px}
.kb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 16px}
.kb-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;padding:6px 16px}
.kb-card{position:relative;border:1px solid var(--kb-line);border-radius:9px;padding:10px 12px 9px;background:var(--kb-card);cursor:pointer;transition:border-color .12s ease,background .12s ease}
.kb-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);background:var(--kb-card-hover)}
.kb-card.archived{opacity:.72}
.kb-card::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:0 2px 2px 0;background:var(--kb-tc,var(--kb-accent));opacity:.5}
.kb-card{padding-left:15px}
.kb-card-head{display:flex;align-items:center;gap:5px;min-width:0}
.kb-card-title{flex:1 1 auto;min-width:0;font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-badge{flex:none;font-size:10px;line-height:1.6;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary)}
.kb-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.kb-badge.idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary)}
.kb-badge.quiet{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);opacity:.9}
.kb-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kb-q{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-text{margin-top:4px;font-size:12.5px;line-height:1.55;min-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.kb-tags{display:flex;gap:5px;margin-top:6px;overflow:hidden;max-height:19px}
.kb-tag{flex:none;font-size:10.5px;color:color-mix(in srgb,var(--kb-tc,var(--kb-accent)) 55%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--kb-tc,var(--kb-accent)) 15%,transparent);border-radius:999px;padding:1px 7px}
.kb-card-foot{display:flex;align-items:center;gap:6px;margin-top:6px;padding-right:76px;font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.72}
.kb-pick{flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;font-size:9px;line-height:12px;text-align:center;color:var(--dsw-alias-bg-base);background:transparent;user-select:none}
.kb-pick.on{background:var(--kb-accent);border-color:var(--kb-accent)}
.kb-card.picking{cursor:default}
.kb-batch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 18px;border-top:1px solid var(--kb-line);background:var(--kb-rail);font-size:12px;color:var(--dsw-alias-label-secondary);flex:none}
.kb-batch .kb-btn{font-size:12px}
.kb-rev{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.8;font-variant-numeric:tabular-nums;margin-right:2px}
.kb-ai-model{display:inline-flex;align-items:center;gap:5px;flex:none}
.kb-ai-model-select{max-width:180px;font-size:11px;padding:3px 5px;height:auto;line-height:1.4}
.kb-score{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kb-card-acts{position:absolute;right:6px;bottom:5px;display:flex;gap:4px;padding:2px 3px;border-radius:6px;background:color-mix(in srgb,var(--kb-card) 92%,transparent);opacity:0;pointer-events:none;transition:opacity .12s ease}
.kb-card:hover .kb-card-acts,.kb-card:focus-within .kb-card-acts{opacity:1;pointer-events:auto}
.kb-mini{font:inherit;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--kb-line);border-radius:5px;padding:0 6px;cursor:pointer;white-space:nowrap}
.kb-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-mini.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-mini.danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.kb-mini:disabled{opacity:.45;cursor:default}
/* 过期卡片（别的端改过了）：提示 + 禁用编辑类按钮 */
.kb-stale-note{font-size:10.5px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}
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
.kb-li-marker{flex:none;min-width:16px;color:var(--kb-accent);font-weight:700}
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
/* ---------------- 会话内卡片（工具结果里的知识卡片） ----------------
   会话区不在 .kb-root 里，所以这里自带一套变量：底色用 transparent 混，
   卡片在任何背景上都是「一层淡淡的提亮」，不会糊成一块。 */
.kb-stack{--kb-surface:transparent;--kb-line:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);--kb-card:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--kb-field:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);--kb-accent:#3b82f6;--kb-accent-soft:rgb(59 130 246 / .15);display:flex;flex-direction:column;gap:8px;margin:2px 0 6px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.kb-chat-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:1px 0}
.kb-stack-head{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.9;padding:0 2px}
.kb-turn{margin:6px 0 2px}
.kb-turn-head{display:flex;align-items:center;gap:8px;padding:0 2px 2px}
/* 展开/收起放在卡片下方：用户是看完这几张才决定要不要展开的。 */
.kb-turn-foot{display:flex;justify-content:flex-end;padding:0 2px}
.kb-turn-foot .kb-mini{font-size:11.5px;padding:1px 9px}
.kb-turn-head .kb-mini{margin-left:auto}
.kb-related{display:flex;flex-direction:column;gap:8px;margin-top:2px;padding-top:6px;border-top:1px dashed var(--kb-line)}
.kb-related-head{display:flex;align-items:center;gap:6px;width:100%;font:inherit;font-size:11px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:6px;padding:3px 2px;cursor:pointer;text-align:left}
.kb-related-head:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.kb-related-caret{font-size:9px;opacity:.75;width:9px;flex:none}
.kb-related .kb-chat-card{opacity:.82}
/* 收起态的一行预览（2026-10-23 用户：末尾卡片太大，做小当预览，点击/悬停查看） */
.kb-chat-card.kb-mini-card{display:flex;flex-direction:column;gap:2px;min-width:0;padding:5px 9px 5px 12px;cursor:pointer}
.kb-chat-card.kb-mini-card::before{top:6px;bottom:6px;opacity:.75}
.kb-chat-card.kb-mini-card:hover{background:color-mix(in srgb,var(--kb-role-c) 9%,var(--kb-card))}
.kb-mini-line{display:flex;align-items:baseline;gap:7px;min-width:0}
.kb-mini-title{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:640;white-space:normal;overflow-wrap:anywhere;line-height:1.45}
.kb-mini-meta-line{font-size:11px;color:var(--dsw-alias-label-secondary)}
.kb-mini-sum{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-mini-meta{flex:none;font-size:10.5px;opacity:.7;white-space:nowrap}
/* 提议条 */
.kb-proposal{display:flex;flex-direction:column;gap:6px;margin-top:4px;padding:9px 11px;border:1px solid color-mix(in srgb,var(--kb-accent) 42%,transparent);border-radius:9px;background:color-mix(in srgb,var(--kb-accent) 8%,transparent)}
.kb-proposal-head{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary)}
.kb-proposal-topic{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.kb-proposal-list{display:flex;flex-direction:column;gap:2px}
.kb-proposal-item{display:flex;align-items:baseline;gap:8px;font-size:11.5px;min-width:0}
.kb-proposal-item input[type=checkbox]{flex:none;margin:0;transform:translateY(1px)}
.kb-proposal-topicrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px}
.kb-proposal-select{font-size:11.5px;padding:2px 6px;border-radius:6px;border:1px solid var(--kb-line);background:var(--kb-card);color:var(--dsw-alias-label-primary);max-width:240px}
.kb-proposal-title{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}
.kb-proposal-why{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-proposal-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kb-proposal-preview{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto}
.kb-proposal-card{border:1px solid var(--kb-line);border-radius:7px;padding:7px 9px;background:var(--kb-card)}
.kb-proposal-card-title{font-size:12px;font-weight:650;margin-bottom:3px}
.kb-proposal-done{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);font-size:12px;color:var(--dsw-alias-state-success-primary)}

/* 相关补充：一行元信息 + 点开就地看全文（2026-10-23 两轮反馈合并）
   ① 展开后和命中卡长得一模一样，用户分不清哪张是答案 → 不再用完整卡片外壳，保持浅色小行；
   ② 用户又说「点开后没有卡片，只有文字，那也没有意义」→ 行本身可点，点开在下面直接铺正文。 */
.kb-rel-list{display:flex;flex-direction:column;gap:1px;padding:2px 0 0}
.kb-rel-item{min-width:0}
.kb-rel-row{display:flex;align-items:baseline;gap:6px;min-width:0;width:100%;font:inherit;font-size:11.5px;line-height:1.6;padding:1px 4px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.kb-rel-row:hover{background:var(--kb-field)}
.kb-rel-row[aria-expanded="true"]{background:var(--kb-field)}
.kb-rel-caret{flex:none;font-size:9px;opacity:.7;width:9px}
.kb-rel-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.kb-rel-row[aria-expanded="true"] .kb-rel-title{color:var(--dsw-alias-label-primary);font-weight:600}
.kb-rel-meta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.65;white-space:nowrap}
.kb-rel-open{margin:2px 0 5px 15px;padding:6px 9px;border-left:2px solid var(--kb-line);border-radius:0 6px 6px 0;background:var(--kb-card);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.kb-rel-note{font-size:10.5px;letter-spacing:.03em;opacity:.6;margin-bottom:3px}
.kb-rel-open .kb-blocks>.kb-p:first-child{font-size:12px;font-weight:600;margin:0 0 5px;color:var(--dsw-alias-label-primary)}
.kb-rel-foot{display:flex;align-items:baseline;gap:6px;margin-top:5px;font-size:10.5px;opacity:.65}
.kb-rel-more{margin:3px 0 0 15px;padding:1px 6px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;cursor:pointer;text-align:left}
.kb-rel-more:hover{background:var(--kb-field);color:var(--dsw-alias-label-primary)}
.kb-chat-card{position:relative;border:1px solid var(--kb-line);border-radius:9px;padding:9px 11px 9px 14px;background:var(--kb-card)}
.kb-chat-card::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:2px;border-radius:0 2px 2px 0;background:var(--kb-tc,var(--kb-accent));opacity:.55}
.kb-chat-head{display:flex;align-items:center;gap:6px;min-width:0}
.kb-chat-title{flex:1 1 auto;min-width:0;font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-chat-topic{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-chat-body{margin-top:4px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.kb-chat-body .kb-blocks>.kb-p:first-child{font-size:12.5px;font-weight:600;margin:0 0 6px}
.kb-chat-body .kb-li-text{line-height:1.6}
.kb-chat-foot{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap}
/* 卡片角色（2026-10-23 用户反馈「卡片之间没有区分」）
   以前左侧色条一律用主题色：同一个主题里所有卡片一个颜色，
   「库中已有的」和「这次要加的」看起来完全一样。现在色条和徽章按角色取色。 */
.kb-role-badge{flex:none;font-size:10px;line-height:1.5;padding:0 7px;border-radius:999px;border:1px solid var(--kb-role-c,#3b82f6);color:var(--kb-role-c,#3b82f6);background:color-mix(in srgb,var(--kb-role-c,#3b82f6) 14%,transparent);white-space:nowrap;font-weight:600;letter-spacing:.02em}
.kb-chat-card.kb-role-preview{border-style:dashed;background:transparent}
.kb-chat-card.kb-role-preview::before{opacity:.8}
/* 回答下方的分组：库中已有 / 本次新增 / 本次更新，各一组不混排 */
.kb-group{display:flex;flex-direction:column;gap:8px}
.kb-group+.kb-group{margin-top:2px;padding-top:6px;border-top:1px dashed var(--kb-line)}
.kb-group-head{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.9;padding:0 2px}
/* 预览先行的写入条：卡片底下那一个「确认写入 N 条」 */
.kb-save-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--kb-accent) 40%,transparent);border-radius:9px;background:color-mix(in srgb,var(--kb-accent) 10%,transparent)}
.kb-save-bar-text{font-size:12px;color:var(--dsw-alias-label-primary)}
.kb-save-bar-text b{font-weight:650}
.kb-save-bar-topic{font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.9}
.kb-save-err{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);flex:1 1 100%;min-width:0}
.kb-save-ok{font-size:12px;color:var(--dsw-alias-state-success-primary);font-weight:600}
.kb-save-bar .kb-vbtn{height:28px;font-size:12.5px}
.kb-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.kb-badge.clickable{cursor:pointer;font-family:inherit}
.kb-badge.clickable:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.kb-work,.kb-ask,.kb-verify{margin-top:9px;border-top:1px dashed var(--kb-line);padding-top:8px;display:flex;flex-direction:column;gap:7px}
/* 校验面板：按「区块」组织，不是一排小按钮。
   旧版 11.5px + 每行一个标签一个按钮，用户反馈「太小、分不出来」，
   所以这里放大字号/间距，并用编号 + 标题 + 说明三段式区分三条核实路径。 */
.kb-verify{margin:10px -2px 0;border:1px solid var(--kb-line);border-radius:10px;background:var(--kb-field);padding:0;overflow:hidden;display:block;font-size:13px;line-height:1.6}
.kb-verify-cap{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--kb-line);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
.kb-verify-cap-note{margin-left:auto;font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
.kb-model-chip{flex:none;font-size:11px;line-height:1.5;padding:1px 8px;border-radius:20px;border:1px solid var(--kb-accent);color:var(--kb-accent);background:var(--kb-accent-soft);white-space:nowrap;font-weight:600;letter-spacing:.02em}
.kb-vsec{display:flex;flex-direction:column;gap:7px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.kb-vsec:last-child{border-bottom:0}
.kb-vsec-head{display:flex;align-items:center;gap:8px}
.kb-vsec-no{flex:none;width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--kb-accent);background:var(--kb-accent-soft)}
.kb-vsec-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}
.kb-vsec-desc{padding-left:27px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.kb-vsec-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-left:27px}
.kb-vbtn{font:inherit;font-size:12.5px;line-height:1.5;height:30px;padding:0 13px;border-radius:7px;border:1px solid var(--kb-line);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.kb-vbtn:hover{border-color:var(--kb-accent);color:var(--kb-accent);background:var(--kb-accent-soft)}
.kb-vbtn.primary{border-color:var(--kb-accent);color:var(--kb-accent);background:var(--kb-accent-soft)}
.kb-vbtn.primary:hover{background:var(--kb-accent);color:#fff}
.kb-vbtn:disabled{opacity:.45;cursor:default}
.kb-vbtn:disabled:hover{border-color:var(--kb-line);color:var(--dsw-alias-label-primary);background:transparent}
.kb-vissues{display:flex;flex-direction:column;gap:6px;margin-left:27px;padding-left:10px;border-left:2px solid var(--dsw-alias-state-warn-primary)}
.kb-vissues-cap{font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-state-warn-primary)}
.kb-vissue{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-state-warn-primary)}
.kb-vok{margin-left:27px;font-size:12.5px;color:var(--dsw-alias-state-success-primary)}
/* 工作台复用同一套区块外壳，只多两处：要点行排版、正文框高度 */
.kb-workpanel{margin-top:10px}
.kb-addrow{display:flex;align-items:flex-start;gap:8px;padding-left:27px}
.kb-addrow .kb-grow{flex:1 1 auto;min-width:0}
.kb-addrow .kb-vbtn{flex:none}
.kb-work-body{min-height:160px;font-size:12.5px;line-height:1.65;resize:vertical}
.kb-raw{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);border-radius:6px;padding:7px 9px;margin-left:27px}
.kb-work-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kb-work-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0}
/* 「用的是上次的结果」这类提示：跟说明文字同层级，但更弱，别抢注意力 */
.kb-cache-note{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85;white-space:nowrap}
.kb-token-note{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.9;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 当前版本（改完之后这一版）：只读渲染，跟库里的对比靠顶部那一行说明 */
.kb-current{margin-top:10px;border:1px solid var(--kb-line);border-radius:8px;padding:8px 10px;background:var(--kb-field)}
.kb-current-cap{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.kb-work-cap{font-size:10.5px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);opacity:.9}
.kb-add{border:1px solid var(--kb-line);border-radius:7px;padding:6px 8px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--kb-field);word-break:break-word}
.kb-check{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.kb-check .yes{color:var(--dsw-alias-state-success-primary)}
.kb-check .no{color:var(--dsw-alias-state-error-primary)}
.kb-ask-turn{font-size:12px;line-height:1.6}
.kb-ask-q{color:var(--dsw-alias-label-primary);font-weight:600}
.kb-ask-a{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;margin-top:2px;word-break:break-word}
.kb-ask-meta{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.9;margin-top:3px;font-variant-numeric:tabular-nums}
.kb-ask-input{display:flex;gap:6px;align-items:center}
.kb-ask-input .kb-input{flex:1 1 auto;min-width:0}
.kb-verify-input{flex:1 1 160px;min-width:0;height:28px}
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
      if (!res.ok) {
        const message = (json && json.error) || `HTTP ${res.status}`
        // 卡片这组接口是宿主半侧新加的：宿主没重启时它们还不存在。
        // 直接把「未知接口」甩给用户没有意义，这里说清楚要重启。
        // /save 同理：它也是批次 2 新加的路由（预览先行的「确认写入」）。
        if (res.status === 404 && (String(path).startsWith('/card/') || String(path) === '/save')) {
          throw new Error('这个功能要重启 DSH 之后才生效（宿主半侧还没重新加载）')
        }
        throw new Error(message)
      }
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
    // 每个主题一个颜色：用于左栏圆点、选中态和卡片左侧色条；
    // 不用 --dsw-alias-brand-primary——本机 open-sea 皮肤里它是近白色，混出来全是白。
    const TOPIC_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e']

    function topicColor(slug) {
      const s = String(slug || '')
      let h = 0
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
      return TOPIC_COLORS[h % TOPIC_COLORS.length]
    }

    // ---------------------------------------------------------------- 卡片角色
    // 2026-10-23 用户反馈「卡片之间没有区分」：同一主题里所有卡片一个颜色，
    // 「库中已有的」和「这次要加的」看起来完全一样，用户不知道哪些已经进库了。
    // 现在卡片带一个 role，色条和徽章按角色取色，回答下方的卡片也按角色分组。
    const CARD_ROLES = {
      existing: { labelKey: 'roleExisting', groupKey: 'groupExisting', color: '#3b82f6' },
      new: { labelKey: 'roleNew', groupKey: 'groupNew', color: '#10b981' },
      update: { labelKey: 'roleUpdate', groupKey: 'groupUpdate', color: '#f59e0b' },
      preview: { labelKey: 'rolePreview', groupKey: 'groupPreview', color: '#94a3b8' },
    }

    /** 分组顺序：待写入的排前面（那是用户马上要决定的事），库中已有的排后面。 */
    const ROLE_ORDER = ['new', 'update', 'preview', 'existing']

    /** 卡片的角色；宿主没给就当「库中已有」（检索命中、清单列出都是它）。 */
    function roleOf(card) {
      const role = card && card.role
      return role && CARD_ROLES[role] ? role : 'existing'
    }

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

    /**
     * 正文里的标记符号只是给渲染层看的：**粗体**、`代码`、【高亮】、> 引用。
     * 编辑框里没必要让人盯着这些符号（改完还要过一遍校验流程），所以显示前
     * 统一去标记、只留文字。唯一的例外是行首的 "- " —— 它既是列表本身，
     * 也是写入契约里的一条要点行，留着才读得像列表。
     */
    function toPlainBody(text) {
      return String(text ?? '')
        .split(/\r\n|\r|\n/)
        .map((line) => {
          let out = line.replace(/^\s*>\s?/, '')
          out = out.replace(/【([^】]*)】/g, '$1')
          out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
          out = out.replace(/`([^`]*)`/g, '$1')
          // 落单的标记（没成对的 ** 或反引号）直接抹掉，别让它留在框里难看
          return out.replace(/\*\*|`/g, '')
        })
        .join('\n')
    }

    /**
     * 把「用户编辑过的纯文本」合回原正文。
     *
     * 编辑框里看到的是去标记后的文字，但写回库里的不该全是裸文本 ——
     * 否则「打开面板看一眼再点保存」就把存量卡片里的加粗、代码标记全洗掉了。
     * 规则：内容没动的行保留原样（原标记还在），改过的 / 新加的行按纯文本写。
     */
    function mergeMarkup(original, edited) {
      const raw = String(original ?? '')
      const plain = toPlainBody(raw)
      const next = String(edited ?? '')
      if (next === plain) return raw
      const rawLines = raw.split(/\r\n|\r|\n/)
      const plainLines = plain.split(/\r\n|\r|\n/)
      const out = []
      let cursor = 0
      for (const line of next.split(/\r\n|\r|\n/)) {
        let hit = -1
        // 允许小幅错位：用户删掉一行时，它后面的行还能对上原来的标记
        for (let i = cursor; i < plainLines.length && i < cursor + 4; i += 1) {
          if (plainLines[i] === line) {
            hit = i
            break
          }
        }
        if (hit >= 0) {
          out.push(rawLines[hit])
          cursor = hit + 1
        } else {
          out.push(line)
        }
      }
      return out.join('\n')
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
      const picked = first.type === 'list' ? (first.items[0] ? first.items[0].runs : []) : first.runs
      // 摘要不画高亮：整句被【】包住时，一行 12px 小字会挂满一条橙色下划线，看着像超链接
      const runs = picked.map((run) => (run.hl ? { text: run.text } : run))
      const more = blocks.length > 1 || (first.type === 'list' && first.items.length > 1)
      return h(
        'span',
        { className: 'kb-preview' },
        renderRuns(runs, 'c-'),
        more ? h('span', { className: 'kb-more' }, '…') : null,
      )
    }

    function EntryCard(props) {
      const { entry, t, onOpen, onArchive, onRestore, onDelete, busy, score, coverage, selectable, selected, onToggle } = props
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

      const open = () => {
        if (selectable) {
          onToggle(entry.id)
          return
        }
        onOpen(entry)
      }

      return h(
        'article',
        {
          className: 'kb-card' + (archived ? ' archived' : '') + (selectable ? ' picking' : ''),
          onClick: open,
          role: 'button',
          tabIndex: 0,
          title: t('open'),
          style: { '--kb-tc': topicColor(entry.topic) },
        },
        h(
          'div',
          { className: 'kb-card-head' },
          selectable
            ? h(
                'span',
                {
                  className: 'kb-pick' + (selected ? ' on' : ''),
                  onClick: withStop(() => onToggle(entry.id)),
                  role: 'checkbox',
                  'aria-checked': !!selected,
                },
                selected ? '✓' : '',
              )
            : null,
          h('span', { className: 'kb-card-title' }, entry.title),
          entry.kind === 'qa' ? h(Badge, null, t('kindQa')) : null,
          entry.verified ? null : h(Badge, { tone: 'quiet' }, t('unverified')),
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
          h('span', { className: 'kb-score' }, versionMeta(entry.version, entry.updatedAt, true)),
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
      const { entry, t, busy, score, coverage, onClose, onArchive, onRestore, onDelete, onChanged } = props
      const [confirming, setConfirming] = useState(false)
      const [panel, setPanel] = useState('')
      const [rollbackBusy, setRollbackBusy] = useState(false)
      const timer = useRef(null)
      const archived = entry.status === 'archived'

      const rollback = async () => {
        setRollbackBusy(true)
        try {
          const data = await apiPost('/card/rollback', { id: entry.id, topic: entry.topic })
          if (onChanged) onChanged({ body: data.body, version: data.version, verified: false, verify: null })
        } catch (err) {
          if (typeof console !== 'undefined') console.warn('[learning-kb] 回退失败', err)
        } finally {
          setRollbackBusy(false)
        }
      }

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
              h(VerifyBadge, { card: entry, onToggle: () => setPanel(panel === 'verify' ? '' : 'verify') }),
              archived ? h(Badge, { tone: 'idle' }, t('archivedTag')) : null,
            ),
            entry.q ? h('div', { className: 'kb-modal-q' }, 'Q ' + entry.q) : null,
            h('div', { className: 'kb-modal-text' }, h(BodyBlocks, { body: entry.body })),
            panel === 'verify'
              ? h(VerifyPanel, {
                  card: entry,
                  onClose: () => setPanel(''),
                  onSaved: patch => {
                    if (onChanged) onChanged(patch)
                  },
                })
              : null,
            panel === 'work'
              ? h(Workbench, {
                  card: entry,
                  autoReview: true,
                  onClose: () => setPanel(''),
                  onSaved: patch => {
                    if (onChanged) onChanged(patch)
                  },
                })
              : null,
          ),
          h(
            'div',
            { className: 'kb-modal-foot' },
            h(
              'span',
              { className: 'kb-modal-meta' },
              (entry.topicName || entry.topic || '') + ' · ' + versionMeta(entry.version, entry.updatedAt),
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
            h('button', { className: 'kb-btn', disabled: busy, onClick: () => setPanel(panel === 'work' ? '' : 'work') }, t('actReview')),
            h('button', { className: 'kb-btn', disabled: rollbackBusy, onClick: rollback, title: t('rollback') }, t('rollback')),
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
      // 打开详情前正在取正文全文（列表只给摘要）
      const [detailLoading, setDetailLoading] = useState(false)
      const [multi, setMulti] = useState(false)
      const [picked, setPicked] = useState([])
      // 本页打开以来 AI 调用累计（校验 + 追问；不含检索重排）
      const tokenTotal = useTokenTotal()
      const [tick, setTick] = useState(0)
      const alive = useRef(true)
      const noticeTimer = useRef(null)
      /** 插件 AI 模型设置 + 可选模型目录（{aiModel, session, active, catalog}） */
      const [aiModelData, setAiModelData] = useState(null)
      const [aiModelBusy, setAiModelBusy] = useState(false)

      const refresh = useCallback(() => setTick((value) => value + 1), [])

      /**
       * 换插件 AI 调用用的模型。
       *
       * 「跟随会话」= 和主对话用同一个（旧行为）；选具体模型 = 只影响
       * 校验/追问/检索重排这三条一次性调用，**不动主对话的模型**。
       * 改完调 refresh() 让 /ai-model 与 /card/model 都重新拉一遍。
       */
      const chooseAiModel = async (next) => {
        setAiModelBusy(true)
        try {
          const value = String((next && next.value) || '__session__')
          let body
          if (value === '__session__') {
            body = { mode: 'session' }
          } else {
            const at = value.indexOf('|')
            body = {
              mode: 'fixed',
              provider: value.slice(0, at),
              model: value.slice(at + 1),
              // 换模型时档位重置为「默认」；只改档位时把当前模型带上
              reasoningEffort: next && next.effort ? String(next.effort) : null,
            }
          }
          await apiPost('/ai-model', { aiModel: body })
          refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setAiModelBusy(false)
        }
      }

      /**
       * 打开一条详情。
       *
       * 2026-10-23 审计 P1-8：列表接口现在只发 160 字摘要（一次少搬几十 KB），
       * 正文全文要用 GET /entry 单独取。**取全了再开弹窗** ——
       * 弹窗里的「编辑」是以正文为初值的，如果先拿摘要开弹窗、
       * 用户手快点下编辑，存回去的就是截断的正文。
       */
      const openDetail = useCallback((item) => {
        if (!item) return
        if (!item.bodyTruncated) {
          setDetail(item)
          return
        }
        setDetailLoading(true)
        apiGet('/entry', { id: item.id, topic: item.topic || '' })
          .then((data) => {
            if (!alive.current) return
            const full = data && data.entry ? data.entry : null
            setDetail(full ? { ...item, ...full } : item)
          })
          .catch(() => {
            // 取不到就还是用摘要打开：不能因为详情接口挂了就把用户挡在外面
            if (alive.current) setDetail(item)
          })
          .finally(() => {
            if (alive.current) setDetailLoading(false)
          })
      }, [])

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

      // 插件自己的 AI 模型设置 + 可选的模型目录（校验 / 追问 / 重排用哪个模型）
      useEffect(() => {
        const controller = new AbortController()
        apiGet('/ai-model', {}, controller.signal)
          .then((data) => {
            if (alive.current) setAiModelData(data)
          })
          .catch((err) => {
            if (err && err.name === 'AbortError') return
            // 枚举不到模型不是致命错误：选择器退回「跟随会话」，校验照常能用
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
      const unverifiedCount = list.filter(item => !item.verified).length

      const togglePick = (id) => {
        setPicked(current => (current.includes(id) ? current.filter(item => item !== id) : current.concat([id])))
      }

      const batchVerify = async () => {
        if (!picked.length) return
        setBusyId('batch')
        setError('')
        try {
          const data = await apiPost('/card/verify-batch', { ids: picked, by: 'user' })
          flash('已核实 ' + (data.count || picked.length) + ' 条')
          setPicked([])
          setMulti(false)
          refresh()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusyId('')
        }
      }

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
            `${totalActive} 条 · ${topics.length} 个主题`,
          ),
          h('span', { className: 'kb-grow' }),
          h(AiModelPicker, { data: aiModelData, busy: aiModelBusy, onChange: chooseAiModel }),
          tokenTotal > 0
            ? h(
                'span',
                {
                  className: 'kb-token-note',
                  title: '本页打开以来「AI 校验补充 / 问一下」消耗的 tokens 合计（检索重排的用量显示在回答下方那行里）',
                },
                'AI 累计 ' + formatTokens(tokenTotal) + ' tokens',
              )
            : null,
          h('span', { className: 'kb-rev', title: '当前加载的界面版本' }, 'UI ' + UI_REV),
          unverifiedCount > 0
            ? h(
                'button',
                {
                  className: 'kb-btn' + (multi ? ' primary' : ''),
                  onClick: () => {
                    setMulti(!multi)
                    setPicked([])
                  },
                  title: '批量把选中的条目标为已核实',
                },
                '未核实 ' + unverifiedCount + ' 条',
              )
            : null,
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
            h('div', { className: 'kb-rail-cap' }, '主题'),
            h(
              'div',
              {
                className: 'kb-topic' + (topic ? '' : ' on'),
                onClick: () => setTopic(''),
                style: { '--kb-tc': 'var(--kb-accent)' },
              },
              h('span', { className: 'kb-dot' }),
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
                  style: { '--kb-tc': topicColor(item.slug) },
                },
                h('span', { className: 'kb-dot' }),
                h('span', { className: 'kb-name' }, item.name),
                h('span', { className: 'kb-n' }, String(status === 'active' ? item.activeCount : item.count)),
              ),
            ),
            h('div', { className: 'kb-rail-foot' }, '共 ' + totalAll + ' 条'),
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
            loading && list.length === 0
              ? h(
                  'div',
                  { className: 'kb-empty' },
                  h('div', { className: 'kb-empty-title' }, t('loading')),
                  h('div', { className: 'kb-empty-hint' }, '正在读取本地知识库'),
                )
              : null,
            !loading && list.length === 0 && (searching || topics.length > 0)
              ? h(
                  'div',
                  { className: 'kb-empty' },
                  h(
                    'svg',
                    {
                      className: 'kb-empty-ico',
                      viewBox: '0 0 24 24',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                    },
                    h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
                    h('path', { d: 'M15.4 15.4 20 20' }),
                  ),
                  h(
                    'div',
                    { className: 'kb-empty-title' },
                    searching ? t('emptySearch') : topic ? t('emptyTopic') : t('emptyAll'),
                  ),
                  h(
                    'div',
                    { className: 'kb-empty-hint' },
                    searching ? '换个关键词试试，或者清空搜索看全部' : '点右上「新增」录入第一条知识',
                  ),
                  searching ? h('button', { className: 'kb-btn', onClick: () => setQuery('') }, '清空搜索') : null,
                )
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
                selectable: multi,
                selected: picked.includes(entry.id),
                onToggle: togglePick,
                onOpen: openDetail,
                onArchive: (item) => mutate('/archive', { topic: item.topic, id: item.id }, t('archive')),
                onRestore: (item) => mutate('/restore', { topic: item.topic, id: item.id }, t('restore')),
                onDelete: (item) => mutate('/delete', { topic: item.topic, id: item.id }, t('remove')),
              }),
              ),
            ),
          ),
        ),
        multi
          ? h(
              'div',
              { className: 'kb-batch' },
              h('span', null, '已选 ' + picked.length + ' 条'),
              h('span', { className: 'kb-grow' }),
              h(
                'button',
                { className: 'kb-btn primary', disabled: !picked.length || busyId === 'batch', onClick: batchVerify },
                '批量标为已核实' + (picked.length ? ' (' + picked.length + ')' : ''),
              ),
              h(
                'button',
                {
                  className: 'kb-btn',
                  onClick: () => {
                    setMulti(false)
                    setPicked([])
                  },
                },
                t('close'),
              ),
            )
          : null,
        detailLoading
          ? h(
              'div',
              { className: 'kb-overlay' },
              h(
                'div',
                { className: 'kb-modal' },
                h('div', { className: 'kb-modal-body' }, '正在取完整正文…'),
              ),
            )
          : null,
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
              onChanged: (patch) => {
                setDetail(current => (current ? { ...current, ...patch } : current))
                refresh()
              },
            })
          : null,
      )
    }

    // ---------------------------------------------------------------- 注册
    // ---------------------------------------------------------------- 会话内卡片
    //
    // 工具结果里带结构化卡片：learn_search / learn_save 的 output.presentationMeta
    // 落到工具结果的 block.meta.kbCards，浏览器半侧按 wire 工具名在
    // tool.call.toolview 这个 keyed slot 上注册自己的行（和官方 skill 工具同一个套路）。
    //
    // 为什么工作台 / 追问都「就地展开」而不是浮层：
    //   会话区在 DOM 里很深，浮层要靠 portal 才能躲开祖先的 transform；
    //   而这个浏览器半侧只保证能 require('react')，不保证有 react-dom。
    //   就地展开没有这些依赖，也不会被祖先的 overflow 裁掉。

    /** 从工具结果里取出结构化卡片。 */
    function cardsOf(block) {
      return cardsOfKey(block, 'kbCards')
    }

    /** 相关补充卡片（重排判定为「同领域但不是答案」的那一组）。 */
    function relatedCardsOf(block) {
      return cardsOfKey(block, 'kbRelated')
    }

    function cardsOfKey(block, key) {
      if (!block || typeof block !== 'object') return []
      const meta = block.meta
      if (!meta || typeof meta !== 'object') return []
      const list = meta[key]
      if (!Array.isArray(list)) return []
      return list.filter(card => card && typeof card === 'object' && card.title)
    }

    /** 工具入参里的检索词（兜底用：万一 meta 没带过来，就按这个词再查一次）。 */
    function queryOfArgs(block) {
      if (!block || typeof block !== 'object') return ''
      const raw = block.call && block.call.argsRaw
      if (typeof raw !== 'string' || !raw) return ''
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? String(parsed.query || '') : ''
      } catch {
        return ''
      }
    }

    /** 正文契约的本地检查（服务端还会再查一遍，这里只是提前给反馈）。 */
    function contractCheck(body) {
      const text = String(body || '').trim()
      const lines = text.split('\n')
      const first = (lines[0] || '').trim()
      const ticks = (text.match(/`/g) || []).length
      const open = (text.match(/【/g) || []).length
      const close = (text.match(/】/g) || []).length
      return {
        empty: !text,
        lead: !!text && !first.startsWith('- '),
        bullet: lines.some(line => line.trim().startsWith('- ')),
        backtick: ticks % 2 === 0,
        bracket: open === close,
      }
    }

    /** 把一条补充变成要点行。 */
    function toBullet(text) {
      const value = String(text || '').trim()
      if (!value) return ''
      if (value.startsWith('- ')) return value
      return '- ' + value.replace(/\n+/g, ' ')
    }

    /** 核实徽标：已核实显示绿勾，未核实可点。 */
    function VerifyBadge(props) {
      const { card, onToggle } = props
      if (card.verified) {
        const info = card.verify || {}
        const who = info.by === 'ai-assisted' ? translate('verifyByAi') : info.by === 'source' ? translate('verifyBySource') : translate('verifyByUser')
        const tip = [info.at ? fmtTime(info.at) : '', who, info.note || ''].filter(Boolean).join(' · ')
        return h('span', { className: 'kb-badge ok', title: tip }, '✓')
      }
      return h(
        'button',
        { className: 'kb-badge quiet clickable', onClick: onToggle, title: translate('verifyTitle') },
        translate('unverified'),
      )
    }

    /**
     * 取「校验会用的模型」。
     *
     * 模型跟着当前会话走（宿主读 agentDefaultModel），所以打开面板时先问一次，
     * 不用等校验跑完就能把「模型 xxx」标出来。接口不存在（还没重启）时安静失败，
     * 面板照常能用，只是暂时看不到模型名。
     */
    function useKbModel() {
      const [info, setInfo] = useState(null)
      useEffect(() => {
        let alive = true
        apiGet('/card/model')
          .then(data => {
            if (!alive) return
            if (data && data.model) setInfo({ provider: data.provider || '', model: String(data.model), effort: data.reasoningEffort ? String(data.reasoningEffort) : '' })
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      return info
    }

    // ---------------------------------------------------------------- 校验结果缓存
    // 「AI 校验补充」每点开一次都会重跑一遍模型：同一张卡、同一版正文、同一个模型，
    // 重复点纯属白烧额度。结果按 (卡片, 模式, 版本, 正文指纹) 缓存：
    //   · 卡片改过（版本或正文变了）→ key 变了，自然失效
    //   · 换过模型 → 不拿旧结果冒充「跟当前会话对齐」
    //   · 用户点「重新校验」→ 强制重跑
    // 失败 / 解析失败的结果不进缓存：下次点开必须真的重试。
    const REVIEW_CACHE = new Map()
    const REVIEW_TTL_MS = 30 * 60 * 1000
    const REVIEW_CACHE_MAX = 40

    /** 正文指纹：只用来判断「是不是同一版」，不参与展示。 */
    function hashText(text) {
      const source = String(text ?? '')
      let hash = 5381
      for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) >>> 0
      return hash.toString(36)
    }

    function reviewCacheKey(card, mode) {
      const target = card || {}
      return [target.id || '', target.topic || '', mode || 'both', target.version || 1, hashText(target.body || '')].join('|')
    }

    function reviewCacheGet(card, mode, model) {
      const key = reviewCacheKey(card, mode)
      const entry = REVIEW_CACHE.get(key)
      if (!entry) return null
      if (Date.now() - entry.at > REVIEW_TTL_MS) {
        REVIEW_CACHE.delete(key)
        return null
      }
      if (model && entry.data && entry.data.model && entry.data.model !== model) return null
      return entry.data
    }

    function reviewCacheSet(card, mode, data) {
      if (!data || data.ok !== true || data.parseError) return
      const key = reviewCacheKey(card, mode)
      REVIEW_CACHE.set(key, { at: Date.now(), data })
      while (REVIEW_CACHE.size > REVIEW_CACHE_MAX) {
        const oldest = REVIEW_CACHE.keys().next()
        if (oldest.done) break
        REVIEW_CACHE.delete(oldest.value)
      }
    }

    function reviewCacheClear() {
      REVIEW_CACHE.clear()
    }

    // ---------------------------------------------------------------- token 用量
    // 宿主把 llm.stream 的 usage 原值带回来了（校验 / 追问各是一次调用）。
    // 这里只负责展示，不估算：宿主没给就什么都不显示，绝不编一个数字。
    //   · 每个面板「本次 N tokens」（缓存命中显示「上次」）
    //   · 侧边栏「AI 累计 N tokens」——用 sessionStorage 记，刷新页面还在
    const TOKEN_STORE_KEY = 'kb-token-usage'
    const tokenListeners = new Set()
    let tokenTotalCache = null

    function readTokenTotal() {
      if (tokenTotalCache !== null) return tokenTotalCache
      let value = 0
      try {
        if (typeof sessionStorage !== 'undefined') value = Number(sessionStorage.getItem(TOKEN_STORE_KEY)) || 0
      } catch {
        value = 0
      }
      tokenTotalCache = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
      return tokenTotalCache
    }

    function addTokenUsage(usage) {
      const amount = Number(usage && usage.totalTokens)
      if (!Number.isFinite(amount) || amount <= 0) return readTokenTotal()
      tokenTotalCache = readTokenTotal() + Math.round(amount)
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(TOKEN_STORE_KEY, String(tokenTotalCache))
      } catch {
        // 隐私模式 / 禁用存储：只影响刷新后还记不记得，不影响本次显示
      }
      for (const listener of tokenListeners) {
        try {
          listener(tokenTotalCache)
        } catch {
          // 单个监听器坏了不该拖垮别的面板
        }
      }
      return tokenTotalCache
    }

    function useTokenTotal() {
      const [value, setValue] = useState(readTokenTotal())
      useEffect(() => {
        const listener = (next) => setValue(next)
        tokenListeners.add(listener)
        return () => {
          tokenListeners.delete(listener)
        }
      }, [])
      return value
    }

    function formatTokens(value) {
      const n = Math.round(Number(value) || 0)
      return n.toLocaleString('en-US')
    }

    // ---------------------------------------------------------------- 版本号显示
    // 版本号规则（2026-10-23 用户定）：写入时刻的时间戳（epoch 毫秒）。
    // 好处：跨端能直接比新旧；回退到原版时版本号跟着正文回到原版那一刻。
    // 老数据还是小整数（1、2、3…），显示时按老样子。
    function isStampVersion(value) {
      const n = Number(value)
      return Number.isFinite(n) && n >= 1e12
    }

    /**
     * 「版本 · 时间」的显示。
     *
     * 版本号现在是时间戳（写入那一刻），它**本身就是**「最后修改时间」——
     * 再补一段 updatedAt 就是同一个时间显示两遍（2026-10-23 用户反馈：
     * 「版本号既然是用时间戳，那就不要还有一块时间」）。
     * 老数据（版本号还是 v1/v2 这种小整数）没有时间含义，才需要补 updatedAt。
     *
     * @param {number|string} version 版本号
     * @param {string} [updatedAt] 条目的更新时间（ISO）
     * @param {boolean} [short] 用短格式（卡片脚上）
     * @returns {string}
     */
    function versionMeta(version, updatedAt, short = false) {
      const stamp = short ? shortVersion(version) : formatVersion(version)
      if (isStampVersion(Number(version))) return stamp
      return updatedAt ? stamp + ' · ' + fmtTime(updatedAt) : stamp
    }

    const pad2 = (value) => String(value).padStart(2, '0')

    /** 完整版本号：'2026-10-23 01:28'；老数据 'v2'。 */
    function formatVersion(version) {
      const n = Number(version)
      if (!Number.isFinite(n)) return 'v' + String(version == null ? '' : version)
      if (!isStampVersion(n)) return 'v' + n
      const date = new Date(n)
      return (
        date.getFullYear() +
        '-' +
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    /** 卡片脚上的短版本号：'10-23 01:28'。 */
    function shortVersion(version) {
      const n = Number(version)
      if (!Number.isFinite(n) || !isStampVersion(n)) return 'v' + n
      const date = new Date(n)
      return (
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      )
    }

    // ---------------------------------------------------------------- 卡片版本新鲜度
    // 会话里的卡片是「打开那一刻」的快照。别的端（或这个端的另一个会话）改了这条，
    // 库里版本号就往前走；手里这份再写就会被 expectedVersion 挡下来（409），
    // 而用户根本看不出自己拿着旧版 —— 所以提前问一句，过期就把编辑类按钮禁用掉。
    const CARD_VERSION_TTL = 20_000
    const cardVersionCache = new Map()
    /** 服务端一次最多接受 50 个 id（handleCardVersions 里 slice(0, 50)）。 */
    const CARD_VERSION_BATCH_MAX = 50

    function cardVersionKey(id, topic) {
      return String(id || '') + '|' + String(topic || '')
    }

    function readCardVersion(id, topic) {
      const key = cardVersionKey(id, topic)
      const hit = cardVersionCache.get(key)
      if (!hit) return null
      if (Date.now() - hit.at > CARD_VERSION_TTL) {
        cardVersionCache.delete(key)
        return null
      }
      return hit.data
    }

    function writeCardVersion(id, topic, data) {
      if (!id || !data) return
      cardVersionCache.set(cardVersionKey(id, topic), { at: Date.now(), data })
    }

    /**
     * 同一批渲染里的卡片版本查询，合并成一次请求。
     *
     * 2026-10-23 审计 P1-7：原来每张卡片各发一次 GET /card/versions，
     * 一轮回答出 8 张卡就是 8 个请求（host 实测每个 13.6ms，但那是串行等待）。
     * 现在同一帧里所有卡片把自己的 id 报上来，攒齐了**一次**问完
     * （接口本来就支持一次最多 50 个 id）。
     */
    const versionBatches = new Map()

    function flushVersionBatch(topic) {
      const batch = versionBatches.get(topic)
      if (!batch) return
      versionBatches.delete(topic)
      const ids = Array.from(batch.ids)
      const waiters = batch.waiters
      const done = map => {
        for (const resolve of waiters) resolve(map)
      }
      if (!ids.length) {
        done({})
        return
      }
      // 服务端一次最多收 50 个 id，超了就分几批问，别把后面的悄悄丢掉
      const chunks = []
      for (let i = 0; i < ids.length; i += CARD_VERSION_BATCH_MAX) {
        chunks.push(ids.slice(i, i + CARD_VERSION_BATCH_MAX))
      }
      const map = {}
      Promise.all(
        chunks.map(chunk =>
          apiGet('/card/versions', { ids: chunk.join(','), topic: String(topic || '') })
            .then(data => {
              const versions = data && data.versions ? data.versions : {}
              for (const id of chunk) {
                const info = versions[id] || null
                if (info) writeCardVersion(id, topic, info)
                map[id] = info
              }
            })
            .catch(() => {
              // 拿不到就不乱禁用（和原来一样：请求失败一律不判定过期）
            }),
        ),
      ).then(() => done(map))
    }

    /**
     * 问一批卡片「库里现在是什么版本」。
     * @param {string[]} ids 卡片 id
     * @param {string} topic 主题
     * @returns {Promise<Record<string, object|null>>} id → {version, updatedAt}
     */
    function fetchCardVersions(ids, topic) {
      const list = Array.from(new Set((ids || []).filter(Boolean)))
      if (!list.length) return Promise.resolve({})
      const key = String(topic || '')
      let batch = versionBatches.get(key)
      if (!batch) {
        batch = { ids: new Set(), waiters: [], timer: null }
        versionBatches.set(key, batch)
      }
      for (const id of list) batch.ids.add(id)
      return new Promise(resolve => {
        batch.waiters.push(resolve)
        if (batch.timer) return
        // 同一帧里把大家的 id 收齐，再一次性发出去
        batch.timer = setTimeout(() => flushVersionBatch(key), 0)
      })
    }

    /** 手里这张卡是不是旧版：{ stale, current }。current = 库里现在的版本号。 */
    function useCardStale(card) {
      const [state, setState] = useState({ stale: false, current: 0 })
      const id = card && card.id ? card.id : ''
      const topic = card && card.topic ? card.topic : ''
      const version = card && card.version ? card.version : 1
      useEffect(() => {
        let alive = true
        if (!id) return undefined
        const apply = info => {
          if (!alive || !info) return
          const current = Number(info.version) || 0
          // 版本号不一样就算旧版：回退会让版本号往回走，单纯比大小会漏判
          setState({ stale: current !== Number(version), current })
        }
        const cached = readCardVersion(id, topic)
        if (cached) {
          apply(cached)
          return undefined
        }
        fetchCardVersions([id], topic)
          .then(map => apply(map && map[id]))
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [id, topic, version])
      return state
    }

    /** 模型标签：标题旁边的小圆角块，一眼能看到这次用的是哪个 AI。 */
    function ModelChip(props) {
      const model = props.model
      if (!model) return null
      // 思考档位也标出来：思考型模型（MiniMax-M3 这类）会把输出预算花在思考上，
      // 档位一高就容易出现「只有思考、没有正文」。
      const effort = props.effort ? ' · ' + props.effort : ''
      return h(
        'span',
        { className: 'kb-model-chip', title: translate('workModelTip') },
        translate('workModel') + ' ' + model + effort,
      )
    }

    /** 核实面板：三条路径按「区块」排，一条一块，带编号、标题、一句说明。
     *
     * 旧版是「标签 + 按钮」平铺成几行，字号 11.5px，用户反馈太小、分不清三条路径。
     * 现在改成卡片式：顶部标题条 + 三个区块，AI 结果单独一块用左侧警示线框住。
     */
    function VerifySection(props) {
      const { no, title, desc, children } = props
      return h(
        'div',
        { className: 'kb-vsec' },
        h(
          'div',
          { className: 'kb-vsec-head' },
          h('span', { className: 'kb-vsec-no' }, no),
          h('span', { className: 'kb-vsec-title' }, title),
        ),
        desc ? h('div', { className: 'kb-vsec-desc' }, desc) : null,
        children,
      )
    }

    /**
     * 插件 AI 调用用哪个模型（校验 / 追问 / 检索重排）。
     *
     * 为什么不直接跟会话：为了绕开「某个模型一次校验要 100 秒」而切会话模型时，
     * 会把主对话的模型也一起换掉。这里让这三条一次性调用单独选，互不影响。
     * 选项来自宿主 llm 服务的 listProviders / listModels 枚举，不是写死的名单。
     */
    function AiModelPicker(props) {
      const data = props.data
      if (!data) return null
      const current = data.aiModel || { mode: 'session' }
      const catalog = Array.isArray(data.catalog) ? data.catalog : []
      const session = data.session || null
      const fixedKey = current.mode === 'fixed' ? current.provider + '|' + current.model : '__session__'
      const fixedEntry =
        current.mode === 'fixed'
          ? catalog.find(item => item.provider === current.provider && item.id === current.model)
          : null
      const efforts = fixedEntry && Array.isArray(fixedEntry.efforts) ? fixedEntry.efforts : []
      return h(
        'span',
        { className: 'kb-ai-model' },
        h(
          'select',
          {
            className: 'kb-select kb-ai-model-select',
            value: fixedKey,
            disabled: props.busy,
            title:
              '插件自己的 AI 调用（校验 / 追问 / 检索重排）用哪个模型；' +
              '和主对话的模型相互独立，换这里不会换掉对话模型',
            onChange: event => props.onChange({ value: event.target.value }),
          },
          [
            h(
              'option',
              { key: '__session__', value: '__session__' },
              'AI 模型：跟随会话' + (session && session.model ? '（' + session.model + '）' : ''),
            ),
            ...catalog.map(item =>
              h(
                'option',
                { key: item.provider + '|' + item.id, value: item.provider + '|' + item.id },
                item.name + '（' + item.providerName + '）',
              ),
            ),
          ],
        ),
        fixedEntry && efforts.length
          ? h(
              'select',
              {
                className: 'kb-select kb-ai-model-select',
                value: current.reasoningEffort || '',
                disabled: props.busy,
                title: '思考档位：越高越准也越慢、越贵；这类一次性任务通常「低」就够',
                onChange: event => props.onChange({ value: fixedKey, effort: event.target.value }),
              },
              [
                h('option', { key: '__default__', value: '' }, '档位：默认'),
                ...efforts.map(effort =>
                  h('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
                ),
              ],
            )
          : null,
      )
    }

    /**
     * 等待提示：思考型模型一次校验要几十秒到两分钟。
     *
     * 不说清楚的话，用户干等着会以为界面卡死了 —— 2026-10-23 用户反馈
     * 「会卡很久，我不知道是不是有什么问题」。这里把已等待秒数摆出来。
     */
    function WaitNote(props) {
      const busy = props.busy
      const [sec, setSec] = useState(0)
      useEffect(() => {
        if (!busy) {
          setSec(0)
          return undefined
        }
        const t0 = Date.now()
        const timer = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 1000)
        return () => clearInterval(timer)
      }, [busy])
      if (!busy) return null
      return h(
        'span',
        { className: 'kb-wait-note', title: translate('workWaitedShort') },
        translate('workWaiting') + sec + translate('workWaitingSec'),
      )
    }

    function VerifyPanel(props) {
      const { card, onClose, onSaved } = props
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [review, setReview] = useState(null)
      const [cached, setCached] = useState(false)
      const [source, setSource] = useState('')
      const [showSource, setShowSource] = useState(false)

      const mark = async (by, note) => {
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/verify', { id: card.id, topic: card.topic, state: 'verified', by, note })
          onSaved({ verified: true, verify: data.verify })
          onClose()
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      /** force=true 跳过缓存（用户主动点「重新校验」时）。 */
      const runAi = async (force) => {
        if (!force) {
          const hit = reviewCacheGet(card, 'verify', (modelInfo && modelInfo.model) || '')
          if (hit) {
            setReview(hit)
            setCached(true)
            setErr('')
            return
          }
        }
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/review', { id: card.id, topic: card.topic, mode: 'verify' })
          if (!data.ok) {
            setErr(data.reason || translate('saveFailed'))
            return
          }
          reviewCacheSet(card, 'verify', data)
          addTokenUsage(data.usage)
          setReview(data)
          setCached(false)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const issues = review && Array.isArray(review.issues) ? review.issues : []
      const aiParseFailed = review !== null && review.parseError === true
      const aiClean = review !== null && !aiParseFailed && issues.length === 0
      const modelInfo = useKbModel()

      return h(
        'div',
        { className: 'kb-verify' },
        h(
          'div',
          { className: 'kb-verify-cap' },
          h('span', null, translate('verifyTitle')),
          h(ModelChip, {
            model: (review && review.model) || (modelInfo && modelInfo.model) || '',
            effort: (modelInfo && modelInfo.effort) || '',
          }),
          review && review.usage && review.usage.totalTokens
            ? h(
                'span',
                {
                  className: 'kb-token-note',
                  title:
                    '输入 ' +
                    formatTokens(review.usage.inputTokens) +
                    '（未命中缓存的部分）· 输出 ' +
                    formatTokens(review.usage.outputTokens) +
                    ' · 合计 ' +
                    formatTokens(review.usage.totalTokens) +
                    '（合计含缓存命中的输入）',
                },
                (cached ? '上次 ' : '本次 ') + formatTokens(review.usage.totalTokens) + ' tokens',
              )
            : null,
          h('span', { className: 'kb-verify-cap-note' }, translate('verifyCapNote')),
        ),

        // ① 自己确认
        h(
          VerifySection,
          { no: '1', title: translate('verifySelfShort'), desc: translate('verifySelfDesc') },
          h(
            'div',
            { className: 'kb-vsec-act' },
            h(
              'button',
              { className: 'kb-vbtn primary', disabled: busy, onClick: () => mark('user', null) },
              translate('verifySelfBtn'),
            ),
          ),
        ),

        // ② 让 AI 先查
        h(
          VerifySection,
          { no: '2', title: translate('verifyAiShort'), desc: translate('verifyAiDesc') },
          h(
            'div',
            { className: 'kb-vsec-act' },
            review === null
              ? h(
                  'button',
                  { className: 'kb-vbtn', disabled: busy, onClick: () => runAi(false) },
                  busy ? translate('workRunning') : translate('verifyAiBtn'),
                )
              : null,
            h(WaitNote, { busy }),
          ),
          // 复用缓存结果时给一句提示 + 一个能强制重跑的入口
          review && cached
            ? h(
                'div',
                { className: 'kb-vsec-act' },
                h('span', { className: 'kb-cache-note' }, translate('workCachedNote')),
                h(
                  'button',
                  { className: 'kb-vbtn', disabled: busy, onClick: () => runAi(true) },
                  translate('workRunAgain'),
                ),
              )
            : null,
          aiClean
            ? h(
                'div',
                { className: 'kb-vsec-act' },
                h('span', { className: 'kb-vok' }, translate('verifyNoIssue')),
                h(
                  'button',
                  { className: 'kb-vbtn primary', disabled: busy, onClick: () => mark('ai-assisted', null) },
                  translate('verifyNoIssueBtn'),
                ),
              )
            : null,
          aiParseFailed
            ? h(
                'div',
                { className: 'kb-vissues' },
                h('div', { className: 'kb-vissues-cap' }, translate('aiParseFailed')),
                h('div', { className: 'kb-vissue' }, translate('aiParseFailedHint')),
                h(
                  'button',
                  { className: 'kb-vbtn', onClick: () => runAi(true) },
                  translate('aiRetry'),
                ),
              )
            : null,
          issues.length
            ? h(
                'div',
                { className: 'kb-vissues' },
                h('div', { className: 'kb-vissues-cap' }, translate('verifyIssuesCap') + ' · ' + issues.length),
                issues.map((issue, index) => h('div', { className: 'kb-vissue', key: 'i' + index }, issue.text)),
              )
            : null,
        ),

        // ③ 附出处
        h(
          VerifySection,
          { no: '3', title: translate('verifySourceShort'), desc: translate('verifySourceDesc') },
          h(
            'div',
            { className: 'kb-vsec-act' },
            showSource
              ? null
              : h(
                  'button',
                  { className: 'kb-vbtn', onClick: () => setShowSource(true) },
                  translate('verifySourceBtn'),
                ),
            showSource
              ? h('input', {
                  className: 'kb-input kb-verify-input',
                  value: source,
                  placeholder: translate('verifySourcePh'),
                  onChange: (event) => setSource(event.target.value),
                })
              : null,
            showSource
              ? h(
                  'button',
                  { className: 'kb-vbtn primary', disabled: busy || !source.trim(), onClick: () => mark('source', source.trim()) },
                  translate('verifySourceSave'),
                )
              : null,
            showSource
              ? h('button', { className: 'kb-vbtn', onClick: () => setShowSource(false) }, translate('workCancel'))
              : null,
          ),
        ),

        err ? h('div', { className: 'kb-err' }, err) : null,
      )
    }

    /** 追问区：只带这张卡片 + 这张卡片自己的追问历史（不落库、不进会话上下文）。 */
    function AskThread(props) {
      const { card, onClose } = props
      const [history, setHistory] = useState([])
      const [question, setQuestion] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')

      const send = async () => {
        const text = question.trim()
        if (!text || busy) return
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/ask', { id: card.id, topic: card.topic, question: text, history })
          if (!data.ok) {
            setErr(data.reason || translate('saveFailed'))
            return
          }
          setHistory(list => list.concat([{ q: text, a: data.answer, usage: data.usage || null }]))
          addTokenUsage(data.usage)
          setQuestion('')
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'kb-ask' },
        h('div', { className: 'kb-work-cap' }, translate('askTitle')),
        h('div', { className: 'kb-work-note' }, translate('askHint')),
        history.length === 0 ? h('div', { className: 'kb-work-note' }, translate('askEmpty')) : null,
        history.map((turn, index) =>
          h(
            'div',
            { className: 'kb-ask-turn', key: 't' + index },
            h('div', { className: 'kb-ask-q' }, '问：' + turn.q),
            h('div', { className: 'kb-ask-a' }, '答：' + turn.a),
            turn.usage && turn.usage.totalTokens
              ? h(
                  'div',
                  { className: 'kb-ask-meta' },
                  '这次 ' +
                    formatTokens(turn.usage.totalTokens) +
                    ' tokens（输入 ' +
                    formatTokens(turn.usage.inputTokens) +
                    ' · 输出 ' +
                    formatTokens(turn.usage.outputTokens) +
                    '）',
                )
              : null,
          ),
        ),
        err ? h('div', { className: 'kb-err' }, err) : null,
        h(
          'div',
          { className: 'kb-ask-input' },
          h('input', {
            className: 'kb-input',
            value: question,
            placeholder: translate('askPlaceholder'),
            onChange: (event) => setQuestion(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') send()
            },
          }),
          h('button', { className: 'kb-btn primary', disabled: busy || !question.trim(), onClick: send }, busy ? translate('workRunning') : translate('askSend')),
          h('button', { className: 'kb-btn', disabled: !history.length, onClick: () => setHistory([]) }, translate('askClear')),
          h('button', { className: 'kb-btn', onClick: onClose }, translate('close')),
        ),
      )
    }

    /** 卡片工作台：编辑正文 + 逐条采纳/忽略 + 覆盖前二次确认。 */
    function Workbench(props) {
      const { card, autoReview, onClose, onSaved } = props
      // rawRef 存库里那份（带 **粗体** / `代码` 标记），只用于合并；
      // 编辑框里放的是去标记后的纯文本，读着舒服，改完再按行合回去。
      const rawRef = useRef(card.body || '')
      const [body, setBody] = useState(() => toPlainBody(card.body || ''))
      const [review, setReview] = useState(null)
      const [cached, setCached] = useState(false)
      // 库里那一版（覆盖 / 回退后更新），用来判断"编辑框里现在这份跟库里是不是一样"
      const [stored, setStored] = useState(() => ({ version: card.version || 1, body: card.body || '' }))
      const [showCurrent, setShowCurrent] = useState(false)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [ok, setOk] = useState('')
      const [confirm, setConfirm] = useState(false)
      const [version, setVersion] = useState(card.version || 1)
      const started = useRef(false)

      const check = contractCheck(body)
      const modelInfo = useKbModel()
      // 编辑框里现在这份（= 改完之后要写回去的那份）；跟库里那份不同就是「未保存」
      const currentBody = mergeMarkup(rawRef.current, body)
      const dirty = currentBody !== stored.body

      /** force=true 跳过缓存：用户点「重新校验」或上一次解析失败要重试时才走这条路。 */
      const runReview = async (force) => {
        const model = (modelInfo && modelInfo.model) || ''
        if (!force) {
          const hit = reviewCacheGet(card, 'both', model)
          if (hit) {
            setReview(hit)
            setCached(true)
            setErr('')
            return
          }
        }
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/review', { id: card.id, topic: card.topic, mode: 'both' })
          if (!data.ok) {
            setErr(data.reason || translate('saveFailed'))
            return
          }
          reviewCacheSet(card, 'both', data)
          // 用了几 token 是真实花费，缓存命中不重复计
          addTokenUsage(data.usage)
          setReview(data)
          setCached(false)
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      useEffect(() => {
        if (!autoReview || started.current) return
        started.current = true
        runReview(false)
      }, [autoReview])

      const adopt = (text) => {
        const bullet = toBullet(toPlainBody(text))
        if (!bullet) return
        setBody(prev => (prev.trim() ? prev.replace(/\s*$/, '') + '\n' + bullet : bullet))
      }

      const apply = async () => {
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/apply', {
            id: card.id,
            topic: card.topic,
            // 框里是纯文本，写回前把没改动的行还原成带标记的原样
            body: mergeMarkup(rawRef.current, body),
            expectedVersion: version,
            model: review && review.model ? review.model : null,
          })
          setVersion(data.version)
          setConfirm(false)
          if (typeof data.body === 'string') {
            rawRef.current = data.body
            setBody(toPlainBody(data.body))
            setStored({ version: data.version || version, body: data.body })
          }
          setOk(translate('workSaved') + ' · ' + formatVersion(data.version) + (data.verifyReset ? ' · ' + translate('verifyReset') : ''))
          onSaved({ version: data.version, body: data.body, verified: false, verify: null })
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const checkLine = (label, good) =>
        h('span', { className: good ? 'yes' : 'no' }, (good ? '✓ ' : '✕ ') + label)

      const rollback = async () => {
        setBusy(true)
        setErr('')
        try {
          const data = await apiPost('/card/rollback', { id: card.id, topic: card.topic })
          rawRef.current = data.body
          setBody(toPlainBody(data.body))
          setVersion(data.version)
          setStored({ version: data.version, body: data.body })
          setOk(translate('rollbackDone') + ' · ' + formatVersion(data.version))
          onSaved({ version: data.version, body: data.body, verified: false, verify: null })
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'kb-verify kb-workpanel' },
        h(
          'div',
          { className: 'kb-verify-cap' },
          h('span', null, translate('workTitle')),
          // 校验用的是「当前会话选的模型」，这里把它标成醒目的标签，
          // 用户才知道对齐没对齐（数据优先取本次结果，其次取面板打开时问到的选择）
          h(ModelChip, {
            model: (review && review.model) || (modelInfo && modelInfo.model) || '',
            effort: (modelInfo && modelInfo.effort) || '',
          }),
          review && review.usage && review.usage.totalTokens
            ? h(
                'span',
                {
                  className: 'kb-token-note',
                  title:
                    '输入 ' +
                    formatTokens(review.usage.inputTokens) +
                    '（未命中缓存的部分）· 输出 ' +
                    formatTokens(review.usage.outputTokens) +
                    ' · 合计 ' +
                    formatTokens(review.usage.totalTokens) +
                    '（合计含缓存命中的输入）',
                },
                (cached ? '上次 ' : '本次 ') + formatTokens(review.usage.totalTokens) + ' tokens',
              )
            : null,
          h('span', { className: 'kb-verify-cap-note' }, translate('workCapNote')),
          h(
            'button',
            { className: 'kb-vbtn', disabled: busy, onClick: () => runReview(true) },
            busy ? translate('workRunning') : review ? translate('workRunAgain') : translate('workRun'),
          ),
          h(WaitNote, { busy }),
          // 这次模型想了多少字、跑了多久：把「为什么慢」摊开给用户看
          review && review.reasoningChars
            ? h(
                'span',
                { className: 'kb-token-note', title: translate('workWaitedShort') },
                translate('workThinking') + review.reasoningChars + ' 字 · ' + Math.round((review.elapsedMs || 0) / 1000) + 's',
              )
            : null,
          // 复用上次结果时必须说一声，否则用户会以为又调了一次模型
          review && cached ? h('span', { className: 'kb-cache-note' }, translate('workCachedNote')) : null,
          h('button', { className: 'kb-vbtn', onClick: onClose }, translate('close')),
        ),

        // 模型没按 JSON 回答：必须明说，不能让它看起来像「AI 没发现问题」。
        // 2026-10-22 实测 DeepSeek 返回了非 JSON 的解释文字，旧的静默处理把
        // 「解析失败」显示成「没有发现」，等于骗用户这条已经查过了。
        review && review.parseError
          ? h(
              VerifySection,
              { no: '!', title: translate('aiParseFailed'), desc: translate('aiParseFailedHint') },
              review.rawPreview
                ? h('div', { className: 'kb-add kb-raw' }, review.rawPreview)
                : null,
              h(
                'div',
                { className: 'kb-vsec-act' },
                h('button', { className: 'kb-vbtn primary', disabled: busy, onClick: () => runReview(true) }, translate('aiRetry')),
              ),
            )
          : null,

        // ① AI 发现的问题：一条一块，可逐条忽略
        review && !review.parseError && review.issues && review.issues.length
          ? h(
              VerifySection,
              {
                no: '1',
                title: translate('workIssues') + ' · ' + review.issues.length,
                desc: translate('workIssuesDesc'),
              },
              h(
                'div',
                { className: 'kb-vissues' },
                review.issues.map((issue, index) =>
                  h(
                    'div',
                    { className: 'kb-addrow', key: 'i' + index },
                    h('span', { className: 'kb-vissue kb-grow' }, issue.text),
                    h(
                      'button',
                      {
                        className: 'kb-vbtn',
                        onClick: () => setReview({ ...review, issues: review.issues.filter((_, i) => i !== index) }),
                      },
                      translate('workIgnore'),
                    ),
                  ),
                ),
              ),
            )
          : null,

        // ② 可以补进卡片的要点：采纳 = 追加成一条 "- " 要点
        // 解析成功就一定显示这块，没有内容时给一句「没找到可补充的」——
        // 沉默会让用户分不清「AI 觉得没啥可补」和「功能坏了」。
        review && !review.parseError
          ? h(
              VerifySection,
              {
                no: '2',
                title: translate('workAdditions') + ' · ' + review.additions.length,
                desc: translate('workAdditionsDesc'),
              },
              review.additions.length === 0
                ? h('div', { className: 'kb-work-note' }, translate('workNoAdditions'))
                : review.additions.map((addition, index) =>
                    h(
                      'div',
                      { className: 'kb-addrow', key: 'a' + index },
                      h('span', { className: 'kb-add kb-grow' }, toPlainBody(addition.text)),
                      h('button', { className: 'kb-vbtn primary', onClick: () => adopt(addition.text) }, translate('workAdopt')),
                      h(
                        'button',
                        {
                          className: 'kb-vbtn',
                          onClick: () => setReview({ ...review, additions: review.additions.filter((_, i) => i !== index) }),
                        },
                        translate('workIgnore'),
                      ),
                    ),
                  ),
            )
          : null,

        // ③ AI 建议的改写：整段替换，属于重手，单独一块
        review && review.suggested
          ? h(
              VerifySection,
              { no: '3', title: translate('workSuggested'), desc: translate('workSuggestedDesc') },
              h('div', { className: 'kb-add' }, toPlainBody(review.suggested)),
              h(
                'div',
                { className: 'kb-vsec-act' },
                h(
                  'button',
                  { className: 'kb-vbtn', onClick: () => setBody(toPlainBody(review.suggested)) },
                  translate('workUseSuggested'),
                ),
              ),
            )
          : null,

        // ④ 正文：直接改，实时跑格式自检
        h(
          VerifySection,
          { no: '4', title: translate('workBody'), desc: translate('workBodyDesc') },
          h('textarea', {
            className: 'kb-textarea kb-work-body',
            value: body,
            rows: 9,
            onChange: (event) => setBody(event.target.value),
          }),
          h(
            'div',
            { className: 'kb-check' },
            checkLine(translate('workCheckLead'), check.lead),
            checkLine(translate('workCheckBullet'), check.bullet),
            checkLine(translate('workCheckBacktick'), check.backtick),
            checkLine(translate('workCheckBracket'), check.bracket),
          ),
        ),

        // ⑤ 当前版本：用户要看的是**改完之后**这一版（编辑框里的内容），
        //    不是库里那份旧的；两者不一样时明确标「未保存的修改」。
        showCurrent
          ? h(
              'div',
              { className: 'kb-current' },
              h(
                'div',
                { className: 'kb-current-cap' },
                h(
                  'span',
                  null,
                  dirty
                    ? translate('workCurrentDirty') + formatVersion(stored.version)
                    : translate('workCurrentSaved') + formatVersion(stored.version),
                ),
                h('span', { className: 'kb-grow' }),
                h('button', { className: 'kb-vbtn', onClick: () => setShowCurrent(false) }, translate('workViewCurrentHide')),
              ),
              h(BodyBlocks, { body: currentBody }),
            )
          : null,

        err ? h('div', { className: 'kb-err' }, err) : null,
        ok ? h('div', { className: 'kb-ok' }, ok) : null,

        confirm
          ? h(
              'div',
              { className: 'kb-vsec-act' },
              h('span', { className: 'kb-work-note' }, translate('workApplyConfirm')),
              h('button', { className: 'kb-vbtn primary', disabled: busy, onClick: apply }, translate('workApply')),
              h('button', { className: 'kb-vbtn', onClick: () => setConfirm(false) }, translate('workCancel')),
            )
          : h(
              'div',
              { className: 'kb-vsec-act' },
              h(
                'button',
                { className: 'kb-vbtn primary', disabled: busy || check.empty, onClick: () => setConfirm(true) },
                translate('workApply'),
              ),
              h('button', { className: 'kb-vbtn', disabled: busy, onClick: rollback }, translate('rollback')),
              h(
                'button',
                { className: 'kb-vbtn', onClick: () => setShowCurrent(!showCurrent) },
                showCurrent ? translate('workViewCurrentHide') : translate('workViewCurrent'),
              ),
              h('button', { className: 'kb-vbtn', onClick: onClose }, translate('workCancel')),
            ),
      )
    }

    /** 正文首行：收起态当摘要用（卡片正文契约：首行就是结论）。 */
    function firstLineOf(body) {
      return (
        String(body || '')
          .split(/\r?\n/)
          .map(part => part.trim())
          .find(Boolean) || ''
      )
    }

    /**
     * 会话里的一张知识卡片。
     *
     * 2026-10-23 用户反馈「会话末尾的知识卡片太大了，可以做小当预览，可以点击或者悬停查看」：
     * 现在默认是**一行小预览**（角色徽章 + 标题 + 正文首行 + 出处），点一下才展开成完整卡片；
     * 收起态把正文首行挂到 title 属性上，鼠标悬停就能看到。
     * 展开后才是正文 + 标签 + 三个动作（评审/编辑/问一下）—— 动作只在展开时出现，
     * 否则收起态的卡片就不小了。
     */
    function ChatCard(props) {
      const { card, onSaved, compact = false } = props
      const [panel, setPanel] = useState('')
      // 预览默认收起；compact=false 的调用方（面板里的卡片）保持旧行为
      const [open, setOpen] = useState(!compact)
      // 这份快照是不是已经过期（别的端改过了）：过期就禁用会写库的按钮
      const stale = useCardStale(card)
      // 角色：库中已有 / 本次新增 / 本次更新 / 待写入。
      // 用户 2026-10-23 反馈「卡片之间没有区分」—— 同一主题里所有卡片同色，
      // 用户分不清哪些已经在库里、哪些是这次新加的。
      const role = roleOf(card)
      const roleMeta = CARD_ROLES[role]

      const update = (patch) => {
        // 自己刚写回过：库里版本就是新的，别再把它当成过期卡
        if (patch && patch.version) writeCardVersion(card.id, card.topic, { version: patch.version })
        if (onSaved) onSaved(patch)
      }

      const summary = firstLineOf(card.body)
      const metaBits = [card.topicName, card.appliesTo, card.source?.locator].filter(Boolean)

      if (!open) {
        // 悬停要把**整段正文**给出来（原生 tooltip 认换行），不只是首行 ——
        // 2026-10-23 用户反馈「悬停也没有把正文所有内容显示出来」。
        const hover = String(card.body || '').trim() || card.title
        return h(
          'div',
          {
            className: 'kb-chat-card kb-mini-card kb-role-' + role,
            style: { '--kb-tc': topicColor(card.topic), '--kb-role-c': roleMeta.color },
            onClick: () => setOpen(true),
            role: 'button',
            tabIndex: 0,
            title: hover,
          },
          // 标题单独一行、**完整显示不截断**（长标题换行，最多两行）——
          // 2026-10-23 用户反馈「标题占一行，至少标题要完整吧」。
          h(
            'div',
            { className: 'kb-mini-line' },
            h('span', { className: 'kb-role-badge' }, translate(roleMeta.labelKey)),
            h('span', { className: 'kb-mini-title' }, card.title),
          ),
          summary || metaBits.length
            ? h(
                'div',
                { className: 'kb-mini-line kb-mini-meta-line' },
                summary ? h('span', { className: 'kb-mini-sum' }, summary) : null,
                metaBits.length ? h('span', { className: 'kb-mini-meta' }, metaBits.join(' · ')) : null,
              )
            : null,
        )
      }

      // 点卡片任意位置就收起（2026-10-23 用户要求：不要非得点按钮才能缩）。
      // 按钮 / 输入框 / 链接上不触发，选中文字时也不触发 —— 否则用户点「编辑」或复制正文时卡片会莫名其妙缩回去。
      const collapseOnClick = (event) => {
        const target = event && event.target
        if (target && typeof target.closest === 'function' && target.closest('button, a, textarea, input, select')) return
        try {
          const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
          if (selection && String(selection).length) return
        } catch {
          /* 拿不到选择状态就算了 */
        }
        setOpen(false)
      }

      return h(
        'article',
        {
          className: 'kb-chat-card kb-role-' + role,
          style: { '--kb-tc': topicColor(card.topic), '--kb-role-c': roleMeta.color },
        },
        h(
          'div',
          { className: 'kb-chat-head', onClick: collapseOnClick, title: translate('cardCollapse') },
          h('span', { className: 'kb-role-badge' }, translate(roleMeta.labelKey)),
          h('span', { className: 'kb-chat-title' }, card.title),
          card.topicName ? h('span', { className: 'kb-chat-topic' }, card.topicName) : null,
          // 还没落盘的卡片没有可核实的对象：徽章点开会去写一条不存在的条目
          card.id ? h(VerifyBadge, { card, onToggle: () => setPanel(panel === 'verify' ? '' : 'verify') }) : null,
        ),
        h('div', { className: 'kb-chat-body', onClick: collapseOnClick }, h(BodyBlocks, { body: card.body })),
        card.tags && card.tags.length
          ? h(
              'div',
              { className: 'kb-tags' },
              card.tags.slice(0, 4).map(tag => h('span', { className: 'kb-tag', key: tag }, tag)),
            )
          : null,
        h(
          'div',
          { className: 'kb-chat-foot' },
          h('span', { className: 'kb-score' }, shortVersion(card.version || 1)),
          // 这份快照已经过期（别的端改过这条）：说清楚，并禁用会写库的按钮
          stale.stale
            ? h(
                'span',
                { className: 'kb-stale-note', title: translate('actStaleHint') },
                translate('actStaleNote') + ' ' + formatVersion(stale.current || card.version || 1),
              )
            : null,
          h('span', { className: 'kb-grow' }),
          // 展开态给一个「收起」：用户看完正文要能收回去，否则卡片越滚越长
          // 没有 id 的卡片是「还没落盘」的预览：没有可操作的对象，就不给动作
          card.id
            ? h(
                'span',
                { className: 'kb-work-row' },
                h(
                  'button',
                  {
                    className: 'kb-mini',
                    disabled: stale.stale,
                    title: stale.stale ? translate('actStaleHint') : '',
                    onClick: () => setPanel(panel === 'work' ? '' : 'work'),
                  },
                  translate('actReview'),
                ),
                h(
                  'button',
                  {
                    className: 'kb-mini',
                    disabled: stale.stale,
                    title: stale.stale ? translate('actStaleHint') : '',
                    onClick: () => setPanel(panel === 'edit' ? '' : 'edit'),
                  },
                  translate('actEdit'),
                ),
                h('button', { className: 'kb-mini', onClick: () => setPanel(panel === 'ask' ? '' : 'ask') }, translate('actAsk')),
              )
            : h('span', { className: 'kb-work-note' }, translate('cardPendingNote')),
        ),
        panel === 'work' ? h(Workbench, { card, autoReview: true, onClose: () => setPanel(''), onSaved: update }) : null,
        panel === 'edit' ? h(Workbench, { card, autoReview: false, onClose: () => setPanel(''), onSaved: update }) : null,
        panel === 'ask' ? h(AskThread, { card, onClose: () => setPanel('') }) : null,
        panel === 'verify' ? h(VerifyPanel, { card, onClose: () => setPanel(''), onSaved: update }) : null,
      )
    }

    // ------------------------------------------------ 回答下方那一排（turnTail）
    //
    // 为什么不只靠工具行：工具行在「过程组」里，standard/detailed 档在这一轮答完后
    // 把整组 outerHidden（不是折叠，是不渲染），所以答完就看不见卡片了。
    // conversation.chat.turnTail 是宿主给「回答下方的功能条」留的 list 槽
    // （交付物卡片、计划、定时任务提醒都挂在那），纯增量、replaceRisk: none，
    // 而且永远在过程组外面 —— 卡片放这里才是「问完就能看见」。
    //
    // 数据怎么来：照官方 schedule-created 那张卡片的做法 —— 注册一个 Turn
    // Definition，把 learn_* 结果里的 kbCards 发布到这一轮的 turn.data 上，
    // turnTail 用 turn.data.get(kind) 读回来。
    // （不要用 useChat 读 chat snapshot：turn 是 TurnLocation 对象，不是数字键，
    //   而且 snapshot 的字段形状不是公开契约。）

    /** 稳定的空数组：没命中时返回同一个引用，避免无意义重渲染。 */
    const EMPTY_CARDS = Object.freeze([])
    /** 相关补充里被点开的行（同样是稳定空引用）。 */
    const EMPTY_OPEN_REL = Object.freeze([])
    /** 相关补充先摆几行；超出的折成「再看 N 条」（条数本身不设上限）。 */
    const RELATED_VISIBLE = 12
    /** 稳定的空分组数组（同上，避免每次重算新引用）。 */
    const EMPTY_GROUPS = Object.freeze([])

    /** 我们的 Turn Definition 在「这一轮」上占的 key。 */
    const KB_TURN_KIND = 'kb-cards'

    /**
     * 把知识卡片挂到「这一轮」上的 Turn Definition。
     *
     * 匹配方式：直接看 tool/result 事件的 data.meta.kbCards —— 只有我们的
     * learn_search / learn_save 会带这个字段，所以不需要再记调用名去过滤。
     */
    const kbTurnDefinition = {
      kind: KB_TURN_KIND,
      match(event) {
        if (!event || typeof event !== 'object') return null
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
        // 只认 append 的 tool/result：replacement window 里的旧事件不该重复计入
        if (event.type === 'tool/result' && event.surfaceOp === 'append') {
          return { id: String(event.data.turn), role: 'update' }
        }
        return null
      },
      start(_context, match) {
        return { turn: match.event.data.turn, entries: [] }
      },
      update(context, match) {
        const state = context.state
        if (!state) return state
        const event = match.event
        const meta = event.data ? event.data.meta : null
        const cards = meta && Array.isArray(meta.kbCards) ? meta.kbCards : null
        const related = meta && Array.isArray(meta.kbRelated) ? meta.kbRelated : null
        // 检索重排的 token 用量：跟命中卡片同一次检索的结果
        const tokens = meta && meta.kbTokens && typeof meta.kbTokens === 'object' ? meta.kbTokens : null
        // 待写入批次：learn_save 预览时给的 batchId，界面拿它渲染「确认写入 N 条」
        const save = meta && meta.kbSave && typeof meta.kbSave === 'object' ? meta.kbSave : null
        // 卡片来源：search=检索命中 / entries=清单列出 / save=写入。
        // 把「列出来的 251 条」说成「命中 251 条」是骗人（2026-10-23 用户实测）。
        const source = meta && typeof meta.kbCardSource === 'string' ? meta.kbCardSource : ''
        // 提议补条目：learn_propose 发布的提议条（标题 + 理由，正文等用户点同意再生成）
        const proposal = meta && meta.kbProposal && typeof meta.kbProposal === 'object' ? meta.kbProposal : null
        // 命中和相关补充是一起发布的（同一次 learn_search 的重排结果），
        // 所以只要有任意一组就记一条 entry。
        const hasCards = cards && cards.length > 0
        const hasRelated = related && related.length > 0
        const hasSave = save && save.batchId
        const hasProposal = proposal && proposal.id
        if (!hasCards && !hasRelated && !hasSave && !hasProposal) return state
        return {
          ...state,
          entries: [
            ...state.entries,
            {
              seq: event.seq,
              cards: hasCards ? cards : EMPTY_CARDS,
              related: hasRelated ? related : EMPTY_CARDS,
              tokens,
              save: hasSave ? save : null,
              source,
              proposal: hasProposal ? proposal : null,
            },
          ],
        }
      },
      buildLocationData(context, scope, previous) {
        if (scope !== 'turn' || !context.state) return null
        if (previous && previous.kind === 'turn' && previous.key === KB_TURN_KIND && previous.value.entries === context.state.entries) {
          return previous
        }
        return { kind: 'turn', turn: context.state.turn, key: KB_TURN_KIND, value: { entries: context.state.entries } }
      },
    }

    /** 稳定的空 payload：没命中时返回同一个引用。 */
    const EMPTY_PAYLOAD = Object.freeze({ cards: EMPTY_CARDS, related: EMPTY_CARDS, rerankTokens: 0, groups: EMPTY_GROUPS, save: null, source: '', proposal: null })

    /** 按角色分组：库中已有 / 本次新增 / 本次更新 / 待写入，各一组不混排。 */
    function groupCards(cards) {
      const buckets = new Map()
      for (const card of cards || []) {
        const role = roleOf(card)
        if (!buckets.has(role)) buckets.set(role, [])
        buckets.get(role).push(card)
      }
      const groups = []
      for (const role of ROLE_ORDER) {
        const list = buckets.get(role)
        if (list && list.length) groups.push({ role, cards: list })
      }
      return groups
    }

    /**
     * 同一张卡片在界面上只留一次。
     *
     * 为什么会重复：这一轮的卡片是把**所有工具调用**的卡片拼起来的。
     * 模型按方向检索四次，同一条「vector 与 list 的区别」可能同时沾「STL」「容器」被命中几次；
     * learn_search 和 learn_entries 也可能把同一条都带回来。
     * 卡片是按 id 存的，同一个 id 出现多次就是同一张卡（2026-10-23 用户实测：
     * 「选中卡片出现了同一张卡片多次被命中」）。
     *
     * 去重键带上 role：库中已有（existing）和本次新增（new/update）是两种投影，
     * 同一张卡同时出现在两组里是有意义的，不能互相吃掉。
     */
    function cardKey(card) {
      if (!card) return ''
      const id = card.id ? String(card.id) : ''
      return roleOf(card) + ':' + (id || String(card.title || '') + '|' + String(card.topic || ''))
    }

    /** 按序去重，保留第一次出现的那张（先出现的来自更早的工具调用）。 */
    function uniqueCards(list) {
      const seen = new Set()
      const out = []
      for (const card of list || []) {
        const key = cardKey(card)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(card)
      }
      return out
    }

    /**
     * 从这一轮的 Turn Definition 数据里取卡片，按 turn 结束位置截断。
     * 返回 { cards, related, groups, save, source }：命中按角色分组，相关补充另算（界面里折叠），
     * save 是待写入批次（有它才渲染「确认写入 N 条」按钮），
     * source 是卡片来源（search=检索命中 / entries=清单列出 / save=写入）。
     */
    function turnPayloadOf(props) {
      try {
        const { turn, seq } = props || {}
        if (!turn || !turn.data || typeof turn.data.get !== 'function') return EMPTY_PAYLOAD
        const data = turn.data.get(KB_TURN_KIND)
        if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return EMPTY_PAYLOAD
        const bound = turn.end && typeof turn.end.seq === 'number' ? turn.end.seq : seq
        const collected = []
        for (const entry of data.entries) {
          if (!entry) continue
          if (typeof bound === 'number' && typeof entry.seq === 'number' && entry.seq > bound) continue
          collected.push(entry)
        }
        const cards = uniqueCards(collected.flatMap(entry => (Array.isArray(entry.cards) ? entry.cards : [])))
        // 已经是命中的卡片不再当「相关补充」重复列一遍
        const hitKeys = new Set(cards.map(cardKey))
        const related = uniqueCards(
          collected.flatMap(entry => (Array.isArray(entry.related) ? entry.related : [])),
        ).filter(card => !hitKeys.has(cardKey(card)))
        let rerankTokens = 0
        let save = null
        let proposal = null
        const sources = new Set()
        for (const entry of collected) {
          // 同一轮里多次 learn_save：取最后一次的待写入批次
          if (entry.save && entry.save.batchId) save = entry.save
          // 同一轮里多次 learn_propose：取最后一次的提议
          if (entry.proposal && entry.proposal.id) proposal = entry.proposal
          if (entry.source) sources.add(entry.source)
          const spent = entry.tokens && entry.tokens.rerank ? Number(entry.tokens.rerank.totalTokens) : 0
          if (Number.isFinite(spent) && spent > 0) rerankTokens += spent
        }
        if (cards.length === 0 && related.length === 0 && !save && !proposal) return EMPTY_PAYLOAD
        // 只有一种来源时才敢用它的说法；混着来就笼统说「知识库卡片」
        const source = sources.size === 1 ? Array.from(sources)[0] : sources.size > 1 ? 'mixed' : ''
        return { cards, related, rerankTokens, groups: groupCards(cards), save, source, proposal }
      } catch {
        // 宿主内部结构变了就安静地不渲染，绝不能把会话搞坏
        return EMPTY_PAYLOAD
      }
    }

    /** 兼容旧名：只要命中卡片的场景（面板/测试）继续用这个。 */
    function turnCardsOf(props) {
      return turnPayloadOf(props).cards
    }

    /**
     * 回答下方那一排：卡片按角色分组列出来，相关补充排在后面并默认收缩。
     *
     * 收缩而不是不显示：这些条目是模型判定的"同领域但不是答案"，用户可能想看，
     * 但默认展开会把真正的答案挤下去 —— 所以给一行可以点的标题。
     *
     * 分组而不是一锅端：2026-10-23 用户反馈「卡片之间没有区分」。
     * 以前这一轮里所有工具的卡片被拍平进同一个数组（turnPayloadOf），
     * 「库中已有的 34 条」和「这次要加的 3 条」混在一起，用户分不清。
     * 现在按 role 分组：库中已有 / 本次新增 / 本次更新 / 待写入。
     */
    function TurnTailCards(props) {
      const [all, setAll] = useState(false)
      const [showRelated, setShowRelated] = useState(false)
      // 相关补充里，哪几行被点开了（键 = rel-<id|index>）。单独记，不跟折叠状态混。
      const [openRel, setOpenRel] = useState(EMPTY_OPEN_REL)
      // 相关补充超过 RELATED_VISIBLE 条时才用得上：false = 只摆前 12 条
      const [showAllRel, setShowAllRel] = useState(false)
      const { cards, related, rerankTokens, groups, save, source, proposal } = turnPayloadOf(props)
      // 待写入批次的落盘状态：点「确认写入」之后要能看出成没成
      const [saveState, setSaveState] = useState({ busy: false, done: false, error: '' })
      if (cards.length === 0 && related.length === 0 && !save && !proposal) return null

      const headBits = []
      // 计数要说实话：检索命中叫「命中」，清单列出来的叫「列出」——
      // 把「列出来的 251 条」说成「命中 251 条」是骗人（2026-10-23 用户实测）。
      const countLabel = source === 'entries' ? '列出 ' : source === 'search' ? '知识库命中 ' : ''
      if (groups.length > 1) headBits.push('知识库卡片 ' + cards.length + ' 张')
      else if (groups.length === 1 && groups[0].role === 'existing') {
        headBits.push((countLabel || '知识库命中 ') + cards.length + ' 条')
      } else if (groups.length === 1) headBits.push(translate(CARD_ROLES[groups[0].role].groupKey) + ' ' + cards.length + ' ' + translate('unitCards'))
      if (related.length) headBits.push('相关 ' + related.length + ' 条')
      if (rerankTokens > 0) headBits.push('重排 ' + formatTokens(rerankTokens) + ' tokens')

      const writeNow = async () => {
        if (!save || !save.batchId) return
        setSaveState({ busy: true, done: false, error: '' })
        try {
          await apiPost('/save', { batchId: save.batchId })
          setSaveState({ busy: false, done: true, error: '' })
        } catch (error) {
          const message = error && error.message ? String(error.message) : String(error)
          setSaveState({ busy: false, done: false, error: message })
        }
      }

      // 提议条的状态：idle → 生成中 → 预览卡片（含 batchId）→ 已写入 / 放弃
      // 2026-10-23 用户定方案 A：点「同意」由宿主调插件模型写正文，不再让模型跑一趟。
      const [propState, setPropState] = useState({ busy: false, cards: [], batchId: '', error: '', done: false })
      // 选哪些条目要补 + 补到哪个主题（2026-10-23 用户要求）：
      // 「提醒补多条条目后，我只想补其中几条」「加入到哪个主题也要可以选」
      const [propPicked, setPropPicked] = useState({})
      const [propTopic, setPropTopic] = useState('')

      const proposalItems = (proposal && proposal.items) || []
      const proposalId = proposal && proposal.id
      // 提议换了（新的一轮）就把选择重置成「全选 + 提议自己的主题」
      const propKey = proposalId || ''
      const [propSeenKey, setPropSeenKey] = useState('')
      if (propKey !== propSeenKey) {
        setPropSeenKey(propKey)
        setPropPicked({})
        setPropTopic((proposal && proposal.topic) || '')
      }
      const pickedIndexes = proposalItems
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => (propPicked[index] === undefined ? true : !!propPicked[index]))
        .map(({ index }) => index)
      // 下拉里选中的主题名（头部要显示「→ 主题名」）
      const propTopicLabel =
        ((proposal && proposal.topics) || []).find(topic => topic.slug === propTopic)?.name || ''

      const togglePick = index => {
        setPropPicked(state => ({ ...state, [index]: !(state[index] === undefined ? true : state[index]) }))
      }

      const acceptProposal = async () => {
        if (!proposal || !proposal.id) return
        if (!pickedIndexes.length) {
          setPropState({ busy: false, cards: [], batchId: '', error: '至少要选一条要补的条目', done: false })
          return
        }
        setPropState({ busy: true, cards: [], batchId: '', error: '', done: false })
        try {
          const data = await apiPost('/propose/accept', {
            proposalId: proposal.id,
            items: pickedIndexes,
            topic: propTopic || undefined,
          })
          setPropState({ busy: false, cards: data.cards || [], batchId: data.batchId || '', error: '', done: false })
        } catch (error) {
          const message = error && error.message ? String(error.message) : String(error)
          setPropState({ busy: false, cards: [], batchId: '', error: message, done: false })
        }
      }

      const confirmProposal = async () => {
        if (!propState.batchId) return
        setPropState(state => ({ ...state, busy: true, error: '' }))
        try {
          await apiPost('/save', { batchId: propState.batchId })
          setPropState(state => ({ ...state, busy: false, done: true, error: '' }))
        } catch (error) {
          const message = error && error.message ? String(error.message) : String(error)
          setPropState(state => ({ ...state, busy: false, error: message }))
        }
      }

      return h(
        'div',
        { className: 'kb-stack kb-turn' },
        h(
          'div',
          { className: 'kb-stack-head kb-turn-head' },
          h('span', null, headBits.filter(Boolean).join(' · ')),
        ),
        groups.map(group =>
          h(
            'div',
            { className: 'kb-group', key: group.role },
            groups.length > 1
              ? h('div', { className: 'kb-group-head' }, translate(CARD_ROLES[group.role].groupKey) + ' ' + group.cards.length + ' ' + translate('unitCards'))
              : null,
            (all ? group.cards : group.cards.slice(0, 3)).map((card, index) =>
              h(ChatCard, {
                key: (card.id || group.role) + '-' + index,
                card,
                // 会话末尾的卡片默认收成一行小预览，点一下才展开（2026-10-23 用户要求）
                compact: true,
              }),
            ),
          ),
        ),
        // 提议条：模型说「库里缺这几条」时，别让它埋在正文最后一行（用户实测看漏），
        // 也别用 ask_user_question（那会让这一轮多一个步骤，回答被折进过程组）。
        // 由 learn_propose 发布到 turnTail，不受过程组折叠影响。
        proposal && !propState.done
          ? h(
              'div',
              { className: 'kb-proposal' },
              h(
                'div',
                { className: 'kb-proposal-head' },
                h('span', null, translate('proposalHead') + ' ' + (proposal.items || []).length + ' ' + translate('unitCards')),
                proposal.topicName ? h('span', { className: 'kb-proposal-topic' }, '→ ' + (propTopicLabel || proposal.topicName)) : null,
              ),
              h(
                'div',
                { className: 'kb-proposal-list' },
                (proposal.items || []).map((item, index) =>
                  h(
                    'label',
                    { className: 'kb-proposal-item', key: 'prop-' + index },
                    h('input', {
                      type: 'checkbox',
                      checked: propPicked[index] === undefined ? true : !!propPicked[index],
                      disabled: propState.busy,
                      onChange: () => togglePick(index),
                    }),
                    h('span', { className: 'kb-proposal-title' }, item.title),
                    item.why ? h('span', { className: 'kb-proposal-why' }, item.why) : null,
                  ),
                ),
              ),
              // 补到哪个主题（2026-10-23 用户要求：加入到哪个主题也要可以选）
              (proposal.topics || []).length
                ? h(
                    'div',
                    { className: 'kb-proposal-topicrow' },
                    h('span', { className: 'kb-proposal-topic' }, translate('proposalTopic') + '：'),
                    h(
                      'select',
                      {
                        className: 'kb-proposal-select',
                        value: propTopic || proposal.topic || '',
                        disabled: propState.busy,
                        onChange: event => setPropTopic(event.target.value),
                      },
                      (proposal.topics || []).map(topic =>
                        h('option', { key: topic.slug, value: topic.slug }, topic.name + '（' + topic.count + '）'),
                      ),
                    ),
                  )
                : null,
              // 点了「同意」之后：宿主把正文写出来，这里就地渲染预览，再点「确认写入」才入库
              propState.cards.length
                ? h(
                    'div',
                    { className: 'kb-proposal-preview' },
                    propState.cards.map((card, index) =>
                      h(
                        'div',
                        { className: 'kb-proposal-card', key: 'pc-' + index },
                        h('div', { className: 'kb-proposal-card-title' }, card.title),
                        h(BodyBlocks, { body: String(card.body || '') }),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'kb-proposal-acts' },
                propState.cards.length
                  ? h(
                      'button',
                      { className: 'kb-vbtn primary', disabled: propState.busy, onClick: confirmProposal },
                      translate('proposalConfirm') + ' ' + propState.cards.length + ' ' + translate('unitCards'),
                    )
                  : h(
                      'button',
                      { className: 'kb-vbtn primary', disabled: propState.busy || !pickedIndexes.length, onClick: acceptProposal },
                      propState.busy
                        ? translate('proposalGenerating')
                        : translate('proposalAccept') + ' ' + pickedIndexes.length + ' ' + translate('unitCards'),
                    ),
                h('button', { className: 'kb-vbtn', onClick: () => setPropState({ busy: false, cards: [], batchId: '', error: '', done: true }) }, translate('proposalLater')),
              ),
              propState.error ? h('span', { className: 'kb-save-err' }, propState.error) : null,
            )
          : null,
        proposal && propState.done
          ? h('div', { className: 'kb-proposal kb-proposal-done' }, '✓ ' + translate('proposalHead') + ' ' + ((proposal.items || []).length) + ' ' + translate('unitCards') + ' · ' + translate('saveDone'))
          : null,
        // 展开/收起放在卡片下方（2026-10-23 用户反馈：按钮在卡片最上方，
        // 应该在下面 —— 用户是看完这几张才决定要不要展开的）。
        cards.length > 3
          ? h(
              'div',
              { className: 'kb-turn-foot' },
              h(
                'button',
                { className: 'kb-mini', onClick: () => setAll(!all) },
                all
                  ? translate('collapseAll')
                  : translate('expandAll') + ' ' + cards.length + ' ' + translate('unitCards'),
              ),
            )
          : null,
        // 预览先行的写入条：这批卡片还没进库，用户点一下才落盘
        save && !saveState.done
          ? h(
              'div',
              { className: 'kb-save-bar' },
              h(
                'span',
                { className: 'kb-save-bar-text' },
                translate('saveBarTitle'),
                h('b', null, ' ' + (save.count || 0) + ' '),
                save.topicName ? h('span', { className: 'kb-save-bar-topic' }, '→ ' + save.topicName) : null,
              ),
              h(
                'button',
                { className: 'kb-vbtn primary', disabled: saveState.busy, onClick: writeNow },
                saveState.busy
                  ? translate('saveWriting')
                  : translate('saveConfirm') + ' ' + (save.count || 0) + ' ' + translate('unitCards'),
              ),
              saveState.error ? h('span', { className: 'kb-save-err' }, saveState.error) : null,
            )
          : null,
        save && saveState.done
          ? h(
              'div',
              { className: 'kb-save-bar' },
              h('span', { className: 'kb-save-ok' }, '✓ ' + translate('saveDone') + ' ' + (save.count || 0) + ' ' + translate('unitCards')),
              save.topicName ? h('span', { className: 'kb-save-bar-topic' }, '→ ' + save.topicName) : null,
            )
          : null,
        related.length
          ? h(
              'div',
              { className: 'kb-related' },
              h(
                'button',
                {
                  className: 'kb-related-head',
                  onClick: () => setShowRelated(!showRelated),
                  'aria-expanded': showRelated ? 'true' : 'false',
                },
                h('span', { className: 'kb-related-caret' }, showRelated ? '▾' : '▸'),
                h('span', null, '相关知识点 ' + related.length + ' 条'),
              ),
              // 相关补充：一行一条，**点这一行就地铺开正文**。
              // 2026-10-23 两轮反馈：先要求「别混进答案卡」，再要求「点开要看得到东西，光一行标题没意义」。
              // 所以外壳保持浅色小行（分得清不是答案），但点开是真正文（BodyBlocks），不是只有标题。
              // 条数不设上限（后端 related 全留），但界面先摆 RELATED_VISIBLE 条，
              // 多出来的折成「再看 N 条」—— 一次铺 30 行会把这一轮的回答顶走。
              showRelated
                ? h(
                    'div',
                    { className: 'kb-rel-list' },
                    (showAllRel ? related : related.slice(0, RELATED_VISIBLE)).map((card, index) => {
                      const key = 'rel-' + (card.id || index)
                      const open = openRel.includes(key)
                      return h(
                        'div',
                        { className: 'kb-rel-item', key },
                        h(
                          'button',
                          {
                            className: 'kb-rel-row',
                            'aria-expanded': open ? 'true' : 'false',
                            title: open ? translate('relCloseHint') : translate('relOpenHint'),
                            onClick: () =>
                              setOpenRel(list => (list.includes(key) ? list.filter(item => item !== key) : list.concat(key))),
                          },
                          h('span', { className: 'kb-rel-caret' }, open ? '▾' : '▸'),
                          h('span', { className: 'kb-rel-title' }, card.title),
                          h(
                            'span',
                            { className: 'kb-rel-meta' },
                            [card.topicName, card.appliesTo, card.source?.locator].filter(Boolean).join(' · '),
                          ),
                        ),
                        // 点开的主体：正文 + 标签 + 版本行。没有 id 的卡片不会走到这里（检索结果都带 id）。
                        open
                          ? h(
                              'div',
                              { className: 'kb-rel-open' },
                              h('div', { className: 'kb-rel-note' }, translate('relNote')),
                              h(BodyBlocks, { body: String(card.body || '') }),
                              card.tags && card.tags.length
                                ? h(
                                    'div',
                                    { className: 'kb-tags' },
                                    card.tags.slice(0, 4).map(tag => h('span', { className: 'kb-tag', key: tag }, tag)),
                                  )
                                : null,
                              h(
                                'div',
                                { className: 'kb-rel-foot' },
                                h('span', null, shortVersion(card.version || 1)),
                                card.kind === 'qa' ? h('span', null, translate('kindQa')) : null,
                              ),
                            )
                          : null,
                      )
                    }),
                    // 条数不封顶（用户要「相关知识点不用限制数量」），但先摆 RELATED_VISIBLE 条，
                    // 多出来的折成一行按钮 —— 一次铺几十行会把这一轮的回答顶走。
                    related.length > RELATED_VISIBLE
                      ? h(
                          'button',
                          {
                            className: 'kb-rel-more',
                            onClick: () => setShowAllRel(!showAllRel),
                            'aria-expanded': showAllRel ? 'true' : 'false',
                          },
                          showAllRel
                            ? translate('relLess')
                            : translate('relMore') +
                              ' ' +
                              (related.length - RELATED_VISIBLE) +
                              ' ' +
                              translate('unitCards'),
                        )
                      : null,
                  )
                : null,
            )
          : null,
      )
    }

        /** 工具结果里的卡片堆：默认 Top 3，可展开全部。 */
    function ChatCards(props) {
      const { block, phase, toolName } = props
      const [items, setItems] = useState([])
      const [fallback, setFallback] = useState(null)
      const [loading, setLoading] = useState(false)

      const fromMeta = phase === 'result' ? cardsOf(block) : []

      useEffect(() => {
        if (phase !== 'result') return
        setItems(fromMeta)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [block, phase])

      // 兜底：万一宿主没把 meta 带过来，用工具入参里的检索词再查一次
      useEffect(() => {
        if (phase !== 'result' || fromMeta.length) return undefined
        if (toolName !== 'learn_search') return undefined
        const query = queryOfArgs(block)
        if (!query) return undefined
        const controller = new AbortController()
        setLoading(true)
        apiGet('/search', { q: query, topic: 'all', limit: 3 }, controller.signal)
          .then(data => {
            if (controller.signal.aborted) return
            setFallback(
              (data.hits || []).map(hit => ({
                id: hit.id,
                title: hit.title,
                body: hit.body,
                topic: hit.topic,
                topicName: hit.topicName || hit.topic,
                tags: hit.tags || [],
                verified: hit.verified ?? false,
                version: hit.version || 1,
              })),
            )
          })
          .catch(() => {})
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
        return () => controller.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [block, phase, toolName, fromMeta.length])

      if (phase !== 'result') {
        return h('div', { className: 'kb-chat-note' }, toolName === 'learn_save' ? translate('chatSaving') : translate('chatSearching'))
      }

      const list = items.length ? items : fallback || []
      const relatedCount = relatedCardsOf(block).length
      if (!list.length && !relatedCount) {
        return loading ? h('div', { className: 'kb-chat-note' }, translate('chatSearching')) : h('div', { className: 'kb-chat-note' }, translate('chatNoHit'))
      }

      // 过程组里只留一行文字。
      // 为什么不再在这里渲染卡片：过程组（工具行）在 standard/detailed 档、这一轮
      // 答完之后会被整组隐藏，卡片放这儿等于答完就看不见；而回答下方的 turnTail
      // 才是常驻位置。两处都渲染又会让同一批卡片出现两次。所以这里退化成一句计数，
      // 真正的卡片交给 TurnTailCards。文案保持中性 —— 不承诺"卡片在下方"，
      // 免得哪天卡片条坏了这行字跟着说谎。
      const bits = []
      // 工具行的文案要跟角色对上（2026-10-23 用户反馈「卡片之间没有区分」）：
      // 检索命中的是「库中已有」，写入计划里的是「本次新增 / 本次更新」，
      // 预览出来的还没进库。三者混成一句「卡片 N 条」等于没区分。
      const roleCounts = new Map()
      for (const card of list) {
        const role = roleOf(card)
        roleCounts.set(role, (roleCounts.get(role) || 0) + 1)
      }
      const status = list.find(card => card.status)?.status || null
      const pending = status === 'preview' || status === 'need_decision'
      const roleBits = () => {
        for (const role of ROLE_ORDER) {
          const n = roleCounts.get(role) || 0
          if (!n) continue
          const label = translate(CARD_ROLES[role].groupKey) + ' ' + n + ' ' + translate('unitCards')
          bits.push(pending && role !== 'existing' ? label + translate('notWritten') : label)
        }
      }
      if (toolName === 'learn_save' || roleCounts.size > 1) {
        roleBits()
      } else {
        const label = toolName === 'learn_entries' ? '列出 ' : '知识库命中 '
        bits.push(label + list.length + ' ' + translate('unitCards'))
      }
      if (relatedCount) bits.push('相关 ' + relatedCount + ' 条')
      return h('div', { className: 'kb-chat-note' }, bits.join(' · '))
    }

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

      // 会话里的知识卡片：learn_search / learn_save 的结果按 wire 工具名注册自己的行。
      // 官方 skill 工具用的是同一个 keyed slot（key 域是开放的，写自己的工具名即可）。
      try {
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'learn_search' }, ChatCards),
        )
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'learn_save' }, ChatCards),
        )
        // learn_entries 也会带回卡片（「有哪些 / 清单」类问题走它），
        // 不注册这一行，工具行就只剩默认渲染，和另外两个工具不一致。
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: 'learn_entries' }, ChatCards),
        )
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[learning-kb] 会话卡片注册失败：' + describeError(error))
      }

      // 回答下方那一排：知识库命中时把卡片列出来。
      // 这是「答完也能看见」的唯一位置 —— 工具行在过程组里，答完会被整组隐藏。
      try {
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'learning-kb', label: '知识库卡片', order: 10 },
            TurnTailCards,
          ),
        )
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[learning-kb] 回答下方卡片注册失败：' + describeError(error))
      }

      // 卡片挂到「这一轮」上：Turn Definition 把 learn_* 结果里的 kbCards 发布到
      // turn.data，turnTail 才能读到。
      //
      // 时序陷阱（踩过）：uiConversation 是 ui-conversation 插件 provide 的服务，
      // 我们的 apply() 可能比它先跑完。Cordis 的 ctx.get() 是「不管 inject 直接读
      // 服务表」，服务还没被 provide 时就是 undefined —— 旧代码在这种情况下静默
      // 跳过了注册，于是 turn.data 永远是空的，回答下方一张卡片都不出来。
      // 所以：先试即时注册；拿不到就交给 ctx.inject(['uiConversation'], …) 挂起，
      // 等 Cordis 在服务就绪时回调。挂起的只有"下方卡片条"这一块，面板、工具行、
      // 侧边栏都不受影响。
      try {
        const attach = (uiConversation) => {
          const events = uiConversation && uiConversation.events
          if (!events || typeof events.register !== 'function') return null
          const dispose = events.register(kbTurnDefinition)
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }
        const immediate = typeof ctx.get === 'function' ? ctx.get('uiConversation') : null
        const dispose = attach(immediate)
        if (dispose) {
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, 'learning-kb: kb-cards turn definition')
          }
        } else if (typeof ctx.inject === 'function') {
          ctx.inject(['uiConversation'], (scoped) => {
            const ui =
              (scoped && scoped.uiConversation) ||
              (scoped && typeof scoped.get === 'function' ? scoped.get('uiConversation') : null)
            attach(ui)
          })
        } else if (typeof console !== 'undefined') {
          console.warn('[learning-kb] uiConversation 不可用：回答下方的卡片条关闭')
        }
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[learning-kb] 卡片 Turn Definition 注册失败：' + describeError(error))
      }
    }

    exports.name = 'learning-kb-ui'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    exports.parseBody = parseBody
    exports.toPlainBody = toPlainBody
    exports.mergeMarkup = mergeMarkup
    exports.reviewCacheKey = reviewCacheKey
    exports.reviewCacheGet = reviewCacheGet
    exports.reviewCacheSet = reviewCacheSet
    exports.reviewCacheClear = reviewCacheClear
    exports.addTokenUsage = addTokenUsage
    exports.clearCardVersionCache = () => {
      cardVersionCache.clear()
      versionBatches.clear()
    }
    exports.fetchCardVersions = fetchCardVersions
    exports.readTokenTotal = readTokenTotal
    exports.formatTokens = formatTokens
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

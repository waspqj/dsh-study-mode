# dsh-study-mode

**学习模式**：把知识学进**主题知识库**，回答问题时按固定顺序检索，答错了能当场改。

一个包同时给你两样东西：

| | |
| --- | --- |
| **agent 预设「学习模式」** | 新建会话时选它：回答问题先查库 → 查不到用自己的知识（标注未验证）→ 必要时才联网（标注日期） |
| **侧边栏「学习知识库」面板** | 书本图标：按主题浏览、关键词搜索、归档 / 恢复 / 删除 / 手动新增 |

配套 6 个工具：`learn_topics` `learn_search` `learn_save` `learn_entries` `learn_update` `learn_delete`。

---

## 安装

DSH 的「插件」页 →「添加插件」→「安装第三方插件」，**支持五种写法**：

| 方式 | 填什么 | 前提 / 注意 |
| --- | --- | --- |
| **npm 包名** | `dsh-study-mode` | 需要先 `npm publish`；国内可在「安装源」选 npmmirror 镜像 |
| **GitHub 仓库** | `https://github.com/waspqj/dsh-study-mode` | 直接可用（宿主认得 github.com）。也可写 `git+https://github.com/waspqj/dsh-study-mode.git` |
| **Gitee 仓库** | `git+https://gitee.com/<你>/dsh-study-mode.git` | **必须带 `git+` 前缀**。裸 `https://gitee.com/…/仓库` 会被当成 tarball 去下载，拉回 HTML 页面导致安装失败 |
| **tarball** | `https://…/dsh-study-mode-0.3.10.tgz` | 或本地绝对路径 `C:\path\to\dsh-study-mode-0.3.10.tgz` |
| **本地目录** | `C:\path\to\dsh-study-mode` | 开发者用 |

装 GitHub 版就填 `https://github.com/waspqj/dsh-study-mode`。

装完**重启 DSH** 最保险：bundle 行是启动时装配的（本机实测热加载也能生效，但换版本时容易吃到旧缓存）。
「安装源」可选：默认 / npm 官方源 / 中国大陆镜像 / 自定义地址（凭据放 `~/.npmrc`）。

> 装的是一个 **bundle**：它往配置树里插两行 —— 一行是知识库面板（宿主半侧 + 浏览器半侧），
> 一行是「学习模式」预设。

> ⚠️ **不要和开发副本同时装**：两个包插的是**同一行 id**（`learning-kb-ui`），
> 后装的会顶掉先装的，浏览器侧也会注册同一个图标 id。先卸一个再装另一个。

### 装完后的 5 个检查点

1. 「插件」页能看到 `dsh-study-mode`，状态已启用
2. **新建会话**时，预设列表里有「学习模式」
3. 侧边栏出现**书本图标**（最后一行，「上下文洞察」下面）
4. 点开面板：左边主题列表、右边条目区、顶部搜索框都在
5. 手动新增一条 → 点「刷新」→ 面板里能看到这条

前 4 点任何一条不成立，把 `npm test` 的输出一起发出来（见「本地开发」）。

## 使用

1. **新建会话时选「学习模式」预设**（预设选择器里能找到）。
2. 正常提问。命中知识库时会标 `[主题:名称]`；没有命中就用模型自己的知识并标 `[模型知识·未验证]`；
   只有版本号 / 价格 / 日期 / API 签名这类**必须查证**的问题才会联网，答案标 `[网络:日期]`。
3. 想入库就说「把这条记下来」，agent 会调 `learn_save` 弹确认框，你点「允许」才落盘。
4. **侧边栏点书本图标**进入知识库面板：左边选主题，右边看条目，顶部搜索关键词。
   - 归档：一键，不弹确认（可恢复，不进检索）
   - 删除：按钮先变成「确认删除？」，4 秒内再点一次才真删
   - 点任意卡片：打开详情浮层，看完整正文、标签、来源、版本

## 知识库存哪

```
~/.dsh/learn/
├── settings.json          # 默认主题
└── topics/<主题>/kb.jsonl
```

每台机器一份，**换机器不带走**。想改位置设环境变量 `DSH_LEARN_ROOT`。
想备份就拷这个目录。

条目是 JSONL，一行一条，方便 grep / git 管理 / 自己写脚本消费。

## 自定义

编辑 `cordis.patch.yml` 里 `preset-study` → `config.plugins` → `persona` → `config.prefix`：
那是 agent 的人设与检索协议（中文，Markdown）。

改完重启 DSH。改坏了用 `npm run check` 体检。

## 开发

```bash
npm install        # 无外部依赖
npm test           # 129 条断言：检索/写入/接口/浏览器半侧
npm run check      # 接线自检：exports 入口、裸包名约束、预设 id、版本号一致
```

目录：

```
plugin/index.js    宿主半侧：/kb/api/* 的 JSON 接口（总览 / 列表 / 检索 / 增删改）
plugin/tools.js    工具半侧：6 个 learn_* 工具（只在预设里生效）
plugin/store.js    知识库读写（JSONL 落盘、查重、归档/恢复、并发保护）
plugin/rank.js     检索排序（BM25 + 中文 bigram）
client/index.js    浏览器半侧：侧边栏图标 + 主面板 + 详情浮层
scripts/kb.mjs     命令行：stats / topics / list / search / show / add
```

## 三个坑（改这个包之前先读）

1. **带 `dsh.client` 的那一半必须占裸包名。**
   宿主扫描浏览器半侧时用 `exactPackageSpecifier` 还原包名，要求 `@scope/name` 恰好两段。
   行名写成 `@scope/name/ui` 会被判成 `undefined` **静默跳过** —— 不报错、不入图，
   表现是「侧边栏没有图标、日志也干净」。所以本包把 `exports["."]` 留给带 client 的
   `plugin/index.js`，工具挪到 `exports["./tools"]`。

2. **浏览器半侧的 `apply` 必须可重入。**
   宿主会热重载 client bundle，同一个插件的 `apply` 会在同一页面里跑第二次。
   `ctx.locale.register(ns, dicts)` 这类全局注册第二次会抛
   `locale namespace "x" already has locale "zh"` —— 必须挂在 `ctx.effect` 上（它的返回值是回收函数），
   并额外 try/catch 兜底。装饰性工作（样式、词典）失败不能连累核心注册。

3. **注入 `<style>` 要每次覆盖内容。**
   `if (document.getElementById('kb-style')) return` 会让热重载后的新样式永远不生效
   （模块换了、DOM 里的 style 标签还是旧的）。症状极具迷惑性：JSX 改动都生效，唯独样式改动毫无反应。

## 许可

MIT，见 [LICENSE](LICENSE)。

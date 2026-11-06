# 推广清单（让真人能发现 dsh-study-mode）

> 2026-10-27 实测整理。结论先行：**npm 的下载量不是曝光，awesome-dsh-plugin 目录才是。**
> 目录里 6896~7211 个插件，DSH 用户的「Plugins → Discover」看的就是它；
> 你的插件不在里面 → 逛市场的人根本看不见你。

## 一、为什么 npm 下载量不能当曝光看

2026-10-27 查到的：

- `dsh-study-mode` 共 1453 次下载，**全部集中在 2026-10-22（发布当天）起**，之前为 0。
- 整个 DSH 生态形状一模一样，量级跟包的知名度成正比：
  dsh-whale-widget ~1-2 万/天、dsh-context ~1.1-1.4 万/天、dsh-ops ~8 千/天、
  dsh-notify-me ~800-1300/天、dsh-engram ~110-160/天。
- npm 下载 API **最近几天没有数据**（react 在 10-27 也是 0，而 10-22 是 4200 万）
  → 页面上的数字是旧的，真实值更高。
- dshmarket 从没碰过这个包：1.17 MB 的发现目录缓存里没有它，市场日志里 0 次提及。
- Gitee 仓库 0 star / 0 fork / 1 watcher（自己）→ **真人安装量基本为零**。

最合理的机制：生态里的工具走 npmmirror 拉包，镜像按需回源会从 registry.npmjs.org
取 tarball，npm 把这次回源记成一次下载。所以那串数字是**机器流量**，不是人。

**该看的真实信号**：Gitee 的 clone/star、awesome-dsh-plugin 目录里的条目。

## 二、进入 awesome-dsh-plugin 目录（唯一真正的曝光位）

目录源头：`github.com/awesome-dsh-plugin/awesome-dsh-plugin`
（npm 上的 `dsh-plugin-catalog` 是它自动发布的，**不要往 npm 包提 PR**）

### 硬条件

| 要求 | 现状 |
| --- | --- |
| 仓库在 **GitHub**（目录 7211 条全是 github.com；CI 用 GitHub API 枚举仓库树） | ❌ 现在只有 Gitee |
| `package.json` 声明 `dsh.bundle` | ✅ 已有 |
| 仓库根有 `cordis.patch.yml` | ✅ 已有 |
| 真实可用的代码 | ✅ |
| 仓库满 **1 天**（查 GitHub 仓库的 `created_at`） | ⚠️ 新镜像要从 0 开始等 |
| 仓库加 `dsh-plugin` topic | ❌ 待加 |
| 描述属实、不带营销词 | ✅ 照实写 |

### 步骤

1. **把仓库镜像到 GitHub**
   发布目录本来就是 git 仓库（带完整历史和 tag）：

   ```sh
   cd C:/Users/was/Desktop/MySQL/dsh-study-mode
   git remote add github https://github.com/<你的用户名>/dsh-study-mode.git
   git push github master --tags
   ```

   没有 `gh` CLI、也没有全局 credential.helper → 要么配 PAT，要么用 SSH key。

2. **给 GitHub 仓库加 topic `dsh-plugin`**（Settings → Topics）

3. **提 PR**：往 `awesome-dsh-plugin/awesome-dsh-plugin` 加**一个文件**
   `data/plugins/<用户名>__dsh-study-mode.yml`
   内容已经备好：`release-assets/catalog-submission.yml`（把 `<GITHUB_USER>` 换掉）。
   发布目录里也有同一份（`CATALOG-SUBMISSION.yml`）。

   - **PR 可以立刻提**，CI 会因为「仓库不够 1 天」报红，但**它会自己重跑**，
     时间到了自动就过了 —— 不用等满一天再提。

4. **合并后** → 脚本自动重新生成 README → 自动发布 `dsh-plugin-catalog`
   → 出现在 **Plugins → Discover**，同时
   `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 也能搜到。

### 分类选哪个

同目录里 644 个「知识/学习/笔记/记忆」类插件的分类分布：

```
memory ×313    tools ×71    ui ×65    workflow ×29    docs ×25    skill ×22
```

**选 `memory`** —— 依据是最像你的那个条目：

> `[memory] dsh-eli-mode#packages/eli-mode`
> "Knowledge-base-driven agent preset: wiki long-term memory, a web KB UI,
> a management page and optional UI polish."

跟你的插件几乎同构（知识库驱动的 agent 预设 + web 知识库界面 + 管理页）。
备选是 `agi`（`dsh-network-engineer`「网络工程师助手预设 + 命令知识库」在那）。
选不准维护者会自己改，不会打回。

### 图标

目录卡片用**位图** tile（`assets/icon-180.png`，PNG，不是 SVG）。
已经生成好：`release-assets/icon-180.png`（用 `.tools/make-icon-180.py` 从 icon.svg 的
同一份 viewBox 几何画出来的），发布时会被拷到发布目录的 `assets/icon-180.png`。
不写 `icon` 字段也行，会回退到作者头像。

## 三、市场的搜索策略（2026-10-28 扒 dshmarket 源码 + 头部插件）

### 打分算法（Discover 标签页的搜索框）

```js
pluginRelevance = max(
    name            权重 700   ← 目录里是 owner/repo
    npm             权重 700   ← 同为最高
    owner           权重 400
    首选语言描述     权重 280   ← 中文界面下就是中文描述
    其它语言描述     权重 240
    category id     权重 180
    category 标签   权重 180)
```

每档内部再分档：字段文本 **完全等于**查询 → +300；**包含**查询整串 → +200；
只是词都在 → +150。多词查询时 **每个词必须出现在同一个字段里**。

排序 = 相关性 → 用户选的排序（默认下载量/星数）→ 目录顺序。

**推论**：

- **名字和 npm 包名的权重是描述的 2.5 倍** —— 描述救不了搜索，名字才管用
- `name` 和 `npm` **同为最高权重 700** → 只要进了目录，搜包名和搜仓库名都能命中
- 中英两种描述都参与打分 → **中英都要写**
- 目录条目的展示名是 `owner/repo` → **包名撞名在目录里不存在**

### 头部插件的共性（同类 772 个，按 30 天下载量排出来的）

| 插件 | 下载/30天 | 包名 | 关键词数 |
| --- | --- | --- | --- |
| dsh-tiddlywiki | 10865 | `dsh-tiddlywiki` | 13 |
| dsh-notes-plugin | 4242 | `dsh-notes-plugin` | 8 |
| dsh-obsidian | 2928 | `dsh-obsidian` | 5 |
| dsh-deeptutor | 1598 | `dsh-deeptutor` | — |
| dsh-noteboard | 1527 | `dsh-noteboard` | — |
| dsh-tutorloop | 1527 | `dsh-tutorloop` | — |

规律：

1. **名字都是 `dsh-` + 一个连字符复合词**，复合词本身就是品类词
   （tutor / note / card / wiki / ask）→ 这些词在 `name` 字段（权重 700）天然命中。
2. **关键词第一条永远是 `dsh` 或 `dsh-plugin`**，然后才是品类词。
3. **中英混排**：`dsh-sidecard-ask` = `selection | 划词 | 选中追问 | ask | side-card | 侧边卡片`。
4. **描述会主动写清边界**，顺带把词塞进去：
   dsh-tiddlywiki 写「…**不是自动记忆插件，不做后台抓取**」——
   既划清了和 memory 类插件的界，又命中了 memory/note 的搜法。
5. **头部插件会塞竞品名**：`dsh-mnemon`（59753 下载）的关键词里有
   `mem0 | hindsight | openviking | honcho | supermemory | byterover | retaindb`
   —— 8 个竞品/替代方案全塞进去，搜那些名字的人也能搜到它。
   （我们只放**属实**的近义词，不塞不实的竞品名。）

## 四、顺手能做的几件小事

- **npm 关键词**（已改到 34 个）：`dsh` / `dsh-plugin` / `dsh-bundle` / `agent-preset` /
  `study-mode` / `knowledge-base` / `note-taking` / `rag` / `retrieval` / `citation` /
  `verified` / `unverified` / `fact-check` / `topic` / `cards` …
  ＋中文「学习模式 / 知识库 / 学习 / 笔记 / 教学 / 卡片 / 检索 / 出处 / 核实」。
  **要发一次版才生效。**
- **npm 描述加字面 `study-mode`**（已改）：npmjs.org 的全文检索给描述的权重远高于包名，
  描述里没有这串字母 → 文本相关性 0（实测 `text=maintainer:waspqj` 能搜到但 `final=0`）。
- **README 放截图**：目录条目页会显示 README，截图比文字管用。
- **Gitee 仓库置顶 + 描述写清「npm 上叫 dsh-study-mode」**，方便朋友和搜索找到。
- **告诉 `plugin_market` 这个 agent 工具**：目录 README 说，dsh 0.2.1+ 的
  Discover 和 `plugin_market` agent 工具都会搜这份索引 —— 进了目录，agent 自己也能找到。

## 五、生态里的撞名（知道就行）

`@littlebugyang/dsh-study-mode`（2026-10-09 发布）—— 别人的「学习模式」插件，
带 `teach` skill 和 `quiz` 工具，路线不同（教学/出题 vs 知识库/入库），
只有 15 次下载。非作用域 `dsh-study-mode` 是我们 10-22 拿到的，没吃亏。

## 六、同类项目怎么做的（2026-10-29 读 README 抄来的）

读了这几个同类的 README 和目录数据，抄了能抄的，列在这儿当参考：

| 项目 | 它怎么被找到（定位手法） | 它的检索 / 设计里值得抄的 |
| --- | --- | --- |
| **dsh-kb-rag**（Breeze136） | 一句话定位；README 首屏贴**真实的工具返回**；写**性能数字**（quick 0.33-0.38s / deep 1.4-1.9s / 冷启 8.9s）；**canonical 声明**（同名和分叉仓库不是发布源）；badge 矩阵（npm 版本 / 下载量 / GitHub release / License / Awesome DSH Plugin / dsh.so 安全徽章） | 混合检索（BM25 + 向量 + bge-reranker + 缓存）；每条结果带**节 / 物理页码 / DOI / 引用链**；`[in-library]` 标记「这条引用已经在库里了」 |
| **dsh-memory-eternal**（EternalNight996） | 副标题就是价值主张（「对话结束自动沉淀，跨会话不失忆；召回只取相关小块，省 token 少噪音」）；改名后 README 顶部挂「已升级到新版本」导流；GIF 演示在首屏 | 四个 agent（DSH / Claude Code / Codex / Cursor）**共用一个库**；左栏有**审核中心 / 回收中心**；明确写「只写自己的键，不依赖也不冲突任何其它记忆插件」 |
| **dsh-eli-mode**（CeilCelia） | 首屏一句狠话：「你没看错，用 wiki 代替 memory 和 skill，谁用谁知道」 | **wiki `[[id]]` 双向链接**（正/反向链接 + 树形目录）；**管理页**里可编辑 persona prompt 和知识库注入 prompt；Windows 桌面版分发 |
| **dsh-tutorloop** | 首屏四段流程：「资料导入 → 小步练习 → 证据反馈 → 复习」 | **能力与边界表**（候选集是 BM25，就写「不承诺与全库完全等价」）；`uncalibrated` 的问题只给定性反馈、分值给 null、不推进掌握 |
| **dsh-deeptutor / dsh-noteboard / dsh-tiddlywiki / dsh-mnemon** | 工具清单 + 真实会话截图；tiddlywiki 有 **filtered search**；mnemon 的 28 个关键词里直接写了竞品名 | 工具少但每个都有明确边界；无限画布 / git 同步冲突解决 |

### 本插件抄了什么、没抄什么

**抄了（0.3.24 已做）**

- 卡片互链 + 正反向链接（eli-mode 的 `[[id]]`）→ 新增 `plugin/links.js` + 详情浮层两段
- README 首屏改成「三条取舍 + 真实命中样例 + 实测性能数字」（kb-rag 的手法）
- 「不做什么（边界）」表（tutorloop 的能力与边界表）
- 「和别的插件共处」声明（memory-eternal 的共存声明）
- canonical 声明（kb-rag 撞名之后加的那段）
- 把「查不到就标未验证」提到首屏当卖点（本插件早就有，只是没写出来）

**没抄（各有原因）**

- **向量检索 + reranker**：kb-rag 那套要装 Python + 1GB 模型。
  本插件的卖点是「零依赖装上就能用」，这一条得单独立项、单独决策（用户还没拍板）。
- **多宿主共用一个库**（memory-eternal）：增长杠杆最大，但改动面也最大。
- **审核中心**（memory-eternal）：本插件已有「预览先行 + 逐条审批」，形态不同，
  暂时不合并成一个独立页面。
- **badge 矩阵里的 Awesome DSH Plugin / dsh.so 安全徽章**：
  `dsh-study-mode` **现在还不在目录里**（本地目录快照 7406 条里搜不到），
  dsh.so 也没有它的 artifact 页（404）。**没收录就不能挂那个徽章** ——
  挂了就是假声明。收录之后再补。


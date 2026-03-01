# Agent-First 架构升级实录

今天完成了 js-knowledge-prism 从"CLI + Plugin"结构到完整 Agent-First 五层架构的升级。起因是分析了 JS-Eyes 项目的架构后，意识到这是一种值得系统化的模式——以 AI Agent 为第一消费者来设计整个项目。

## 做了什么

### 识别架构模式

分析 JS-Eyes 的代码后，归纳出五层架构：Agent 接口层、业务核心层、人类 CLI 层、开发工具链层、扩展技能层。核心理念是"核心逻辑写一次，Agent 和人类各取所需"。已将这套架构模式系统文档化，存入 `docs/agent-first-architecture.md`。

### 评估现状与差距

js-knowledge-prism 的 Layer 1-3 已经成熟——有 5 个 AI Tools、8 个核心模块、独立 CLI。但缺少三块：

- **开发工具链**（Layer 4）：无构建、无版本同步、无自动提交/发布
- **扩展技能体系**（Layer 5）：无子技能机制、无注册表、无发现/安装工具
- **基础设施**：无测试、无安装脚本、无 SKILL.md 入口文件

### 三阶段实施

**Phase 1 — 开发工具链 + 测试**

新建了 `cli/cli.cjs` 开发 CLI，支持 build/bump/commit/sync/release 五个命令。`cli/lib/git.cjs` 封装 Git 操作并适配本项目目录结构自动生成 commit message。`cli/lib/builder.cjs` 实现多目标构建——主技能 zip、子技能 zip、skills.json 注册表。

同时用 `node:test` 建立了测试体系（4 个文件、24 个用例），覆盖 utils、config、status、process 四个核心模块。

有个小插曲：项目 `package.json` 设了 `"type": "module"`，最初创建的 `.js` 文件被当成 ESM 处理，`require()` 报错。解决办法是把开发 CLI 文件统一用 `.cjs` 扩展名。

**Phase 2 — 分发体系**

创建了完整的分发闭环：
- `SKILL.md` — YAML frontmatter + 完整技能文档（架构图、Tools 列表、安装指引、配置项、Troubleshooting）
- `.clawhubignore` — 排除开发文件
- `install.sh` / `install.ps1` — 跨平台一键安装，支持主技能和子技能两种模式
- `CHANGELOG.md`、`RELEASE_NOTES.md`、`SECURITY.md`

验证了 bump 命令能同步三处版本号（package.json、openclaw.plugin.json、SKILL.md），build 命令能输出 50KB 的 skill zip。

**Phase 3 — 扩展技能生态**

创建了第一个子技能 `skills/prism-output-blog/`——将视角转化为博客文章。它注册了两个 AI 工具：`prism_blog_list_ready`（列出可生成博客的视角）和 `prism_blog_generate`（组装文章）。

在主插件 `openclaw-plugin/index.mjs` 中新增了两个技能管理工具：
- `knowledge_prism_discover_skills` — 从 skills.json 注册表查询可用扩展
- `knowledge_prism_install_skill` — 下载、解压、安装依赖、注册到 OpenClaw 配置

构建系统自动扫描 `skills/*/SKILL.md`，解析 frontmatter，打包子技能 zip 并生成 skills.json。全流程验证通过。

## 关键决策

1. **开发 CLI 用 CJS 而非 ESM**：因为项目 `"type": "module"` 导致 `.js` 文件默认走 ESM，而 `require()` 在 CJS 下更直接。用 `.cjs` 扩展名避免与项目其余 ESM 模块冲突。

2. **archiver 是唯一新增依赖**：保持零依赖的核心层不变，只在开发工具链层引入 `archiver` 做 ZIP 打包。

3. **技能注册表是静态 JSON**：构建时生成，可托管在任何静态站。Agent 可直接 fetch 解析，不需要服务端。

4. **Plugin 层增加 textResult 辅助函数**：新增的两个技能管理 Tool 需要格式化文本返回，抽出公共函数简化代码。

## 数据

- 新增文件：20 个
- 修改文件：3 个（package.json、openclaw-plugin/index.mjs、openclaw-plugin/openclaw.plugin.json）
- 未修改：lib/*.mjs（核心层零改动）、bin/cli.mjs（用户 CLI 零改动）
- 测试：24 个用例全部通过
- 构建产物：主技能 50KB zip + 子技能 3.9KB zip + skills.json 注册表

## 感想

这次升级最满意的一点是**核心层完全不需要改动**。所有新增能力（构建、测试、分发、扩展）都是围绕核心层"长出来的"——这恰好验证了 Agent-First 架构"核心逻辑写一次"的设计理念。

五层架构的文档化也很有价值。当模式从具体代码中抽象出来，变成一份可复用的架构蓝图，后续新项目就不用再从头摸索。

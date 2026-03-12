# Release Notes — v1.7.0

风格改写引擎：对已生成产出执行风格变换，支持独立 CLI / output 链式调用 / OpenClaw 插件自动化 / 创作引导技能。

## Highlights

- **独立改写引擎**：新增 `lib/rewrite.mjs`，实现 `loadRewrite`、`listRewrites`、`runRewrite`、`runRewriteBatch` 四个核心函数，与 output 引擎对称设计
- **改写定义体系**：新增 `templates/outputs/rewrites/` 目录，改写定义使用 frontmatter + `# Rewrite Prompt` + 可选 `# Review Prompt` 结构，支持 `{{@include}}` 组件引用
- **内置卡兹克风格**：首个内置改写定义 `kzk-wechat`，将技术文章改写为高传播力微信公众号风格（一句话一段、口语化、钩子开头、三连 CTA）
- **CLI 集成**：
  - 独立 `rewrite` 子命令：`--style`、`--file`/`--dir`、`--review`、`--list-styles`
  - `output --rewrite <style>` 便捷参数：生成后自动链式改写
- **OpenClaw 插件扩展**：
  - 新增 AI 工具 `knowledge_prism_rewrite`（手动改写）和 `knowledge_prism_list_rewrites`（列出可用定义）
  - `knowledge_prism_bind_output` 新增 `rewrites` 数组参数，绑定改写风格到产出配置
  - `knowledge_prism_output_all` 生成后自动执行绑定的改写，支持 `lastRewriteAt` 时间戳
  - `loadConfigBindings` / `mergeBindings` 支持 `.knowledgeprism.json` 中的 `rewrites` 字段
  - CLI 新增 `openclaw prism rewrite` 子命令
- **创作引导技能**：新增 `prism-rewrite-author` 技能，4 问决策引导 + `prism_scaffold_rewrite`（骨架生成）+ `prism_import_rewrite`（从已有提示词导入）
- **智能上下文**：改写时自动从产出文件 frontmatter 的 `refs` 加载 journal/groups 原始素材作为 `{{source_context}}`（截取前 3000 字符）
- **非破坏性输出**：改写结果写入 `_rewrites/<style>/` 子目录，不覆盖原文，支持多风格共存

## Breaking Changes

无。所有新功能均为 opt-in，现有调用方式完全兼容。

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | bash
```

## What's Next

- 更多内置改写定义（知乎、Twitter 线程等）
- 改写 A/B 对比工具
- Hub 页面内嵌实时生成按钮

---

<details>
<summary>v1.6.0</summary>

模块化产出引擎：Prompt 组件化、类型抽象、多粒度素材、质量审校、多阶段流水线和多源绑定。

- **Prompt 组件化**：新增 `components/` 目录，通过 `{{@include path}}` 语法在模板间复用 persona、style、constraints 等片段
- **产出类型抽象**：新增 `types/` 目录，定义 `diary`、`blog` 等类型契约，模板通过 `type: xxx` 继承默认配置
- **多粒度素材注入**：`split` 策略扩展为 `per-kl` / `per-perspective` / `per-group`
- **LLM 质量审校**：`# Review Prompt` 区段 + `--review` 标志
- **多阶段流水线**：`stages` 声明 + `_staging/` 中间产物 + `--stage` 断点续跑
- **多源绑定**：多视角交叉 + 直接从 analysis 生成

</details>

---

<details>
<summary>v1.5.0</summary>

策略化 Structure 刷新：`klStrategy` 替代 `refreshStructure`，支持日期驱动的 KL 自动追加。

- **`klStrategy` 策略分派**：`bind_output` 的 `refreshStructure` 布尔开关升级为 `klStrategy` 枚举，精确控制不同视角类型的 structure 刷新方式
- **`date-driven` 策略**：专为日记/日志型视角设计 — 自动检测 journal 新日期，匹配已处理的 groups，LLM 生成主题标题，追加 KL 行并 expand，不破坏现有 KL 结构
- **`synthesis` 策略（默认）**：等价于原 `refreshStructure: true`，全量重生成 SCQA + Key Lines + expand
- **`manual` 策略**：等价于原 `refreshStructure: false`，不自动刷新
- **代码去重**：batch path 和 mtime fallback path 的 structure 刷新逻辑统一提取为 `refreshByStrategy` 公共函数

</details>

---

<details>
<summary>v1.3.0</summary>

全链路自动化：journal → synthesis → structure → output，一次绑定，定时全通。

- **全链路自动化**：`output_all` 升级为两阶段执行 — 先检测 synthesis/groups 变化自动刷新 structure（SCQA + Key Lines + expand KL），再检测 structure 变化生成 output，实现从原始笔记到成品文章的完全自动化
- **Structure 自动刷新**：绑定新增 `klStrategy` 策略选项（默认 `synthesis`），synthesis 有变化时自动按 perspective 去重执行 `fill_perspective` + `expand_kl`，无需手动干预
- **产出绑定（Output Bindings）**：通过 `knowledge_prism_bind_output` 灵活配置哪些视角+模板组合参与自动产出，支持多对多绑定和独立启停
- **mtime 变化检测**：双层变化检测 — synthesis/groups mtime 驱动 structure 刷新，structure mtime 驱动 output 生成，避免无效 LLM 调用
- **CLI `setup-output-cron`**：一键配置产出定时任务，默认每 120 分钟执行，与处理 cron 独立互不干扰

</details>

<details>
<summary>v1.2.0</summary>

Graph 功能整合到 OpenClaw 插件 + Web UI 知识图谱总览。

- **OpenClaw CLI `prism graph`**：通过 `openclaw prism graph` 直接在插件内生成知识图谱 HTML
- **AI 工具 `knowledge_prism_graph`**：Agent 可自动调用生成图谱并返回统计摘要
- **Web UI 知识图谱总览**：插件通过 OpenClaw HTTP 网关提供 Hub 页面展示所有已注册知识库的图谱状态
- **`filterByPerspective` 导出**：`lib/graph.mjs` 中的视角子图过滤函数现已导出

</details>

<details>
<summary>v1.1.0</summary>

3D 知识图谱可视化升级 + 多项交互优化。

- **3D 交互图谱**：`graph` 命令生成的知识图谱从 2D SVG 升级为 3D WebGL，基于 3d-force-graph + Three.js，支持鼠标旋转、平移、缩放
- **金字塔层级布局**：journal → output 六层节点分布在不同 Y 高度，旋转时立体结构清晰可见
- **3D 文字标签**：每个节点上方渲染名称（SpriteText），始终面向摄像机，无需 hover 即可辨识
- **全链路溯源**：点击节点 BFS 双向遍历完整引用链，高亮链上所有节点和连线，其余暗化
- **引用导航**：详情面板中的 Incoming / Outgoing 列表可点击，相机飞向目标节点
- **离线可用**：`vendor/` 目录存放 JS 库本地副本，HTML 生成时自动内联替代 CDN

</details>

<details>
<summary>v1.0.0</summary>

Initial release of JS Knowledge Prism with full Agent-First Architecture.

- **Pyramid pipeline**: Automatically extract atoms from journal notes, cluster into groups, and synthesize top-level insights
- **5 AI tools**: Full OpenClaw integration for agent-driven knowledge management
- **Perspective system**: SCQA + Key Line framework for structured output generation
- **Dev toolchain**: Build, version sync, commit, and release automation
- **Extension skills**: Pluggable sub-skill system with discovery and installation

</details>

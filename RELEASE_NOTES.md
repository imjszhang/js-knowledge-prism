# Release Notes — v1.5.0

策略化 Structure 刷新：`klStrategy` 替代 `refreshStructure`，支持日期驱动的 KL 自动追加。

## Highlights

- **`klStrategy` 策略分派**：`bind_output` 的 `refreshStructure` 布尔开关升级为 `klStrategy` 枚举，精确控制不同视角类型的 structure 刷新方式
- **`date-driven` 策略**：专为日记/日志型视角设计 — 自动检测 journal 新日期，匹配已处理的 groups，LLM 生成主题标题，追加 KL 行并 expand，不破坏现有 KL 结构
- **`synthesis` 策略（默认）**：等价于原 `refreshStructure: true`，全量重生成 SCQA + Key Lines + expand
- **`manual` 策略**：等价于原 `refreshStructure: false`，不自动刷新
- **代码去重**：batch path 和 mtime fallback path 的 structure 刷新逻辑统一提取为 `refreshByStrategy` 公共函数

## Breaking Changes

- `bind_output` 参数 `refreshStructure` 已移除，替换为 `klStrategy`（`"synthesis"` / `"date-driven"` / `"manual"`）
- 已有绑定中的 `refreshStructure` 字段不再被读取，需重新调用 `bind_output` 设置 `klStrategy`

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | bash
```

## What's Next

- Hub 页面内嵌实时生成按钮（无需手动运行 CLI）
- 图谱快照导出（PNG / SVG）
- 节点聚类分析与自动分组

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

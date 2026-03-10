# Release Notes — v1.4.0

Output Cron 可靠性升级：inbox/batch 轮转、崩溃恢复、失败重试。

## Highlights

- **Inbox/Batch 轮转**：`process_all` 完成时自动向 `output-inbox.jsonl` 追加变更信号；`output_all` 读取 inbox 并原子 rename 为 batch，生产端和消费端互不阻塞
- **崩溃恢复**：每完成一个 Key Line 即更新 batch 文件作为断点，进程中断后重启自动跳过已完成项继续执行
- **失败重试**：单个 KL 输出失败不中断整体流程，registry 中记录 `failedKLs`，后续 cron 自动重试最多 3 次，超限标记 `permanently_failed`
- **Cron 表达式修复**：`minutesToCronExpr` 工具函数正确处理 > 60 分钟间隔（`0 */H * * *`），同时修复 `setup-cron` 和 `setup-output-cron`
- **Fallback 路径**：inbox 为空时自动降级为 mtime 变化检测，兼容手动触发和旧版行为

## Breaking Changes

无。Registry 结构新增 `failedKLs` 字段，旧 registry 自动兼容（视为空数组）。

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
- **Structure 自动刷新**：绑定新增 `refreshStructure` 开关（默认 true），synthesis 有变化时自动按 perspective 去重执行 `fill_perspective` + `expand_kl`，无需手动干预
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

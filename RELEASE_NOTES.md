# Release Notes — v1.3.0

Structure → Output 自动产出 Cron Job：知识棱镜现在可以自动检测 structure 变化并定时生成产出内容。

## Highlights

- **自动产出定时任务**：新增独立 cron job `prism-auto-output`，定期扫描所有已注册知识库的 structure 目录，检测到文件变化后自动调用 LLM 生成 output，形成完整的 journal → synthesis → output 全链路自动化
- **产出绑定（Output Bindings）**：通过 `knowledge_prism_bind_output` 灵活配置哪些视角+模板组合参与自动产出，支持多对多绑定和独立启停
- **mtime 变化检测**：自动对比 `pyramid/structure/<perspective>/` 下文件的最新修改时间与上次产出时间，仅在有变化时触发生成，避免无效 LLM 调用
- **CLI `setup-output-cron`**：一键配置产出定时任务，默认每 120 分钟执行，与处理 cron 独立互不干扰

## Breaking Changes

无。

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

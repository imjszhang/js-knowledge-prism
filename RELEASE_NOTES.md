# Release Notes — v1.2.0

Graph 功能整合到 OpenClaw 插件 + Web UI 知识图谱总览。

## Highlights

- **OpenClaw CLI `prism graph`**：通过 `openclaw prism graph` 直接在插件内生成知识图谱 HTML，支持 `--base-dir`、`--output`、`--json`、`--perspective` 选项
- **AI 工具 `knowledge_prism_graph`**：Agent 可自动调用生成图谱并返回统计摘要（节点数、覆盖率、孤立节点、断链等）
- **Web UI 知识图谱总览**：插件通过 OpenClaw HTTP 网关注册路由 `/plugins/knowledge-prism/`，提供 Hub 页面展示所有已注册知识库的图谱状态，点击即可在浏览器中查看 3D 图谱
- **`filterByPerspective` 导出**：`lib/graph.mjs` 中的视角子图过滤函数现已导出，可供外部调用

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

# Release Notes — v1.1.0

3D 知识图谱可视化升级 + 多项交互优化。

## Highlights

- **3D 交互图谱**：`graph` 命令生成的知识图谱从 2D SVG 升级为 3D WebGL，基于 3d-force-graph + Three.js，支持鼠标旋转、平移、缩放
- **金字塔层级布局**：journal → output 六层节点分布在不同 Y 高度，旋转时立体结构清晰可见
- **3D 文字标签**：每个节点上方渲染名称（SpriteText），始终面向摄像机，无需 hover 即可辨识
- **全链路溯源**：点击节点 BFS 双向遍历完整引用链，高亮链上所有节点和连线，其余暗化
- **引用导航**：详情面板中的 Incoming / Outgoing 列表可点击，相机飞向目标节点
- **离线可用**：`vendor/` 目录存放 JS 库本地副本，HTML 生成时自动内联替代 CDN

## Breaking Changes

无。

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.sh | bash
```

## What's Next

- 图谱快照导出（PNG / SVG）
- 节点聚类分析与自动分组
- Additional output skills (blog, slides, academic paper)
- Landing page and GitHub Pages deployment
- CI/CD pipeline

---

<details>
<summary>v1.0.0</summary>

Initial release of JS Knowledge Prism with full Agent-First Architecture.

- **Pyramid pipeline**: Automatically extract atoms from journal notes, cluster into groups, and synthesize top-level insights
- **5 AI tools**: Full OpenClaw integration for agent-driven knowledge management
- **Perspective system**: SCQA + Key Line framework for structured output generation
- **Dev toolchain**: Build, version sync, commit, and release automation
- **Extension skills**: Pluggable sub-skill system with discovery and installation

</details>

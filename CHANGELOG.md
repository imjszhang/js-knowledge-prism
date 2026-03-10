# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-03-10

### Added

- **3D 知识图谱**：`graph` 命令生成的可视化从 2D D3.js 力导向图升级为 3D 交互图谱（基于 3d-force-graph + Three.js）
  - 鼠标左键旋转、右键平移、滚轮缩放
  - 金字塔层级布局：journal → atom → group → synthesis → perspective → output 分布在不同 Y 高度
  - 3D 文字标签（SpriteText），始终面向摄像机
- **全链路溯源高亮**：点击节点 BFS 遍历完整引用链（上溯至 journal / 下探至 output），链上节点与连线高亮，其余暗化
- **详情面板引用导航**：Incoming / Outgoing 列表中的条目可点击，相机飞向目标节点并打开详情
- **空状态引导**：无节点或无关系时显示操作引导，提示运行 `process` 命令
- **离线支持**：`vendor/` 目录存放 JS 库本地副本，生成 HTML 时自动内联替代 CDN

### Changed

- `addLink` 增加 Set 去重，防止相同 source+target+type 的 link 重复添加
- `analyzeGraph` 返回值新增 `isEmpty` / `hasNoLinks` 字段
- 详情面板改为绝对定位浮层，未打开时不占布局空间
- 图谱容器从 `<svg>` 替换为 `<div>`（WebGL canvas）

### Removed

- 移除 D3.js SVG 渲染相关代码和 CSS

## [1.0.0] - 2026-03-01

### Added

- Core pipeline: journal → atoms → groups → synthesis
- Five AI tools for OpenClaw integration:
  - `knowledge_prism_process` — incremental pipeline execution
  - `knowledge_prism_status` — knowledge base status query
  - `knowledge_prism_new_perspective` — create perspective skeleton
  - `knowledge_prism_fill_perspective` — generate SCQA / Key Line content
  - `knowledge_prism_expand_kl` — expand Key Line into full document
- CLI commands: `init`, `process`, `status`, `new-perspective`
- OpenClaw plugin with CLI sub-commands (`openclaw prism ...`)
- Dev toolchain: `build`, `bump`, `commit`, `sync`, `release`
- Test suite using `node:test` (24 tests)
- SKILL.md for ClawHub/OpenClaw distribution
- Cross-platform install scripts (`install.sh`, `install.ps1`)
- Extension skills system with registry (`skills.json`)
- Agent-First Architecture documentation

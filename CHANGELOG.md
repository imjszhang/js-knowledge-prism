# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-03-11

### Changed

- **Breaking: `refreshStructure` → `klStrategy`**：绑定的 `refreshStructure: boolean` 字段替换为 `klStrategy: "synthesis" | "date-driven" | "manual"`
  - `synthesis`（默认）：等价于原来的 `refreshStructure: true`，全量重生成 SCQA + Key Lines + expand
  - `date-driven`：新增策略，仅扫描 journal 新日期并追加 KL 行 + expand 新 KL（适合日记/日志型视角如 P23）
  - `manual`：等价于原来的 `refreshStructure: false`，不自动刷新 structure
- 两处 structure 刷新路径（batch path / mtime fallback）统一提取为 `refreshByStrategy` 公共函数

### Added

- 新增 `lib/date-driven-kl.mjs`：日期驱动 KL 策略的核心逻辑
  - `detectNewDates(paths, perspectiveDir)`：对比 journal 日期 vs 已注册 KL，返回待追加的新日期
  - `buildAbbrevToGroupsMap(groupsDir)`：构建 atom 缩写 → groups 映射表
  - `appendDateKls(opts)`：LLM 生成主题标题，追加 KL 行到 tree/README.md

## [1.3.0] - 2026-03-11

### Added

- **自动产出 Cron Job**：新增独立的 `prism-auto-output` 定时任务，定期检测 structure 目录变化并自动调用 LLM 生成 output 内容
- **产出绑定管理**：通过 `outputBindings` 配置哪些视角+模板组合参与自动产出
  - 新增 AI 工具 `knowledge_prism_bind_output`：绑定/禁用视角+模板的自动产出
  - 新增 AI 工具 `knowledge_prism_list_output_bindings`：列出所有产出绑定及状态
  - 新增 AI 工具 `knowledge_prism_output_all`：批量生成所有已绑定产出，含 mtime 变化检测
- **CLI 命令 `prism setup-output-cron`**：一键配置产出定时任务（默认 120 分钟间隔）
- **配置 schema 扩展**：`cron.outputInterval` 配置项，控制自动产出的执行间隔
- **Registry 扩展**：`bases[].outputBindings` 数组，存储产出绑定元数据（perspectiveDir、template、enabled、lastOutputAt）
- **Structure 自动刷新**：`output_all` 执行前自动检测 synthesis/groups 变化，按 perspective 去重刷新 SCQA、Key Lines 和 expand KL，实现 synthesis → structure → output 全链路自动化
  - 绑定新增 `refreshStructure` 开关（默认 true），可按绑定关闭自动刷新
  - 绑定新增 `lastStructureRefreshAt` 时间戳，用于 synthesis/groups 变化检测

### Changed

- `knowledge_prism_register` 新注册条目自动包含空 `outputBindings` 数组，兼容旧 registry 数据
- `knowledge_prism_output_all` 升级为两阶段执行：Phase 1 structure 刷新 + Phase 2 output 生成
- `prism-processor` 技能文档（SKILL.md）更新至 v1.1.0，新增产出绑定管理和定时产出流程章节

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

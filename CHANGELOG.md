# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.8.0] - 2026-03-13

### Changed

- **模板架构重构：脚手架 + 技能引导**：移除所有内置内容模板，工具不再包含任何特定风格/类型/人设的模板文件
  - 移除 `templates/outputs/components/persona/blogger.md`、`style/narrative.md`
  - 移除 `templates/outputs/types/diary.md`、`blog.md`
  - 移除 `templates/outputs/prompts/practice-diary.md`
  - 移除 `templates/outputs/rewrites/kzk-wechat.md`（迁移到知识库 `outputs/_templates/rewrites/`）
  - 上述文件替换为 `_scaffold.md` 脚手架，供技能引导填充
- **移除独立扩展技能体系**：
  - 移除 `skills/prism-output-blog/`（预打包博客生成扩展，用户可通过 `prism-template-author` 自建博客模板）
  - 移除 `skills/prism-template-author/` 和 `skills/prism-rewrite-author/` 的独立扩展版本（含 AI 工具 `prism_scaffold_template` 等），功能由内置技能 SKILL.md 引导取代
  - `prism-template-author` 和 `prism-rewrite-author` 从可安装扩展变为 `openclaw-plugin/skills/` 内置技能
  - `schema-reference.md` 迁移到 `openclaw-plugin/skills/prism-template-author/`
- `listTemplates`、`listTypes`、`listRewrites` 自动过滤 `_` 开头的脚手架文件
- `templates/outputs/README.md` 更新目录结构和模板查找说明，反映"脚手架 + 技能"架构
- SKILL.md Extension Skills 章节区分"内置"和"扩展"技能

### Added

- **`prism-template-author` 内置技能**：`openclaw-plugin/skills/prism-template-author/SKILL.md`，引导创建 persona→style→type→prompt 四层模板体系，含风格提炼、迭代优化和质量检查清单
- **`prism-rewrite-author` 内置技能**：`openclaw-plugin/skills/prism-rewrite-author/SKILL.md`，引导创建改写定义，支持从参考文章提炼风格规则
- 五个脚手架文件：`persona/_scaffold.md`、`style/_scaffold.md`、`types/_scaffold.md`、`prompts/_scaffold.md`、`rewrites/_scaffold.md`

### Retained

- `templates/outputs/components/constraints.md`（全局硬性约束）和 `review/base.md`（通用审校标准）作为通用基础设施保留

## [1.7.0] - 2026-03-12

### Added

- **风格改写引擎 `lib/rewrite.mjs`**：独立于 output 的后处理模块
  - `loadRewrite(name, baseDir)`：加载改写定义（本地 `_templates/rewrites/` > 内置 `rewrites/`）
  - `listRewrites(baseDir)`：列出所有可用改写定义
  - `runRewrite(opts)`：对单个文件执行改写，自动从 frontmatter refs 加载 source_context
  - `runRewriteBatch(opts)`：批量改写目录下所有 .md 文件
- **改写定义资源 `templates/outputs/rewrites/`**：新增改写定义目录，与 prompts/components/types 平级
  - frontmatter 字段：`name`、`description`、`platform`、`preserveStructure`、`preserveLinks`、`preserveFrontmatter`
  - `# Rewrite Prompt` + 可选 `# Review Prompt` 区段，支持 `{{@include}}` 组件引用
- **内置改写定义 `kzk-wechat`**：微信公众号卡兹克风格（口语化、一句话一段、钩子开头、三连 CTA、信息保留度审校）
- **CLI `rewrite` 子命令**：`bin/cli.mjs` 新增 rewrite 分发，支持 `--style`、`--file`/`--dir`、`--review`、`--dry-run`、`--list-styles`
- **`output --rewrite <style>`**：output 命令新增便捷参数，生成后自动链式改写新产出
- **OpenClaw 插件 AI 工具**：
  - `knowledge_prism_rewrite`：手动对指定文件或目录执行改写，支持 perspectiveDir+template 自动定位
  - `knowledge_prism_list_rewrites`：列出可用改写定义（内置和自定义）
- **`knowledge_prism_bind_output` 扩展**：新增 `rewrites` 数组参数，绑定改写风格到产出配置；验证每个 rewrite name 对应的定义存在
- **`knowledge_prism_list_output_bindings` 扩展**：输出中显示 `rewrites` 配置和 `lastRewriteAt` 时间戳
- **`knowledge_prism_output_all` 扩展**：生成后自动对 binding.rewrites 中的风格执行改写（batch path 和 mtime fallback path 均支持）
- **`loadConfigBindings` / `mergeBindings` 扩展**：支持 `.knowledgeprism.json` 中 `output.bindings[].rewrites` 字段
- **OpenClaw CLI `prism rewrite`**：新增 rewrite 子命令（`--style`、`--file`/`--dir`、`--review`、`--list-styles`）
- **`prism-rewrite-author` 技能**：新增 `skills/prism-rewrite-author/` 目录
  - `SKILL.md`：4 问决策引导（平台、语气、结构改造、审校）+ Scaffold → Fill → Verify 工作流
  - `prism_scaffold_rewrite` AI 工具：生成改写定义骨架文件到 `_templates/rewrites/`
  - `prism_import_rewrite` AI 工具：从已有提示词文件自动转换为标准改写定义格式

### Changed

- `templates/outputs/README.md` 架构图、目录结构、查找优先级表、CLI 参考均更新，新增"改写（Rewrites）"核心概念章节
- `skills/prism-template-author/schema-reference.md` 新增 Rewrite 定义 Schema（frontmatter 字段表、变量表、区段规范）
- `README.md` 新增 `rewrite` CLI 命令、编程 API、AI 工具表和扩展技能表条目

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

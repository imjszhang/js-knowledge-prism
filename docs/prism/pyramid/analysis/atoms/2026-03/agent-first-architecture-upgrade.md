# Agent-First 架构升级实录

> 来源：[../../../../journal/2026-03-01/agent-first-architecture-upgrade.md](../../../../journal/2026-03-01/agent-first-architecture-upgrade.md)
> 缩写：AU

## Atoms

| 编号  | 类型 | 内容                                                                                               | 原文定位                    |
| ----- | ---- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| AU-01 | 事实 | js-knowledge-prism 从"CLI + Plugin"结构升级到完整 Agent-First 五层架构。 | 标题 |
| AU-02 | 经验 | 分析 JS-Eyes 项目代码后归纳出五层架构模式，并将其系统文档化为可复用的架构蓝图。 | 识别架构模式 |
| AU-03 | 事实 | 升级前 Layer 1-3 已成熟（5 个 AI Tools、8 个核心模块、独立 CLI），缺少 Layer 4（开发工具链）、Layer 5（扩展技能）和基础设施（测试、安装脚本、SKILL.md）。 | 评估现状与差距 |
| AU-04 | 步骤 | Phase 1：新建 `cli/cli.cjs` 开发 CLI（build/bump/commit/sync/release），`cli/lib/builder.cjs` 实现多目标构建，用 `node:test` 建立 24 个测试用例。 | Phase 1 |
| AU-05 | 经验 | 项目 `"type": "module"` 导致 `.js` 被当 ESM 处理，`require()` 报错；解决办法是开发 CLI 文件用 `.cjs` 扩展名。 | Phase 1 小插曲 |
| AU-06 | 步骤 | Phase 2：创建 SKILL.md、`.clawhubignore`、跨平台安装脚本（install.sh / install.ps1）、CHANGELOG/RELEASE_NOTES/SECURITY.md，形成完整分发闭环。 | Phase 2 |
| AU-07 | 步骤 | Phase 3：创建子技能 `prism-output-blog/`（2 个 AI 工具），主插件新增 `discover_skills` 和 `install_skill` 两个技能管理工具，构建系统自动扫描生成 skills.json。 | Phase 3 |
| AU-08 | 判断 | 开发 CLI 用 CJS 而非 ESM，是为避免与项目 ESM 模块冲突。 | 关键决策 |
| AU-09 | 判断 | archiver 是唯一新增依赖，核心层保持零依赖。 | 关键决策 |
| AU-10 | 经验 | 整个升级过程核心层（lib/*.mjs）完全零改动，验证了 Agent-First 架构"核心逻辑写一次"的设计理念。 | 感想 |
| AU-11 | 判断 | 将架构模式从具体代码中抽象为可复用蓝图，能降低新项目的摸索成本。 | 感想 |

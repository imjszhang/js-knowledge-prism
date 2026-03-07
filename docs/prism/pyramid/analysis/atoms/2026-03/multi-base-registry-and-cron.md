# 多知识库注册机制与 Cron 定时自动处理

> 来源：[../../../../journal/2026-03-07/multi-base-registry-and-cron.md](../../../../journal/2026-03-07/multi-base-registry-and-cron.md)
> 缩写：RC

## Atoms

| 编号  | 类型 | 内容                                                                                               | 原文定位                    |
| ----- | ---- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| RC-01 | 事实 | 原有插件配置只支持单一 `baseDir`，无法同时管理多个知识库，也没有定时调度能力。 | 问题背景 |
| RC-02 | 事实 | 参考 js-knowledge-collector 的 link-collector 三层协作模式：CLI 命令注册定时任务 → Cron 触发隔离会话 → Skill 定义 Agent 执行流程。 | 参考模型 |
| RC-03 | 判断 | prism 的 `runPipeline` 天然幂等增量（对比 journal 和 atoms 目录发现未处理文件），不需要像 collector 那样设计 inbox/batch 轮转机制。 | 关键差异 |
| RC-04 | 事实 | 注册表 `registry.json` 存储在 `<workspace>/.openclaw/prism-processor/` 下，写入采用 tmp + rename 原子操作。 | 设计方案 |
| RC-05 | 判断 | `process_all` 用单一工具封装批量操作，而非逐库调用，减少 cron 场景下的 LLM round-trip 开销。 | process_all |
| RC-06 | 经验 | OpenClaw workspace 路径不在 `agents.defaults.workspace` 中，实际在 `agents.list[0].workspace` 里，需要多级 fallback 解析。 | Workspace 路径解析 |
| RC-07 | 事实 | 新增 4 个 CLI 子命令（register/unregister/registered/setup-cron）和 4 个 AI 工具（register/unregister/list_registered/process_all）。 | 实现内容 |
| RC-08 | 事实 | 新增 `prism-processor/SKILL.md` 技能定义，覆盖触发条件、注册管理、定时处理流程、容错和并发安全。 | 实现内容 |
| RC-09 | 判断 | registry 是 OpenClaw 插件层面的概念，核心 lib/ 始终面向单个 baseDir 工作，职责分离清晰。 | 核心 lib/ 零改动 |
| RC-10 | 步骤 | 部署流程：重启 gateway → `register <dir>` 注册知识库 → `setup-cron --every 60` 配置定时任务。 | 部署验证 |
| RC-11 | 经验 | 插件通过路径链接安装（`plugins.load.paths` 指向源码目录），代码改动直接生效，只需重启 gateway。 | 部署验证 |
| RC-12 | 经验 | 优先复用已有的增量机制；在 cron 场景下减少 LLM round-trip 比代码优雅更重要；workspace 路径不能硬编码。 | 经验总结 |

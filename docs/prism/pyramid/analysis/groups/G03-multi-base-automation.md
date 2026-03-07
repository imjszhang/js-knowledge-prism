# G03: 多知识库注册与自动化管理是 Agent-First 插件生态在运维层面的自然延伸。

> 通过注册表 + Cron 定时处理机制，将单一知识库的手动操作扩展为多库自动批量处理，同时保持核心层不变。

## 包含的 Atoms

| 编号  | 来源                     | 内容摘要 |
| ----- | ------------------------ | -------- |
| RC-01 | multi-base-registry-and-cron | 原有插件配置只支持单一 `baseDir`，无法同时管理多个知识库，也没有定时调度能力。 |
| RC-02 | multi-base-registry-and-cron | 参考 js-knowledge-collector 的 link-collector 三层协作模式：CLI 注册 → Cron 触发 → Skill 定义流程。 |
| RC-03 | multi-base-registry-and-cron | prism 的 `runPipeline` 天然幂等增量，不需要设计 inbox/batch 轮转机制。 |
| RC-04 | multi-base-registry-and-cron | 注册表 `registry.json` 存储在 workspace 下，写入采用 tmp + rename 原子操作。 |
| RC-05 | multi-base-registry-and-cron | `process_all` 用单一工具封装批量操作，减少 cron 场景下的 LLM round-trip 开销。 |
| RC-06 | multi-base-registry-and-cron | OpenClaw workspace 路径需要多级 fallback 解析（defaults → list[0] → cwd）。 |
| RC-07 | multi-base-registry-and-cron | 新增 4 个 CLI 子命令和 4 个 AI 工具，扩展插件的多库管理能力。 |
| RC-08 | multi-base-registry-and-cron | 新增 prism-processor SKILL.md 技能定义，覆盖触发条件、注册管理、容错和并发安全。 |
| RC-09 | multi-base-registry-and-cron | registry 是插件层概念，核心 lib/ 始终面向单个 baseDir，职责分离清晰。 |
| RC-10 | multi-base-registry-and-cron | 部署流程：重启 gateway → 注册知识库 → 配置定时任务。 |
| RC-11 | multi-base-registry-and-cron | 插件通过路径链接安装，代码改动直接生效，只需重启 gateway。 |
| RC-12 | multi-base-registry-and-cron | 优先复用增量机制；减少 LLM round-trip 比代码优雅更重要；workspace 路径不能硬编码。 |

## 组内逻辑顺序

从问题出发（单库限制）→ 参考已有模式 → 关键差异判断 → 设计方案 → 实现内容 → 部署验证 → 经验总结，遵循问题-方案-验证的实践闭环。

# G02: Agent-First 架构模式强调以 AI Agent 为中心，优化工具和项目能力的结构化调用。

> Agent-First 架构模式将 AI Agent 作为项目的第一消费者，以结构化调用为中心设计工具和项目能力，从而优化整个开发和使用流程。

## 包含的 Atoms

| 编号  | 来源                     | 内容摘要 |
| ----- | ------------------------ | -------- |
| AF-01 | agent-first-architecture | Agent-First 架构模式将 AI Agent 作为项目的第一消费者，以结构化调用为中心设计工具和项目能力 |
| AF-02 | agent-first-architecture | Agent-First 架构中的工具首先为 AI Agent 设计，其次考虑人类 CLI |
| AF-03 | agent-first-architecture | 项目应具备被 Agent 发现、安装、配置、扩展的能力 |
| AF-04 | agent-first-architecture | 开发流程工具化，可被 Agent 或脚本驱动 |
| AF-05 | agent-first-architecture | 架构全景展示了从 Agent 接口层到扩展技能层的五层结构 |
| AF-06 | agent-first-architecture | Layer 1: Agent 接口层是架构的核心，通过 `register(api)` 函数暴露项目能力给 Agent 框架 |
| AF-07 | agent-first-architecture | Layer 1 中定义了三种注册原语：Tool、Service 和 CLI，分别面向 AI Agent、框架运行时和人类用户 |
| AF-08 | agent-first-architecture | Tool 设计原则包括使用自然语言描述用途、严格定义输入参数和返回值，以及可选工具的标记 |
| AF-09 | agent-first-architecture | Service 生命周期包括启动和停止方法，用于管理后台服务 |
| AF-10 | agent-first-architecture | 配置 Schema 定义了插件的配置项和类型约束，uiHints 提供 GUI 的本地化标签和帮助文本 |
| AF-11 | agent-first-architecture | Layer 2: 业务核心层独立于 Agent 框架，可以被 Plugin 层、CLI 层、测试调用 |
| AF-12 | agent-first-architecture | 业务核心层的设计原则包括零框架依赖、函数式导出和可独立测试 |
| AF-13 | agent-first-architecture | 业务核心层典型模块划分包括配置加载、核心业务管道、状态查询和通用工具 |
| AF-14 | agent-first-architecture | 核心层与 Plugin 层的关系是 Plugin 层作为核心层的薄包装，映射核心函数到 Tool 的 execute 方法等 |
| AF-15 | agent-first-architecture | Layer 3: 人类 CLI 层提供独立可执行的命令行接口，供不使用 Agent 框架的用户直接调用 |
| AF-16 | agent-first-architecture | Layer 4: 开发工具链统一管理项目开发生命周期的每个阶段 |
| AF-17 | agent-first-architecture | 开发工具链的命令清单包括多目标构建、版本同步、规范提交、一键同步和自动发布 |
| AF-18 | agent-first-architecture | 构建系统核心是多目标输出，包括站点、技能包、子技能包和技能注册表 |
| AF-19 | agent-first-architecture | 版本同步确保所有版本声明一致，包括 package.json、plugin.json 和其他 manifest |
| AF-20 | agent-first-architecture | 自动 Commit Message 根据 git diff --stat 分析变更文件，自动生成语义化提交信息 |
| AF-21 | agent-first-architecture | Layer 5: 扩展技能层承载子技能，形成插件生态 |
| AF-22 | agent-first-architecture | 技能目录结构包括技能描述、独立依赖和子技能插件 |
| AF-23 | agent-first-architecture | SKILL.md Frontmatter 作为技能的“身份证”，构建系统扫描它来生成注册表 |
| AF-24 | agent-first-architecture | 技能注册表在构建时自动生成，运行时供 Agent 查询和安装 |
| AF-25 | agent-first-architecture | 发现与安装闭环允许 Agent 自行发现、评估、安装所需技能 |
| AF-26 | agent-first-architecture | 跨平台安装脚本实现一命令安装，包括环境检测、安装目录确定、下载技能包、解压和注册到宿主框架配置 |
| AF-27 | agent-first-architecture | 测试策略使用 Node.js 内置 `node:test`，零外部依赖 |
| AF-28 | agent-first-architecture | 文档结构包括 README、SKILL、CHANGELOG、RELEASE_NOTES、SECURITY 和 docs 目录 |
| AF-29 | agent-first-architecture | 发布流程包括版本同步、构建、提交、推送和发布，或者用 `sync` 一键完成 |
| AF-30 | agent-first-architecture | 零外部依赖或极少依赖是因为技能包需要被用户下载安装，体积和依赖复杂度直接影响安装成功率 |
| AF-31 | agent-first-architecture | 不使用 monorepo 工具是因为项目规模不需要，构建逻辑集中在一个 `builder.js` 里，且避免增加学习成本 |
| AF-32 | agent-first-architecture | Plugin 层和 CLI 层分离是因为它们可以独立使用，但两者调用相同的核心模块，保证行为一致 |
| AF-33 | agent-first-architecture | 技能注册表是静态 JSON 而非 API 是因为它可托管在任何静态站，无需服务器，且构建时生成，不存在运行时一致性问题 |
| AF-34 | agent-first-architecture | 五层架构速查表总结了每层的目录、面向对象和核心职责 |

## 组内逻辑顺序

Agent-First 架构的介绍遵循从架构理念到具体实现细节的顺序，首先是架构的基本概念和设计原则，然后是各层的具体功能和实现方式，最后是开发和部署过程中的工具和流程。

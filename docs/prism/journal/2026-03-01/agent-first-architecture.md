# Agent-First Architecture

一种以 AI Agent 为第一消费者的 Node.js 项目架构模式。

> 参考实现：[JS-Eyes](https://github.com/imjszhang/js-eyes) — 浏览器自动化工具

---

## 核心理念

传统软件架构以人类用户为中心——CLI 给人用、API 给开发者调。Agent-First 架构则将 **AI Agent 作为项目的第一消费者**：

- 工具（Tools）首先为 Agent 的结构化调用设计，其次才考虑人类 CLI
- 项目自身具备被 Agent 发现、安装、配置、扩展的完整能力
- 开发流程本身也工具化，可被 Agent 或脚本驱动

```
┌─────────────────────────────────────────────────────────┐
│                      AI Agent                           │
│              (第一消费者，结构化调用)                       │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┼──────────────────┐
          ▼              ▼                  ▼
    ┌──────────┐  ┌────────────┐   ┌──────────────┐
    │  Tools   │  │  Services  │   │     CLI      │
    │ (AI 工具) │  │ (后台服务)  │   │ (人类接口)    │
    └──────────┘  └────────────┘   └──────────────┘
          │              │                  │
          └──────────────┼──────────────────┘
                         ▼
              ┌────────────────────┐
              │    Core Logic      │
              │   (业务核心模块)     │
              └────────────────────┘
```

---

## 架构全景

```
project-root/
│
├── openclaw-plugin/           ← Layer 1: Agent 接口层
│   ├── index.mjs              ← register(api)：注册 Tools + Services + CLI
│   ├── openclaw.plugin.json   ← 插件元数据、配置 Schema、UI Hints
│   └── package.json
│
├── lib/ (或 server/, clients/) ← Layer 2: 业务核心层
│   ├── ...                    ← 可独立运行的核心逻辑
│   └── ...
│
├── bin/                       ← Layer 3: 人类 CLI 层
│   └── cli.mjs                ← 独立可执行入口
│
├── cli/                       ← Layer 4: 开发工具链
│   ├── cli.js                 ← 开发流程命令分发器
│   └── lib/
│       ├── builder.js         ← 多目标构建
│       └── git.js             ← commit/push/release 自动化
│
├── skills/                    ← Layer 5: 扩展技能层
│   └── <skill-name>/
│       ├── SKILL.md           ← 技能元数据 (YAML frontmatter)
│       └── openclaw-plugin/   ← 子技能插件
│
├── templates/                 ← 初始化模板
├── test/                      ← 测试
├── src/                       ← 落地页源码
├── docs/                      ← 构建输出 + 文档
│
├── install.sh                 ← 跨平台安装脚本
├── install.ps1
├── SKILL.md                   ← 技能入口描述
├── CHANGELOG.md
├── RELEASE_NOTES.md
└── package.json
```

---

## Layer 1: Agent 接口层 — OpenClaw Plugin

这是整个架构的灵魂。一个 `register(api)` 函数将项目的所有能力暴露给 Agent 框架。

### 1.1 三种注册原语

| 原语 | 方法 | 面向对象 | 说明 |
|------|------|---------|------|
| **Tool** | `api.registerTool()` | AI Agent | Agent 可调用的原子操作，带结构化参数和返回值 |
| **Service** | `api.registerService()` | 框架运行时 | 后台服务（如 WebSocket Server），随插件生命周期自动启停 |
| **CLI** | `api.registerCli()` | 人类用户 | 挂载到宿主框架的子命令（如 `openclaw <plugin> status`） |

### 1.2 Tool 设计原则

```javascript
api.registerTool({
  name: "tool_name",              // Agent 调用时的标识符
  label: "Human Readable Name",   // UI 展示名
  description: "...",             // 给 Agent 的自然语言描述，决定何时被调用
  parameters: {                   // JSON Schema，Agent 按此构造参数
    type: "object",
    properties: { ... },
    required: [...]
  },
  async execute(_toolCallId, params) {
    // 执行逻辑，返回 { content: [{ type: "text", text: "..." }] }
  }
}, { optional: true });
```

关键要点：

- **description 是 Agent 的"文档"**：写给 LLM 看，要用自然语言说清用途和适用场景
- **parameters 是 Agent 的"接口契约"**：用 JSON Schema 严格定义输入
- **返回值是结构化文本**：Agent 需要能解析的格式（Markdown 表格、JSON 等）
- **`{ optional: true }`**：标记为可选工具，缺少依赖时不阻断插件加载

### 1.3 Service 生命周期

```javascript
api.registerService({
  id: "my-service",
  async start(ctx) {
    // 插件加载时自动启动
    // ctx.logger 用于日志输出
  },
  async stop(ctx) {
    // 插件卸载或进程退出时清理资源
  }
});
```

典型用途：启动本地服务器、建立长连接、初始化运行时环境。

### 1.4 配置 Schema（openclaw.plugin.json）

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "serverPort": {
        "type": "number",
        "default": 18080,
        "description": "服务器端口"
      }
    }
  },
  "uiHints": {
    "serverPort": {
      "label": "服务器端口",
      "help": "WebSocket 服务监听端口"
    }
  }
}
```

- `configSchema` 让框架知道有哪些可配置项以及类型约束
- `uiHints` 给 GUI 提供本地化标签和帮助文本
- 运行时通过 `api.pluginConfig` 读取用户配置

---

## Layer 2: 业务核心层

核心逻辑独立于 Agent 框架存在，可以被 Plugin 层、CLI 层、测试分别调用。

### 2.1 设计原则

- **零框架依赖**：核心模块不 import 任何 Agent 框架的 API
- **函数式导出**：每个模块导出纯函数或类，不绑定全局状态
- **可独立测试**：通过 mock 外部依赖即可测试

### 2.2 典型模块划分

```
lib/
├── config.mjs          ← 配置加载（文件 + 环境变量）
├── process.mjs         ← 核心业务管道
├── status.mjs          ← 状态查询
├── utils.mjs           ← 通用工具
└── ...
```

或者按组件拆分：

```
server/
├── index.js            ← 服务器入口（createServer + start/stop）
└── ws-handler.js       ← 消息处理逻辑

clients/
└── client.js           ← 客户端 SDK（类，可编程调用）
```

### 2.3 核心层与 Plugin 层的关系

```
openclaw-plugin/index.mjs
    │
    ├── import { createServer } from "../server/index.js"
    ├── import { Client } from "../clients/client.js"
    └── import { runPipeline } from "../lib/process.mjs"
```

Plugin 层是核心层的 **薄包装**（thin wrapper）：
- 将核心函数映射为 Tool 的 execute 方法
- 将服务创建/销毁映射为 Service 的 start/stop
- 将状态查询映射为 CLI 的 action

---

## Layer 3: 人类 CLI 层

提供独立可执行的命令行接口，供不使用 Agent 框架的用户直接调用。

```
bin/cli.mjs
├── init       ← 初始化项目
├── process    ← 执行核心处理
├── status     ← 查看状态
└── ...
```

- 与 Plugin 层调用相同的核心模块
- 输出格式更偏人类友好（彩色、进度条等）
- 可选——有些项目只需 Plugin 层

---

## Layer 4: 开发工具链

统一的内部 CLI，管理项目开发生命周期的每个阶段。

### 4.1 命令清单

| 命令 | 作用 | 说明 |
|------|------|------|
| `build <target>` | 多目标构建 | site / skill-zip / sub-skill-zips / skills.json |
| `bump <version>` | 版本同步 | 更新 package.json + plugin.json + 其他 manifest |
| `commit` | 规范提交 | 自动 git add + 根据 diff 生成 commit message |
| `sync` | 一键同步 | build → commit → push |
| `release` | 自动发布 | 创建 GitHub Release + 上传构建产物 |
| `setup-*` | 基础设施 | 配置 GitHub Pages / Cloudflare 等 |

### 4.2 构建系统

构建系统的核心是 **多目标输出**：

```
源码                        构建目标                    产出
─────────────────────────────────────────────────────────────
src/                   →    site                   →   docs/index.html
openclaw-plugin/ +     →    skill zip              →   docs/project-skill.zip
  server/ + clients/
skills/<name>/         →    sub-skill zip          →   docs/skills/<name>/<name>-skill.zip
skills/*/SKILL.md      →    skills registry        →   docs/skills.json
install.sh/ps1         →    install scripts        →   docs/install.sh, docs/install.ps1
```

### 4.3 版本同步

`bump` 命令确保所有版本声明一致：

```
package.json            →  version: "1.4.3"
openclaw.plugin.json    →  version: "1.4.3"
SKILL.md frontmatter    →  version: 1.4.3
其他 manifest.json      →  version: "1.4.3"
```

### 4.4 自动 Commit Message

根据 `git diff --stat` 分析变更文件，自动生成语义化提交信息：
- 修改了 `docs/` → "build: update site"
- 修改了 `lib/` → "feat/fix: ..."
- 修改了 `package.json` → "chore: bump version"

---

## Layer 5: 扩展技能层

主技能可以承载子技能（sub-skills），形成插件生态。

### 5.1 技能目录结构

```
skills/
└── my-sub-skill/
    ├── SKILL.md                 ← 技能描述（YAML frontmatter）
    ├── package.json             ← 独立依赖
    └── openclaw-plugin/
        ├── index.mjs            ← 子技能 register(api)
        └── openclaw.plugin.json
```

### 5.2 SKILL.md Frontmatter

```yaml
---
name: my-sub-skill
description: 这个技能做什么
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F50D"
    homepage: https://github.com/...
    requires:
      skills:
        - parent-skill
      bins:
        - node
---
```

这是技能的"身份证"——构建系统扫描它来生成注册表。

### 5.3 技能注册表（skills.json）

构建时自动生成，运行时供 Agent 查询和安装：

```json
{
  "version": 1,
  "generated": "2026-03-01T00:00:00.000Z",
  "parentSkill": { "id": "parent-skill", "version": "1.0.0" },
  "skills": [
    {
      "id": "my-sub-skill",
      "name": "My Sub Skill",
      "description": "...",
      "version": "1.0.0",
      "downloadUrl": "https://example.com/skills/my-sub-skill/my-sub-skill-skill.zip",
      "tools": ["tool_a", "tool_b"]
    }
  ]
}
```

### 5.4 发现与安装闭环

```
Agent 调用 discover_skills Tool
       │
       ▼
  fetch skills.json  →  列出所有可用技能
       │
       ▼
Agent 调用 install_skill Tool
       │
       ├── 下载 skill zip
       ├── 解压到 skills/ 目录
       ├── npm install（如有依赖）
       └── 更新宿主框架配置
       │
       ▼
  重启后新技能的 Tools 生效
```

Agent 无需人工干预，即可自行发现、评估、安装所需技能。

---

## 跨平台安装

### install.sh / install.ps1

安装脚本实现 **一命令安装**，内部流程：

1. 检测环境（Node.js 版本、操作系统）
2. 确定安装目录（环境变量可覆盖）
3. 从多个源下载技能包（主站 CDN → GitHub Raw → GitHub Release，自动降级）
4. 解压 → `npm install` → 注册到宿主框架配置
5. 打印验证命令

```bash
# Linux / macOS
curl -fsSL https://example.com/install.sh | bash

# Windows
irm https://example.com/install.ps1 | iex
```

---

## 测试策略

使用 Node.js 内置 `node:test`，零外部依赖：

```
test/
├── process.test.mjs     ← 核心管道测试（mock HTTP/WebSocket）
├── config.test.mjs      ← 配置加载测试
├── utils.test.mjs       ← 工具函数测试
└── client.test.mjs      ← 客户端 SDK 测试
```

测试重点：
- 核心层的纯逻辑（不涉及 Agent 框架）
- 使用 mock 对象替代外部依赖（网络、文件系统）
- 在 `package.json` 中配置 `"test": "node --test test/*.test.mjs"`

---

## 文档与发布

### 文档结构

| 文件 | 用途 |
|------|------|
| `README.md` | 项目介绍、快速开始 |
| `SKILL.md` | 技能元数据 + Agent/ClawHub 展示页面 |
| `CHANGELOG.md` | 版本变更记录 |
| `RELEASE_NOTES.md` | 当前版本发布说明 |
| `SECURITY.md` | 安全策略 |
| `docs/` | 构建产物 + GitHub Pages 静态站 |

### 发布流程

```
bump 1.5.0          →  同步所有版本号
                    →  更新 CHANGELOG
build               →  构建 site + skill zips + registry
commit              →  自动生成 commit message
push                →  推送到 remote
release             →  创建 GitHub Release + 上传 assets
                    →  GitHub Pages 自动部署
```

或者用 `sync` 一键完成 build → commit → push。

---

## 架构决策记录

### 为什么零外部依赖（或极少依赖）？

- 技能包需要被用户下载安装，体积和依赖复杂度直接影响安装成功率
- `node:test`、`node:fs`、`node:http` 等内置模块已覆盖大部分需求
- 唯一的外部依赖应该是不可替代的（如 `ws` 提供 WebSocket Server，`archiver` 提供 ZIP 打包）

### 为什么不用 monorepo 工具（Lerna/Nx/Turborepo）？

- 项目规模不需要——各组件通过相对路径引用，结构清晰
- 构建逻辑集中在一个 `builder.js` 里，已经足够管理多目标输出
- 避免给贡献者增加工具链学习成本

### 为什么 Plugin 层和 CLI 层分离？

- Plugin 层绑定 Agent 框架的 API（`api.registerTool` 等），CLI 层不依赖它
- 用户可以只用 CLI 不装 Agent 框架，也可以只用 Agent 不碰命令行
- 但两者调用相同的核心模块，保证行为一致

### 为什么技能注册表是静态 JSON 而非 API？

- 可托管在任何静态站（GitHub Pages、CDN），无需服务器
- Agent 可直接 fetch 解析，无需认证
- 构建时生成，不存在运行时一致性问题

---

## 总结：五层架构速查

| 层 | 目录 | 面向对象 | 核心职责 |
|----|------|---------|---------|
| **Agent 接口** | `openclaw-plugin/` | AI Agent | 注册 Tools / Services / CLI |
| **业务核心** | `lib/` / `server/` / `clients/` | 所有消费者 | 可独立运行的业务逻辑 |
| **人类 CLI** | `bin/` | 人类用户 | 命令行交互入口 |
| **开发工具链** | `cli/` | 开发者 | build / bump / commit / sync / release |
| **扩展技能** | `skills/` | Agent + 用户 | 可插拔的子技能生态 |

一句话：**核心逻辑写一次，Agent 和人类各取所需，构建发布全自动化，生态通过技能注册表自生长。**

# 多知识库注册机制与 Cron 定时自动处理

> 为 js-knowledge-prism 的 OpenClaw 插件添加多知识库注册表 + 定时批量处理能力，参考 js-knowledge-collector 的 link-collector 模式。

## 问题背景

js-knowledge-prism 作为 OpenClaw 插件安装后，所有处理都是按需触发（手动 CLI 或 AI 工具调用），没有定时调度能力。而且插件配置只支持单一 `baseDir`，无法同时管理多个知识库。

期望：用户注册多个知识库后，cron 定时自动检查并处理所有库的新 journal。

## 参考模型：js-knowledge-collector 的 link-collector

collector 的模式是三层协作：

1. **CLI 命令 `setup-collector`** — 调用 OpenClaw 的 `cron add` 注册定时任务
2. **Cron 任务** — 按表达式触发，启动 isolated 隔离会话，传入固定 message
3. **Skill 文档 `link-collector/SKILL.md`** — 定义 Agent 在隔离会话中应执行的完整流程

collector 使用 inbox.jsonl / batch / archive 轮转机制实现读写隔离。

## 关键差异：不需要轮转机制

与 collector 不同，prism 的 `runPipeline` 本身是幂等增量的——通过对比 journal 目录和 atoms 目录来发现未处理文件，天然支持重复执行。不需要设计 inbox/batch 轮转。

## 设计方案

### 注册表 registry.json

存储路径：`<workspace>/.openclaw/prism-processor/registry.json`，与 collector 的 `link-collector/` 同级。

```json
{
  "bases": [
    {
      "baseDir": "d:/github/fork/openclaw/docs/prism",
      "name": "OpenClaw 个人实践知识库",
      "registeredAt": "2026-03-07T10:00:00+08:00",
      "enabled": true,
      "lastProcessedAt": null,
      "lastSummary": null
    }
  ]
}
```

写入采用 tmp + rename 原子操作。每个条目有 `enabled` 字段支持临时禁用。`lastProcessedAt` 和 `lastSummary` 由 cron 处理后回写。

### process_all 用单一工具而非逐库调用

cron 隔离会话中每次工具调用都是一次 LLM round-trip。5 个知识库逐库调用需要 11+ 次，`process_all` 只需 1 次。对定时任务来说 token 效率是核心考量。

### Workspace 路径解析

`getRegistryDir()` 需要正确解析 OpenClaw workspace 路径。实际发现 `api.config.agents.defaults.workspace` 不存在（该字段在配置中未设），workspace 在 `api.config.agents.list[0].workspace` 里。解析优先级：

```
agents.defaults.workspace → agents.list[0].workspace → process.cwd()
```

三种场景（CLI / Gateway AI 工具 / Cron 隔离会话）都通过第二优先级命中 `D:/.openclaw/workspace`，路径一致。

## 实现内容

### 新增文件

- `openclaw-plugin/skills/prism-processor/SKILL.md` — 技能定义，覆盖触发条件、注册管理、定时处理流程、容错、并发安全

### 修改文件

**openclaw-plugin/index.mjs**（核心改动约 300 行）：

- Registry 辅助函数：`loadRegistry`、`saveRegistry`、`normalizeBaseDir`、`findBaseIndex`、`readBaseName`
- 4 个 CLI 子命令：`register`、`unregister`、`registered`、`setup-cron`
- 4 个 AI 工具：`knowledge_prism_register`、`knowledge_prism_unregister`、`knowledge_prism_list_registered`、`knowledge_prism_process_all`

**openclaw-plugin/openclaw.plugin.json**：

- 添加 `"skills": ["./skills"]` 让 OpenClaw 扫描技能目录
- configSchema 增加 `cron.defaultInterval` 和 `cron.timezone`

**SKILL.md（根目录）**：

- AI Tools 表格从 5 个增加到 9 个
- CLI Commands 增加 4 个新命令
- Skill Bundle Structure 增加 `skills/prism-processor/` 目录

### 核心 lib/ 零改动

registry 是 OpenClaw 插件层面的概念，lib/ 始终面向单个 baseDir 工作，职责分离清晰。

## 处理流程

```
Cron 每 60 分钟触发
  → 隔离会话启动，Agent 加载 prism-processor skill
  → 调用 knowledge_prism_process_all（单次工具调用）
  → 工具内部：读取 registry → 遍历 enabled 库
    → getStatus() 检查待处理
    → 有新内容 → runPipeline()（atoms → groups → synthesis + agent-index）
    → 无新内容 → 跳过
    → 单库失败不中断
  → 回写 lastProcessedAt / lastSummary 到 registry
  → 返回汇总摘要
```

## 部署验证

由于插件通过路径链接安装（`plugins.load.paths` 指向源码目录），代码改动直接生效。部署步骤：

1. 重启 OpenClaw gateway（`gateway stop` + `gateway start`）加载新代码
2. `openclaw prism register <dir>` 注册知识库
3. `openclaw prism setup-cron --every 60` 配置定时任务

验证 cron 列表确认两个任务并行运行：

- `link-collector-process` — 每 30 分钟，处理链接队列
- `prism-auto-process` — 每 60 分钟，处理知识库 pipeline

## 经验总结

1. **优先复用已有的增量机制**：prism 的 pipeline 天然幂等增量，不需要像 collector 那样设计额外的轮转机制
2. **单一工具封装批量操作**：在 cron 场景下，减少 LLM round-trip 比代码优雅更重要
3. **workspace 路径不能硬编码**：OpenClaw 的配置结构中 workspace 可能在 `defaults` 或 `list[N]` 下，需要多级 fallback
4. **路径链接部署方式对开发友好**：源码改了就生效，只需重启 gateway

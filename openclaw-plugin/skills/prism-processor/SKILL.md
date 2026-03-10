---
name: prism-processor
description: 定时自动处理所有已注册知识库的增量 pipeline（atoms → groups → synthesis）及自动产出生成（structure → output），配合 cron 批量执行。
version: 1.1.0
author: js-knowledge-prism
---

# 知识棱镜自动处理器

管理知识库注册表，配合 cron 定时批量处理所有已注册知识库的 journal → atoms → groups → synthesis pipeline，并根据 output binding 配置自动从 structure 生成产出文件。

## 触发条件

| 场景 | 行为 |
|------|------|
| 用户消息中包含「注册知识库」意图 | 执行 **注册流程** |
| 用户要求查看/禁用/启用/移除已注册库 | 执行 **注册管理** |
| 用户说"处理所有知识库"/"跑一下全部"等 | 调用 `knowledge_prism_process_all` |
| 用户要求绑定/查看/管理产出配置 | 执行 **产出绑定管理** |
| 用户说"生成所有产出"/"跑一下 output"等 | 调用 `knowledge_prism_output_all` |
| cron `prism-auto-process` 隔离会话触发 | 执行 **定时处理流程** |
| cron `prism-auto-output` 隔离会话触发 | 执行 **定时产出流程** |

## 文件布局

运行时数据存放在 workspace 的 `.openclaw/prism-processor/` 目录下：

```
<workspace>/
└── .openclaw/
    └── prism-processor/
        └── registry.json      # 知识库注册表
```

首次注册知识库时目录和文件会自动创建。

## Cron 定时任务

本技能依赖两个 cron 定时任务：

### 处理 cron（journal → synthesis）

```bash
openclaw prism setup-cron
```

可选参数：`--every <分钟>` 设置执行间隔（默认 60），`--tz <时区>` 设置时区（默认 Asia/Shanghai），`--remove` 移除定时任务。

### 产出 cron（structure → output）

```bash
openclaw prism setup-output-cron
```

可选参数：`--every <分钟>` 设置执行间隔（默认 120），`--tz <时区>` 设置时区（默认 Asia/Shanghai），`--remove` 移除定时任务。

如果用户注册了知识库但 cron 任务尚未配置，应主动提醒用户执行上述命令。如果用户绑定了产出配置但 output cron 尚未配置，也应提醒。

---

## 1. 注册流程（主会话）

当用户提供一个知识库目录路径时：

1. 调用 `knowledge_prism_register(baseDir=...)` 注册。
2. 工具会自动验证 `.knowledgeprism.json` 存在并读取知识库名称。
3. 注册成功后，检查 cron 任务是否已配置。若未配置，提醒用户执行 `openclaw prism setup-cron`。

---

## 2. 注册管理（主会话）

| 用户意图 | 工具调用 |
|----------|---------|
| 查看已注册列表 | `knowledge_prism_list_registered` |
| 暂停某个库的自动处理 | `knowledge_prism_register(baseDir, enabled=false)` |
| 恢复某个库的自动处理 | `knowledge_prism_register(baseDir, enabled=true)` |
| 完全移除某个库 | `knowledge_prism_unregister(baseDir)` |

---

## 3. 定时处理流程（cron 隔离会话）

由 cron 任务 `prism-auto-process` 触发（默认每 60 分钟），在隔离会话中执行。`maxConcurrentRuns: 1` 保证同时只有一个实例运行。

**仅需一步**：调用 `knowledge_prism_process_all`。

该工具内部完成全部处理逻辑：

1. **读取注册表**：加载 `.openclaw/prism-processor/registry.json`，筛选 `enabled=true` 的知识库。
2. **逐库处理**：对每个启用的知识库串行执行：
   - 调用 `getStatus()` 检查是否有待处理 journal 或未归组 atom。
   - 若无新内容 → 标记"跳过"，继续下一个。
   - 若有新内容 → 执行 `runPipeline()`（atoms → groups → synthesis + Agent 索引更新）。
3. **单库失败不中断**：try/catch 包裹，继续处理下一个知识库。
4. **回写注册表**：更新每个库的 `lastProcessedAt` 和 `lastSummary`。
5. **返回汇总摘要**：报告每个库的处理结果。

---

## 4. 容错与边界处理

| 场景 | 处理方式 |
|------|---------|
| `registry.json` 不存在 | 视为空注册表，返回"未注册任何知识库" |
| `registry.json` 解析失败 | 同上 |
| 已注册的 `baseDir` 不存在 | 标记 error，继续下一个 |
| `.knowledgeprism.json` 丢失 | 标记 error，继续下一个 |
| 单库 pipeline 执行失败 | 记录错误信息，继续下一个 |
| LLM API 整体不可用 | 所有库都会失败，下次 cron 自动重试 |
| 注册表为空 / 无启用的库 | 直接退出，不做无效操作 |
| 无待处理内容 | 标记"跳过"，更新 lastProcessedAt |

---

## 5. 并发安全

- cron `maxConcurrentRuns: 1`，同一时刻只有一个自动处理实例运行（处理 cron 和产出 cron 各自独立计数）。
- 注册表修改使用 tmp + rename 原子写入，不会出现写入中途崩溃导致文件损坏。
- 主会话的注册操作（写 `registry.json`）与 cron 的处理操作（读 `registry.json` + 写知识库文件）不冲突：
  - 注册操作只修改 `registry.json`。
  - 处理操作先读 `registry.json`，然后写知识库内部文件（journal/atoms/groups 等），处理完后回写 `registry.json`。
  - 极端情况下主会话在 cron 处理期间修改了注册表，cron 结束时回写会覆盖 `lastProcessedAt`，但不会丢失注册条目（cron 只修改已有条目的时间戳字段，不增删条目）。
- 处理 cron 写 `pyramid/` 目录，产出 cron 读 `pyramid/structure/` 写 `outputs/` 目录，两者不冲突。

---

## 6. 产出绑定管理（主会话）

产出绑定定义了"哪个视角用哪个模板来自动生成 output"。每个知识库可以有多个绑定（多对多关系）。

| 用户意图 | 工具调用 |
|----------|---------|
| 绑定视角+模板的自动产出 | `knowledge_prism_bind_output(perspectiveDir, template)` |
| 暂停某个绑定 | `knowledge_prism_bind_output(perspectiveDir, template, enabled=false)` |
| 恢复某个绑定 | `knowledge_prism_bind_output(perspectiveDir, template, enabled=true)` |
| 查看所有绑定 | `knowledge_prism_list_output_bindings` |
| 查看某个库的绑定 | `knowledge_prism_list_output_bindings(baseDir)` |

绑定信息存储在 `registry.json` 的 `bases[].outputBindings` 数组中。

---

## 7. 定时产出流程（cron 隔离会话）

由 cron 任务 `prism-auto-output` 触发（默认每 120 分钟），在隔离会话中执行。`maxConcurrentRuns: 1` 保证同时只有一个实例运行。

**仅需一步**：调用 `knowledge_prism_output_all`。

该工具内部完成全部产出逻辑：

1. **读取注册表**：加载 `registry.json`，筛选 `enabled=true` 的知识库。
2. **逐库逐绑定处理**：对每个启用的绑定串行执行：
   - 检查 `pyramid/structure/<perspectiveDir>/` 目录下文件的最新修改时间。
   - 若修改时间 ≤ `lastOutputAt` → 标记"跳过"（structure 无变化）。
   - 若有变化或从未生成过 → 调用 `runOutput(mode="generate")` 生成 output。
3. **单绑定失败不中断**：try/catch 包裹，继续处理下一个绑定。
4. **回写注册表**：更新每个绑定的 `lastOutputAt` 和 `lastOutputSummary`。
5. **返回汇总摘要**：报告每个绑定的处理结果。

### 变化检测

通过递归扫描 `pyramid/structure/<perspectiveDir>/` 下所有文件的修改时间（mtime），取最大值与 `lastOutputAt` 比较。任意文件的 mtime 晚于上次产出时间即视为有变化。

### 安全保护

- `force` 默认 false：已存在的非骨架 output 文件不会被覆盖。
- 新的 output 文件正常写入，已有文件被跳过。

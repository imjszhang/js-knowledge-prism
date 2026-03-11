---
name: prism-processor
description: 定时自动处理所有已注册知识库的增量 pipeline（atoms → groups → synthesis）及自动产出生成（structure → output），配合 cron 批量执行。支持 inbox/batch 轮转、崩溃恢复和自动重试。
version: 1.2.0
author: js-knowledge-prism
---

# 知识棱镜自动处理器

管理知识库注册表，配合 cron 定时批量处理所有已注册知识库的 journal → atoms → groups → synthesis pipeline，并根据 output binding 配置自动从 structure 生成产出文件。

产出流程采用 inbox/batch 轮转机制实现变更驱动、崩溃恢复和失败自动重试。

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
        ├── registry.json              # 知识库注册表（含 outputBindings、failedKLs）
        ├── output-inbox.jsonl         # 变更信号队列（process_all 追加，output cron 消费）
        ├── output-batch-*.json        # 处理中批次（含逐 KL 进度，崩溃后自动恢复）
        └── output-archive/            # 已完成批次归档
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
3. **写变更信号**：pipeline 完成后若 synthesis 有更新或 groups 有新建/更新，向 `output-inbox.jsonl` 追加一条变更记录，包含 baseDir 和受影响的 perspectives 列表。
4. **单库失败不中断**：try/catch 包裹，继续处理下一个知识库。
5. **回写注册表**：更新每个库的 `lastProcessedAt` 和 `lastSummary`。
6. **返回汇总摘要**：报告每个库的处理结果。

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
| Output cron 中途崩溃 | batch 文件保留在磁盘，下次触发自动恢复 |
| 单个 KL 生成失败 | 记录到 `failedKLs`（retries+1），下次自动重试 |
| KL 连续失败 >= 3 次 | 标记 `permanently_failed`，不再自动重试 |
| `output-inbox.jsonl` 某行损坏 | 跳过该行，不影响其他条目 |

---

## 5. 并发安全

- cron `maxConcurrentRuns: 1`，同一时刻只有一个自动处理实例运行（处理 cron 和产出 cron 各自独立计数）。
- 注册表修改使用 tmp + rename 原子写入，不会出现写入中途崩溃导致文件损坏。
- 主会话的注册操作（写 `registry.json`）与 cron 的处理操作（读 `registry.json` + 写知识库文件）不冲突：
  - 注册操作只修改 `registry.json`。
  - 处理操作先读 `registry.json`，然后写知识库内部文件（journal/atoms/groups 等），处理完后回写 `registry.json`。
  - 极端情况下主会话在 cron 处理期间修改了注册表，cron 结束时回写会覆盖 `lastProcessedAt`，但不会丢失注册条目（cron 只修改已有条目的时间戳字段，不增删条目）。
- 处理 cron 写 `pyramid/` 目录，产出 cron 读 `pyramid/structure/` 写 `outputs/` 目录，两者不冲突。
- **inbox/batch 读写隔离**：
  - 处理 cron（`process_all`）只追加写 `output-inbox.jsonl`，不读写 batch 文件。
  - 产出 cron（`output_all`）原子 rename inbox 为 batch 后，只操作 batch 文件。新信号写入新创建的 inbox，与正在处理的 batch 互不干扰。
  - 主会话手动触发 `output_all` 走 mtime fallback 路径，不与 inbox/batch 冲突。

---

## 6. 产出绑定管理（主会话）

产出绑定定义了"哪个视角用哪个模板来自动生成 output"。每个知识库可以有多个绑定（多对多关系）。

| 用户意图 | 工具调用 |
|----------|---------|
| 绑定视角+模板的自动产出 | `knowledge_prism_bind_output(perspectiveDir, template)` |
| 绑定日记型视角（按日期追加 KL） | `knowledge_prism_bind_output(perspectiveDir, template, klStrategy="date-driven")` |
| 绑定但不自动刷新 structure | `knowledge_prism_bind_output(perspectiveDir, template, klStrategy="manual")` |
| 暂停某个绑定 | `knowledge_prism_bind_output(perspectiveDir, template, enabled=false)` |
| 恢复某个绑定 | `knowledge_prism_bind_output(perspectiveDir, template, enabled=true)` |
| 查看所有绑定 | `knowledge_prism_list_output_bindings` |
| 查看某个库的绑定 | `knowledge_prism_list_output_bindings(baseDir)` |

绑定信息存储在 `registry.json` 的 `bases[].outputBindings` 数组中。每个绑定包含：

- `klStrategy`（默认 `"synthesis"`）：structure 刷新策略
  - `synthesis`：全量重生成 SCQA + Key Lines + expand（适合论点型视角）
  - `date-driven`：仅追加新日期的 KL 并 expand（适合日记/日志型视角）
  - `manual`：不自动刷新 structure（适合手工策划型视角）
- `failedKLs`（数组）：失败的 KL 列表，含 `klId`、`retries`、`lastError`、`failedAt`、`status`

---

## 7. 定时产出流程（cron 隔离会话）

由 cron 任务 `prism-auto-output` 触发（默认每 120 分钟），在隔离会话中执行。`maxConcurrentRuns: 1` 保证同时只有一个实例运行。

**仅需一步**：调用 `knowledge_prism_output_all`。

### 工作源选择（优先级从高到低）

1. **崩溃恢复**：检查 `output-batch-*.json` 是否存在 → 有则从断点恢复处理。
2. **inbox 轮转**：检查 `output-inbox.jsonl` → 有内容则 rename 为 batch，创建空 inbox。
3. **失败重试**：检查 registry 中是否有 `failedKLs`（retries < 3）→ 有则构建重试 batch。
4. **mtime fallback**：以上均无工作时，遍历所有绑定的 structure 目录检测 mtime 变化（兼容手动触发场景）。

### Batch 文件格式

```json
{
  "createdAt": "2026-03-11T10:00:00Z",
  "source": "inbox",
  "items": [
    {
      "baseDir": "d:/github/fork/openclaw/docs/prism",
      "perspectiveDir": "P23-practice-diary",
      "template": "practice-diary",
      "kls": [
        {"klId": "KL19", "status": "pending", "retries": 0},
        {"klId": "KL18", "status": "done", "retries": 0, "processedAt": "..."}
      ],
      "structureRefreshed": false
    }
  ]
}
```

### Phase 1: Structure 自动刷新

对 batch 中每个 item（尚未刷新且 `klStrategy !== "manual"` 的）：

1. 比较 synthesis/groups 的 mtime 与 `lastStructureRefreshAt`。
2. 若有变化 → 根据 `klStrategy` 分派刷新策略：
   - `synthesis`：依次执行 SCQA → Key Lines → expand 全部 KL。
   - `date-driven`：扫描 journal 新日期 → 追加 KL 行 → expand 仅新 KL。
3. 更新 `lastStructureRefreshAt`，标记 `item.structureRefreshed = true`。
4. **checkpoint**：每完成 structure 刷新立即保存 batch 文件。

### Phase 2: Output 生成（逐 KL 断点续传）

对 batch 中每个 item：

1. 若 `kls` 为空，从 `tree/README.md` 读取 Key Line 列表填充。
2. 筛选 `status === "pending"` 的 KL，调用 `runOutput(klFilter=...)` 生成。
3. **逐 KL checkpoint**：每个 KL 完成后更新 batch 中该 KL 的 status：
   - 成功 → `done`，同时从 `failedKLs` 中清除。
   - 失败且 retries < 3 → `retry`，写入 `failedKLs`（retries+1）。
   - 失败且 retries >= 3 → `permanently_failed`，不再自动重试。
4. 全部完成后归档 batch 到 `output-archive/`，更新 registry。

### 重试机制

| 状态 | 说明 |
|------|------|
| `pending` | 等待下次 cron 自动重试 |
| `permanently_failed` | 已达最大重试次数（3 次），需用户手动 `--force` 或 `--kl KLxx` 重置 |

KL 生成成功时自动从 `failedKLs` 中清除。output cron 启动时若 inbox 为空但存在可重试的 `failedKLs`，会自动构建重试 batch。

### 安全保护

- `force` 默认 false：已存在的非骨架 output 文件不会被覆盖。
- `klStrategy` 默认 `"synthesis"`，设为 `"manual"` 可跳过自动刷新（适用于手动维护 structure 的场景），设为 `"date-driven"` 可对日记型视角仅追加新日期 KL。
- synthesis.md 不存在时跳过 structure 刷新，仍尝试 output 生成（structure 可能有旧内容）。
- Batch 文件使用 tmp + rename 原子写入，中途崩溃不会损坏进度数据。

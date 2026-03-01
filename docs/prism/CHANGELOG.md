# 架构变更日志

记录知识库**架构**（目录结构、方法论、工作流程）的变更。日常内容写入不记录在此。

版本规则见 [README — 版本管理](README.md#版本管理)。

## V1.0.0 — {{date}}

初始架构，由 js-knowledge-prism 工具生成。

### 架构

- 三层目录结构：`journal/`（原始素材）→ `pyramid/`（结构化拆解）→ `outputs/`（面向读者的产出）
- journal 按日期组织（`YYYY-MM-DD/`），每日可含多篇笔记
- outputs 与 pyramid 视角一一对应，视角的 tree 结构决定产出的章节组织

### 方法论

- 金字塔拆解分两阶段：自下而上（analysis：atoms → groups → synthesis）、自上而下（structure：SCQA → tree → validation）
- analysis 阶段所有视角共享，structure 阶段按视角独立
- atoms 按月分子目录（`YYYY-MM/`），支持增量拆解

### 工作流

- 增量拆解流程：新 journal → 提取 atoms → 审视 groups → 检查 synthesis → 检查各视角 → 追加修订记录
- 新建视角流程：通过 `_template/` 模板创建
- 新建产出流程：确认视角完成 → 创建产出目录 → 按 tree 结构组织内容

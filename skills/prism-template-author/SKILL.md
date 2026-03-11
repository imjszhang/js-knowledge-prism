---
name: prism-template-author
description: >-
  Guide users through creating new output templates for JS Knowledge Prism.
  Use when the user wants to create, design, or scaffold an output template,
  or asks about template structure, prompt variables, split strategies,
  or output types.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F3A8"
    homepage: https://github.com/user/js-knowledge-prism
    requires:
      skills:
        - js-knowledge-prism
      bins:
        - node
---

# Prism Template Author

创建知识棱镜产出模板的引导技能。帮助用户从零设计一个新的 output 模板（prompt + type + components）。

## 决策引导

在创建模板前，通过以下四个问题确定模板配置。使用 AskQuestion 工具收集答案。

### Q1: 产出形态（决定 split 策略）

```
每个 KL 独立成篇（日记、笔记）     → split: per-kl       推荐 type: diary
整个视角汇总成一篇（博客、报告）    → split: per-perspective 推荐 type: blog
每个 Group 独立成篇（专题系列）     → split: per-group     新建 type 或不指定
跨视角综合分析                     → source.type: cross-perspective
直接从 analysis 生成               → source.type: analysis
```

### Q2: 写作风格（决定 persona + style 组件）

```
叙事复盘（第一人称实战记录）  → {{@include persona/blogger.md}} + {{@include style/narrative.md}}
结构化教程（面向学习者）     → 需创建 persona/teacher.md + style/tutorial.md
学术/技术报告               → 需创建 persona/analyst.md + style/formal.md
自定义                      → 需创建新的 persona 和 style 组件
```

如果所需组件不存在，在 Step 2 中用 `prism_scaffold_component` 创建。

### Q3: 生成复杂度（决定是否用 pipeline）

```
一步生成（简单场景）          → 不声明 stages，只用 # System Prompt + # Unit Prompt
多阶段流水线（高质量长文）    → 声明 stages: [outline, draft, polish]
                              每个阶段对应 # Stage: <name> 区段
                              可设 pauseAfter 在指定阶段后暂停人工审查
```

### Q4: 是否需要质量审校

```
不需要   → 无 # Review Prompt 区段
需要     → 添加 # Review Prompt，预填 {{@include review/base.md}}
           运行时加 --review 标志触发
```

## 创建工作流

### Step 1: Scaffold — 生成模板骨架

根据决策结果，调用 `prism_scaffold_template` 工具：

```
prism_scaffold_template({
  name: "tutorial",
  split: "per-perspective",
  type: "blog",
  stages: ["outline", "draft", "polish"],
  review: true
})
```

工具会在 `templates/outputs/prompts/` 下生成带正确 frontmatter 和空区段占位的模板文件。

如果需要新组件，调用 `prism_scaffold_component`：

```
prism_scaffold_component({ name: "persona/teacher.md" })
prism_scaffold_component({ name: "style/tutorial.md" })
```

### Step 2: Fill — 填写 Prompt 内容

按以下顺序编写模板内容：

1. **先写组件**（如果有新建的）：
   - persona 组件：1-3 句话定义角色定位和写作态度
   - style 组件：5-8 条风格要求（人称、语气、节奏、详略等）

2. **再写 System Prompt**：
   - 引入组件：`{{@include persona/xxx.md}}` `{{@include style/xxx.md}}` `{{@include constraints.md}}`
   - 定义输出格式（用 markdown 代码块展示期望的文件结构）
   - constraints.md 几乎总是需要引入

3. **再写 Unit Prompt**：
   - 使用变量占位符注入素材（变量取决于 split 策略，查阅 [schema-reference.md](schema-reference.md) 的变量表）
   - 结构：先给上下文信息（KL/perspective 元信息），再给素材（journal、groups 等），最后给写作指令
   - 关键：告诉 LLM 怎么使用素材，而非只是列出素材

4. **可选 Skeleton Template**：如果模板需要 `--skeleton` 预览功能

5. **可选 Review Prompt**：通常引入 `{{@include review/base.md}}` 后追加 `{{generated_content}}` 和 `{{source_summary}}`

6. **可选 Stage 区段**：每个 stage 的用户提示，可用 `{{prev_stage_output}}` 引用上阶段结果

### Step 3: Verify — 验证模板

检查清单：

- [ ] frontmatter 的 name 与文件名一致
- [ ] split 策略对应的变量都在 Unit Prompt 中出现（参照变量表）
- [ ] 所有 `{{@include path}}` 引用的组件文件存在
- [ ] 如果声明了 type，对应的 type 定义文件存在
- [ ] 输出格式中的链接使用了 `{{rel_to_base}}` 等精确路径变量
- [ ] 如果有 stages，每个 stage name 都有对应的 `# Stage: <name>` 区段

验证方法：dry-run 测试模板能否加载

```bash
npx js-knowledge-prism output --perspective <any> --template <name> --dry-run
```

## 参考资料

- 完整的 frontmatter 字段、变量表、区段规范 → [schema-reference.md](schema-reference.md)
- 现有模板范例 → `templates/outputs/prompts/practice-diary.md`
- 产出引擎架构 → `templates/outputs/README.md`

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `prism_scaffold_template` | 生成模板骨架文件（frontmatter + 区段占位） |
| `prism_scaffold_component` | 生成组件占位文件 |

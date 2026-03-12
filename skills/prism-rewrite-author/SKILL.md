---
name: prism-rewrite-author
description: >-
  Guide users through creating new rewrite definitions for JS Knowledge Prism.
  Use when the user wants to create, design, or scaffold a rewrite definition,
  or asks about rewrite structure, style transformation, or platform-specific
  content adaptation.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F504"
    homepage: https://github.com/user/js-knowledge-prism
    requires:
      skills:
        - js-knowledge-prism
      bins:
        - node
---

# Prism Rewrite Author

创建知识棱镜改写定义的引导技能。帮助用户从零设计一个新的 rewrite 定义，或从已有提示词文件导入。

## 决策引导

在创建改写定义前，通过以下四个问题确定配置。使用 AskQuestion 工具收集答案。

### Q1: 目标平台

```
微信公众号     → platform: wechat    （段落节奏、CTA 三连、图片占位）
知乎专栏       → platform: zhihu     （回答体、引用规范、专业但有温度）
Twitter/X 线程 → platform: twitter    （280 字拆线程、hook 开头、编号）
通用/自定义    → platform: generic    （无平台特定约束）
```

### Q2: 语气风格

```
口语化/毒舌      → 预填：强情绪、自嘲、第二人称对话、禁止书面腔
专业但有温度      → 预填：正式但保留个人叙事、适度使用类比
学术/严肃         → 预填：去口语、去情绪、保留论证结构
自定义            → 需用户手写风格规则
```

### Q3: 结构改造程度

```
保留原结构        → preserveStructure: true   （只改语言风格，不动章节）
适配平台          → preserveStructure: false   （可重新组织段落和叙事顺序）
```

### Q4: 是否需要改写审校

```
不需要   → 无 # Review Prompt 区段
需要     → 添加 # Review Prompt，预填"检查核心信息保留度"
```

## 创建工作流

### Step 1: Scaffold — 生成改写定义骨架

根据决策结果，调用 `prism_scaffold_rewrite` 工具：

```
prism_scaffold_rewrite({
  name: "kzk-wechat",
  description: "微信公众号卡兹克风格改写",
  platform: "wechat",
  preserveStructure: false,
  preserveLinks: true,
  review: true
})
```

工具默认将定义写入知识库的 `outputs/_templates/rewrites/` 目录。
仅项目维护者在维护内置定义时需传 `target: "builtin"`。

或者，如果用户已有现成的提示词文件，使用 `prism_import_rewrite` 导入：

```
prism_import_rewrite({
  sourcePath: "/path/to/existing-prompt.md",
  name: "kzk-wechat",
  platform: "wechat"
})
```

### Step 2: Fill — 填写 Rewrite Prompt 内容

编写改写提示词，应包含：

1. **角色定义**：改写助手的身份
2. **风格规则**：节奏、语气、措辞的详细要求
3. **叙事结构**：开头、正文、结尾的组织方式
4. **格式要求**：排版、标记、列表等格式规范
5. **禁止项**：不允许出现的表述模式
6. **改写指令**：末尾引用 `{{article_content}}` 和 `{{source_context}}`

可使用 `{{@include}}` 引入组件（如已有的 style 组件）。

### Step 3: Verify — 验证改写定义

检查清单：

- [ ] frontmatter 的 name 与文件名一致
- [ ] `# Rewrite Prompt` 区段存在且包含 `{{article_content}}`
- [ ] 如果有 `# Review Prompt`，包含 `{{rewritten_content}}` 和 `{{article_content}}`
- [ ] 所有 `{{@include path}}` 引用的组件文件存在

验证方法：dry-run 测试

```bash
npx js-knowledge-prism rewrite --style <name> --file <any-md-file> --dry-run
```

## 参考资料

- 改写定义 Schema → `skills/prism-template-author/schema-reference.md`（末尾 Rewrite 章节）
- 内置改写定义范例 → `templates/outputs/rewrites/kzk-wechat.md`
- 产出引擎架构 → `templates/outputs/README.md`

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `prism_scaffold_rewrite` | 在知识库 `_templates/rewrites/` 下生成改写定义骨架文件 |
| `prism_import_rewrite` | 从已有提示词文件自动转换为标准改写定义格式 |

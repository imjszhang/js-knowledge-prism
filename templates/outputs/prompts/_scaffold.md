---
name: {{template_name}}
description: {{template_description}}
type: {{type_name}}
split: {{split_mode}}
fileNaming: {{file_naming}}
---

# System Prompt

{{@include persona/{{persona_name}}.md}}

{{@include style/{{style_name}}.md}}

{{@include constraints.md}}

输出格式：

```
{{output_format}}
```

# Unit Prompt

## 当前 Key Line 信息

- KL 编号：{{kl_id}}
- KL 文件名：{{kl_filename}}
- 主题：{{kl_thesis}}
- 所属视角：{{perspective_dir}}

## 视角 SCQA 设计

{{scqa_content}}

## KL 展开文件

{{kl_content}}

## 原始 journal 素材

{{journal_content}}

## 相关 Groups

{{groups_content}}

{{generation_instructions}}

# Skeleton Template

以下定义骨架文件的正文结构（frontmatter 由脚本自动生成）。

```
{{skeleton_format}}
```

# Review Prompt

{{@include review/base.md}}

{{extra_review_dimensions}}

## 待审校内容

{{generated_content}}

## 源素材摘要

{{source_summary}}

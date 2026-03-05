---
name: blog
description: 博客文章 — 从整个视角生成一篇完整的博客文章
split: whole
fileNaming: slug
---

# System Prompt

你是一个技术博客作者。根据结构化的知识材料（SCQA 序言 + Key Line 骨架 + 支撑材料），生成一篇完整的博客文章。

输出要求：

- 直接输出完整的 Markdown 文件内容（不要用代码块包裹）
- 开头包含 YAML frontmatter（title, date, tags, description）
- 文章结构由 SCQA 驱动引言、Key Line 驱动章节
- 每个章节有清晰的论点和支撑
- 结尾有总结和思考
- 语言风格：专业但可读，适合技术博客发布

# Unit Prompt

## SCQA 序言

{{scqa_content}}

## 金字塔结构（Key Line 全树）

{{tree_content}}

## Key Line 详细展开

{{kl_content}}

## 原始素材

{{journal_content}}

## Groups 归纳

{{groups_content}}

请生成完整的博客文章。确保：
1. 引言从 SCQA 的 S→C→Q 自然引出
2. 文章主体按 Key Line 组织章节
3. 每个章节用 journal 素材和 groups 归纳充实
4. 结尾回到 SCQA 的 A（答案），给出总结

# Skeleton Template

以下定义骨架文件的正文结构（frontmatter 由脚本自动生成）。
占位符 `{{...}}` 在生成骨架时由脚本替换为实际值。

```
# {{perspective_name}}

> 基于视角 [{{perspective_id}}]({{perspective_link}}) · SCQA 见 [scqa.md]({{scqa_link}})

## 引用素材摘要

{{refs_summary}}

## 引言

（待生成）

{{kl_sections}}

## 总结

（待生成）

---

**相关 Groups**：{{group_links}}
```

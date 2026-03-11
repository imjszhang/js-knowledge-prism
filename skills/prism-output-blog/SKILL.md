---
name: prism-output-blog
description: Transform Knowledge Prism perspectives into blog-ready articles using the modular output engine (components, types, review, pipeline).
version: 1.1.0
metadata:
  openclaw:
    emoji: "\U0001F4DD"
    homepage: https://github.com/user/js-knowledge-prism
    requires:
      skills:
        - js-knowledge-prism
      bins:
        - node
---

# Prism Output: Blog

Extension skill for JS Knowledge Prism that transforms pyramid perspectives into polished blog articles.

## What it does

Takes a completed perspective (SCQA + Key Lines) and generates a blog-ready markdown article with:

- YAML frontmatter (title, date, tags, description)
- Introduction derived from SCQA
- Body sections from Key Lines with supporting evidence from atoms/groups
- Conclusion and call-to-action

Uses the modular output engine architecture:

- **Prompt 组件化**: persona、style、constraints 等可复用组件通过 `{{@include}}` 引入
- **类型定义**: `blog` 类型声明读者画像、拆分粒度和质量标准
- **质量审校**: 可选 `--review` 对生成内容执行 LLM 审校
- **多阶段流水线**: 模板可声明 stages（outline → draft → polish），支持阶段中断和续跑

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `prism_blog_generate` | Generate a blog article from a perspective |
| `prism_blog_list_ready` | List perspectives that are ready for blog generation |

## Prerequisites

- JS Knowledge Prism main skill must be installed and configured (v1.6.0+)
- At least one perspective with filled SCQA and Key Lines

---
name: prism-output-blog
description: Transform Knowledge Prism perspectives into blog-ready articles with frontmatter, sections, and call-to-action.
version: 1.0.0
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

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `prism_blog_generate` | Generate a blog article from a perspective |
| `prism_blog_list_ready` | List perspectives that are ready for blog generation |

## Prerequisites

- JS Knowledge Prism main skill must be installed and configured
- At least one perspective with filled SCQA and Key Lines

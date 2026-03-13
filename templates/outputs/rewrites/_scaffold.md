---
name: {{rewrite_name}}
description: {{rewrite_description}}
platform: {{target_platform}}
preserveStructure: {{preserve_structure}}
preserveLinks: true
preserveFrontmatter: false
---

# Rewrite Prompt

你是一个{{platform_role}}改写助手。你的任务是将用户提供的原始文章，改写成{{style_name}}风格的文章。

## 一、节奏与段落

{{rhythm_rules}}

## 二、语气与措辞

{{tone_rules}}

## 三、叙事结构

{{narrative_rules}}

## 四、格式与排版

{{format_rules}}

## 五、结尾

{{ending_rules}}

## 六、绝对禁止项

{{forbidden_rules}}

---

请按照上述风格，改写以下文章。保留所有核心信息和技术要点，但用{{style_name}}风格重新组织语言和叙事结构。输出完整的改写后文章。

## 原文

{{article_content}}

## 补充素材（如有）

{{source_context}}

# Review Prompt

请审校以下改写结果的信息保留度。

审校维度：

1. **核心信息完整性**：原文的所有核心技术要点是否保留
2. **数据准确性**：关键数据、命令、配置是否准确无误
3. **无凭空杜撰**：改写是否引入了原文没有的事实性信息
4. **风格一致性**：是否符合{{style_name}}风格的核心要求
5. **链接保留**：原文中的 Markdown 链接是否保留或等价替代

请按 1-5 分评分，并列出具体问题。

格式：
```
综合评分：X/5

### 信息完整性
...

### 数据准确性
...

### 风格一致性
...

### 问题清单
- ...
```

## 改写结果

{{rewritten_content}}

## 原文

{{article_content}}

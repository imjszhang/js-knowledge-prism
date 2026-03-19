# 模板 Schema 参考

## Frontmatter 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 是 | — | 模板唯一标识（应与文件名一致） |
| `description` | string | 否 | — | 模板用途的简短描述 |
| `type` | string | 否 | — | 关联的类型名（如 `diary`、`blog`），继承类型的默认 split/fileNaming 等 |
| `split` | string | 否 | `per-kl` | 素材拆分粒度：`per-kl` / `per-perspective` / `per-group` |
| `fileNaming` | string | 否 | `sequence` | 输出文件命名：`date` / `slug` / `sequence` |
| `stages` | string[] | 否 | — | 多阶段流水线的阶段名（如 `[outline, draft, polish]`） |
| `pauseAfter` | string[] | 否 | — | 需暂停人工审查的阶段名（配合 stages 使用） |
| `source` | object | 否 | — | 素材来源配置：`{ type: "cross-perspective" }` 或 `{ type: "analysis", groups: [...] }` |

type 指定后，类型文件中的 `split`、`fileNaming` 作为默认值，模板级声明优先覆盖。

## 变量表

变量在 prompt 中以 `{{variable_name}}` 形式使用。未出现在当前上下文中的变量不会被替换。

### per-kl（每个 KL 一篇）

| 变量 | 说明 |
|------|------|
| `kl_id` | KL 编号（如 KL01） |
| `kl_thesis` | KL 主题摘要 |
| `kl_date` | KL 对应日期 |
| `kl_filename` | KL 骨架文件名 |
| `kl_content` | KL expand 后的完整内容 |
| `journal_content` | 对应日期的原始 journal 素材 |
| `groups_content` | 关联的 groups 内容 |
| `group_links` | groups 的 Markdown 链接列表 |
| `scqa_content` | 视角的 SCQA 内容 |
| `perspective_dir` | 视角目录名 |
| `perspective_id` | 视角 ID（如 P01） |
| `rel_to_base` | 输出目录到知识库根的相对路径 |
| `support_points` | KL 解析出的支撑论点（无骨架时可用） |

### per-perspective（整个视角一篇）

| 变量 | 说明 |
|------|------|
| `perspective_dir` | 视角目录名 |
| `perspective_id` | 视角 ID |
| `perspective_thesis` | 从 SCQA 的 Answer 部分提取的核心主张 |
| `perspective_name` | 去掉前缀的视角可读名 |
| `scqa_content` | 完整 SCQA 内容 |
| `all_kl_summaries` | 所有 KL 的摘要列表（拼接） |
| `all_groups_content` | 所有关联 groups 内容 |
| `groups_content` | 同 `all_groups_content` |
| `journal_content` | 所有相关 journal 素材 |
| `group_links` | groups 链接列表 |
| `rel_to_base` | 输出目录到知识库根的相对路径 |
| `kl_count` | KL 总数（字符串） |

### per-group（每个 Group 一篇）

| 变量 | 说明 |
|------|------|
| `group_id` | Group 编号 |
| `group_content` | 当前 group 的完整内容 |
| `related_kl_summaries` | 关联 KL 的摘要列表 |
| `scqa_content` | 视角的 SCQA 内容 |
| `perspective_dir` | 视角目录名 |
| `perspective_id` | 视角 ID |
| `rel_to_base` | 输出目录到知识库根的相对路径 |
| `group_links` | 当前 group 的 Markdown 链接 |

### cross-perspective（多视角交叉）

| 变量 | 说明 |
|------|------|
| `perspectives` | 视角名逗号分隔列表 |
| `perspective_count` | 视角数量（字符串） |
| `scqa_content` | 多个视角的 SCQA 拼接（`---` 分隔） |
| `all_kl_summaries` | 所有视角的 KL 摘要 |
| `journal_content` | 所有视角的 journal 素材 |
| `groups_content` | 所有 groups 内容 |
| `all_groups_content` | 同 `groups_content` |
| `group_links` | 所有 groups 链接 |
| `rel_to_base` | 输出目录到知识库根的相对路径 |
| `kl_count` | 所有视角的 KL 总数 |

### from-analysis — synthesis 模式

| 变量 | 说明 |
|------|------|
| `synthesis_content` | synthesis.md 的完整内容 |
| `rel_to_base` | 输出目录到知识库根的相对路径 |

### from-analysis — groups 模式

| 变量 | 说明 |
|------|------|
| `group_id` | Group 编号 |
| `group_content` | group 文件内容 |
| `group_links` | 当前 group 的 Markdown 链接 |
| `rel_to_base` | 输出目录到知识库根的相对路径 |

### 通用变量（所有 split 策略均可用）

| 变量 | 说明 |
|------|------|
| `convention_content` | 系列规约文档 `_convention.md` 的完整内容（无规约时为空字符串）。引擎在 outputDir 及其父目录自动查找。若模板未显式引用此变量，引擎自动将规约追加到 System Prompt 末尾 |

### Pipeline 专用变量

| 变量 | 说明 |
|------|------|
| `prev_stage_output` | 上一阶段的生成结果（首阶段为空字符串） |

Pipeline 的每个 stage 都能访问对应 MaterialSet 的所有变量（即上面 split 策略对应的变量）加上 `prev_stage_output`。

### Review 专用变量

| 变量 | 说明 |
|------|------|
| `generated_content` | 待审校的生成内容 |
| `source_summary` | 源素材的摘要文本 |

Review Prompt 同时也能访问 MaterialSet 的所有变量。

### Skeleton Template 专用变量

| 变量 | 说明 |
|------|------|
| `kl_id` | KL 编号 |
| `kl_date` | 日期 |
| `kl_thesis` | 主题 |
| `kl_index` | KL 序号（从 1 开始） |
| `kl_filename` | KL 文件名 |
| `kl_link` | KL 骨架的相对链接 |
| `perspective_id` | 视角 ID |
| `perspective_dir` | 视角目录名 |
| `perspective_name` | 视角可读名 |
| `perspective_link` | 视角目录链接 |
| `group_links` | groups 链接列表 |
| `refs_summary` | 引用素材路径摘要 |
| `rel_to_base` | 输出目录到知识库根的相对路径 |

## 区段规范

模板文件由 frontmatter + 若干 `#` 级区段组成。

### `# System Prompt`（必需）

LLM 的系统提示。定义角色、风格、约束和输出格式。

写作要点：
- 用 `{{@include}}` 引入 persona、style、constraints 组件
- 在最后用 markdown 代码块展示期望的输出文件结构
- `{{@include constraints.md}}` 几乎总是需要

### `# Unit Prompt`（必需）

每个产出单元的用户提示。包含变量占位符，引擎为每个单元填充实际值后发送给 LLM。

写作要点：
- 先给上下文信息（KL/视角元信息）
- 再给素材（journal、groups、kl_content 等）
- 最后给写作指令（怎么使用素材、重点写什么、忽略什么）
- 使用子标题（`##`）分隔各部分，方便 LLM 定位

### `# Skeleton Template`（可选）

骨架文件的正文模板。`--skeleton` 模式时使用。

写作要点：
- 使用 Skeleton 专用变量
- 提供 `（待生成）` 占位符标记需要 LLM 填充的位置

### `# Review Prompt`（可选）

质量审校提示。`--review` 模式时使用。

写作要点：
- 通常以 `{{@include review/base.md}}` 开头
- 追加 `{{generated_content}}` 和 `{{source_summary}}`
- 可添加模板特定的审校维度

### `# Stage: <name>`（可选，可多个）

多阶段流水线中各阶段的用户提示。需在 frontmatter 中声明 `stages` 数组。

写作要点：
- 阶段名必须与 `stages` 数组中的元素一致
- 使用 `{{prev_stage_output}}` 引用上阶段结果
- 首阶段通常是"生成大纲"，末阶段是"润色定稿"

## 内置基础组件

工具仅保留通用基础设施组件，具体的 persona/style 组件由 `prism-template-author` 技能引导创建，存放在知识库 `outputs/_templates/components/` 下。

| 路径 | 用途 |
|------|------|
| `constraints.md` | 全局硬性约束（不编造、精确链接、直接输出 Markdown） |
| `review/base.md` | 通用审校标准（素材忠实度、覆盖度、链接、风格、结构五维评分） |
| `persona/_scaffold.md` | 人设组件脚手架 |
| `style/_scaffold.md` | 风格组件脚手架 |

## 类型与模板

工具不内置任何类型定义或模板文件。使用 `prism-template-author` 技能创建，存放在知识库 `outputs/_templates/` 下。

脚手架文件：
- `types/_scaffold.md` — 类型定义脚手架
- `prompts/_scaffold.md` — 模板文件脚手架

---

## 改写定义（Rewrite）Schema

改写定义是独立于模板的风格变换资源，对已生成产出进行后处理。

### Rewrite Frontmatter 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 是 | — | 改写定义唯一标识（应与文件名一致） |
| `description` | string | 否 | — | 用途简述 |
| `platform` | string | 否 | `generic` | 目标平台：`wechat` / `zhihu` / `twitter` / `generic` |
| `preserveStructure` | boolean | 否 | `false` | 是否保留原文章节结构 |
| `preserveLinks` | boolean | 否 | `true` | 是否保留 Markdown 链接 |
| `preserveFrontmatter` | boolean | 否 | `false` | 是否保留原文 frontmatter |

### Rewrite 变量表

| 变量 | 说明 |
|------|------|
| `article_content` | 原文正文（去除 frontmatter 后的 Markdown 内容） |
| `source_context` | 从原文 frontmatter refs 自动加载的补充素材（journal/groups），截取前 3000 字符。无 refs 时为"（无补充素材）" |

### Rewrite Review 变量表

| 变量 | 说明 |
|------|------|
| `rewritten_content` | 改写后的内容 |
| `article_content` | 改写前的原文正文 |

### Rewrite 区段规范

#### `# Rewrite Prompt`（必需）

改写提示词。定义风格规则、格式要求、禁止项，并在末尾使用 `{{article_content}}` 和 `{{source_context}}` 注入原文和素材。

可使用 `{{@include}}` 引入组件（如自定义的 style 组件）。

#### `# Review Prompt`（可选）

改写后的信息保留度审校。使用 `{{rewritten_content}}` 和 `{{article_content}}`。运行时加 `--review` 触发。

### 改写定义

工具不内置任何改写定义。使用 `prism-rewrite-author` 技能创建，存放在知识库 `outputs/_templates/rewrites/` 下。

脚手架文件：`rewrites/_scaffold.md`。

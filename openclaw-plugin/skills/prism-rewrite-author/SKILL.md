---
name: prism-rewrite-author
description: 引导用户创建新的 rewrite 改写定义——从风格采集、规则提炼到脚手架填充，生成可直接使用的 rewrite 模板文件。
version: 1.0.0
author: js-knowledge-prism
---

# Rewrite 模板创作引导

引导用户从零创建一个 rewrite 改写定义。Rewrite 模板定义了一种改写风格，用于将已有的 output 文章改写成特定平台/语气的版本。

## 触发条件

| 场景 | 行为 |
|------|------|
| 用户说"创建一个新的改写风格"/"新建 rewrite 模板" | 执行 **完整创建流程** |
| 用户说"我想要 XX 风格的改写" | 执行 **完整创建流程**，以用户描述为起点 |
| 用户提供了一篇参考文章说"学这个风格" | 执行 **风格提炼流程** |
| 用户说"修改/调整现有 rewrite 模板" | 执行 **迭代优化流程** |

## Rewrite 模板结构

每个 rewrite 模板是一个 Markdown 文件，存放在知识库的 `outputs/_templates/rewrites/` 目录下。

### 文件结构

```markdown
---
name: 模板名称（英文短横线命名，如 kzk-wechat）
description: 一句话描述这个改写风格
platform: 目标平台（wechat / zhihu / blog / twitter / general）
preserveStructure: 是否保留原文章节结构（true/false）
preserveLinks: 是否保留原文链接（通常 true）
preserveFrontmatter: 是否保留原文 frontmatter（通常 false）
---

# Rewrite Prompt

（改写指令：角色设定 + 风格规则 + 禁止项 + 改写要求）

## 原文

{{article_content}}

## 补充素材（如有）

{{source_context}}

# Review Prompt

（审校指令：信息完整性 + 数据准确性 + 风格一致性检查）

## 改写结果

{{rewritten_content}}

## 原文

{{article_content}}
```

### 系统变量

| 变量 | 注入内容 |
|------|---------|
| `{{article_content}}` | 待改写的原文全文 |
| `{{source_context}}` | 补充素材（原始 journal、groups 等，可选） |
| `{{rewritten_content}}` | 改写后的结果（Review Prompt 中使用） |

### Frontmatter 配置项

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 模板唯一标识，用于 CLI `--style <name>` |
| `description` | string | 人类可读描述 |
| `platform` | string | 目标发布平台 |
| `preserveStructure` | boolean | `true` = 保留原文章节划分；`false` = 允许重组叙事结构 |
| `preserveLinks` | boolean | `true` = 保留 Markdown 链接 |
| `preserveFrontmatter` | boolean | `true` = 保留原文 YAML frontmatter |

---

## 完整创建流程

### Step 1: 采集风格需求

向用户收集以下信息（缺什么问什么，已知的跳过）：

| 信息 | 问法 | 默认值 |
|------|------|--------|
| 目标平台 | "改写后发到哪个平台？" | `wechat` |
| 风格参考 | "有没有你喜欢的参考文章或作者？" | 无 |
| 语气基调 | "想要什么语气？（口语化/正式/幽默/毒舌/冷静...）" | 口语化 |
| 读者画像 | "读者是谁？（技术人员/普通人/特定社群...）" | 通用读者 |
| 段落密度 | "喜欢短段落（一句一段）还是正常段落？" | 短段落 |
| 特殊要求 | "有没有特别想要或特别不想要的写法？" | 无 |

### Step 2: 风格提炼（如有参考文章）

如果用户提供了参考文章或作者名：

1. 分析参考文章的风格特征：
   - **节奏**：段落长度分布、句式变化
   - **语气**：用词偏好、情绪表达方式、人称使用
   - **结构**：开头套路、正文组织、结尾模式
   - **格式**：标点习惯、加粗/斜体使用、列表风格
   - **禁忌**：这种风格明确不会出现的表达
2. 将特征总结为具体的、可执行的规则
3. 向用户确认："我提炼出这些风格特征，你看看准不准？"

### Step 3: 生成 Rewrite Prompt

Rewrite Prompt 是模板的核心。好的 Rewrite Prompt 应该：

1. **具体而非模糊**：不说"写得生动一些"，说"每段不超过 3 行，用'你'直接跟读者对话"
2. **有示例**：关键规则附带正面示例和反面示例
3. **分维度组织**：节奏、语气、结构、格式、禁止项分开写
4. **禁止项明确**：具体列出这种风格绝对不能出现的表达模式

使用脚手架模板 `templates/outputs/rewrites/_scaffold.md` 作为骨架，填充各 section：

| Section | 填充内容 |
|---------|---------|
| 角色设定 | 基于平台和风格的一句话角色定义 |
| 节奏与段落 | 段落长度规则、句式节奏、呼吸感 |
| 语气与措辞 | 用词偏好、情绪表达、人称、口头禅 |
| 叙事结构 | 开头钩子、正文推进、转折手法 |
| 格式与排版 | 加粗、列表、图片占位、标点 |
| 结尾 | 收尾模式（金句/CTA/签名等） |
| 禁止项 | 明确列出绝对不能出现的表达 |

### Step 4: 生成 Review Prompt

Review Prompt 固定结构，基于以下维度：

1. 核心信息完整性
2. 数据准确性
3. 无凭空杜撰
4. 风格一致性（引用 Rewrite Prompt 的核心规则名）
5. 链接保留

### Step 5: 组装并保存

1. 填充 frontmatter
2. 组装完整文件
3. 确认知识库路径：通过 `knowledge_prism_status` 获取 baseDir
4. 保存到 `{baseDir}/outputs/_templates/rewrites/{name}.md`
5. 验证：`knowledge_prism_list_rewrites` 确认新模板可被发现

---

## 风格提炼流程

当用户提供参考文章而非口述需求时：

1. 读取参考文章全文
2. 按 Step 2 提炼风格特征
3. 向用户展示提炼结果并确认
4. 进入 Step 3 生成 Rewrite Prompt
5. 后续同完整流程

---

## 迭代优化流程

当用户要调整已有模板时：

1. 读取现有 rewrite 模板文件
2. 收集用户反馈："哪里不满意？改写出来的文章哪里不对？"
3. 定位问题到具体 section（节奏/语气/结构/格式/禁止项）
4. 修改对应规则
5. 建议用户用 `knowledge_prism_rewrite --style <name> --file <path>` 测试改写效果

---

## 质量检查清单

生成完毕后自检：

- [ ] `name` 是否为英文短横线命名，且不与已有模板重名
- [ ] Rewrite Prompt 的每条规则是否**具体可执行**（非模糊描述）
- [ ] 是否有至少 3 条**禁止项**（防止 AI 味）
- [ ] 关键规则是否附带**正反示例**
- [ ] `preserveStructure` 是否与风格匹配（破坏式改写 = false，润色式改写 = true）
- [ ] Review Prompt 的"风格一致性"维度是否引用了 Rewrite Prompt 的核心特征名
- [ ] 文件是否保存到了正确的知识库目录（不是工具项目目录）

---

## 参考资料

- Rewrite 定义 Schema（frontmatter 字段、变量表、区段规范）→ `openclaw-plugin/skills/prism-template-author/schema-reference.md`（末尾 Rewrite 章节）
- 脚手架文件 → `templates/outputs/rewrites/_scaffold.md`
- 产出引擎架构 → `templates/outputs/README.md`

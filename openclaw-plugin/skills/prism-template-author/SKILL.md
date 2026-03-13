---
name: prism-template-author
description: 引导用户创建完整的 output 模板体系——从人设组件、风格组件、类型定义到 Prompt 模板，生成可直接使用的产出配置。
version: 1.0.0
author: js-knowledge-prism
---

# Output 模板创作引导

引导用户从零创建 output 产出所需的全套模板文件。一套完整的产出配置包含四层：

```
persona（人设组件）→ style（风格组件）→ type（类型定义）→ prompt（模板文件）
```

模板通过 `{{@include}}` 引用组件，通过 frontmatter `type:` 引用类型。创建顺序建议自底向上：先组件，再类型，最后模板。

## 触发条件

| 场景 | 行为 |
|------|------|
| 用户说"创建一个新的 output 模板" | 执行 **完整创建流程**（四层全建） |
| 用户说"新建一个人设/风格组件" | 执行 **单组件创建** |
| 用户说"定义一个新的产出类型" | 执行 **类型定义流程** |
| 用户提供参考文章说"我想要这种风格的产出" | 从风格提炼开始，反推组件和模板 |

## 文件存放位置

所有产出模板文件存放在**知识库**目录下，不在工具项目中：

```
{baseDir}/outputs/_templates/
├── {template_name}.md          # 模板文件（完整 Prompt）
├── components/
│   ├── persona/{name}.md       # 人设组件
│   └── style/{name}.md         # 风格组件
├── types/{name}.md             # 类型定义
└── rewrites/{name}.md          # 改写定义（见 prism-rewrite-author）
```

通过 `knowledge_prism_status` 获取 baseDir。

---

## 第一层：人设组件（Persona）

人设定义"谁在写"，决定了文章的身份感和可信度。

### 采集信息

| 信息 | 问法 | 示例 |
|------|------|------|
| 身份 | "写这篇文章的人是什么身份？" | AI 爱好者、技术博主、产品经理、大学生 |
| 经验水平 | "有实际成果还是初学者？" | 有成果但不端着 / 初学探索者 |
| 与读者关系 | "跟读者是什么关系？" | 朋友分享、前辈指导、同行交流 |
| 定位 | "是教程、评测、故事分享、还是别的？" | 带真实体感的故事分享 |

### 输出格式

使用脚手架 `templates/outputs/components/persona/_scaffold.md`：

```markdown
{{persona_identity}}

写作定位：{{writing_positioning}}
```

- **`persona_identity`**：一句话身份定义，包含平台/工具名称和经验水平
- **`writing_positioning`**：定位声明 + 与读者关系 + "不是什么"的排除声明

### 质量检查

- [ ] 身份描述是否具体（不是泛泛的"一个写手"）
- [ ] 是否包含"不是什么"的排除（帮助 LLM 避免错误方向）
- [ ] 定位是否与目标平台匹配

---

## 第二层：风格组件（Style）

风格定义"怎么写"，是模板中对 LLM 输出控制力最强的部分。

### 采集信息

| 信息 | 问法 | 选项 |
|------|------|------|
| 人称 | "用第几人称？" | 第一人称 / 第三人称 / 混合 |
| 语气 | "什么语气？" | 口语化 / 正式 / 幽默 / 冷静客观 |
| 叙事方式 | "内容怎么组织？" | 按时间线 / 按论点 / 故事驱动 / 问答式 |
| 技术处理 | "遇到技术概念怎么办？" | 比喻替代 / 大白话解释 / 直接用术语 |
| 段落密度 | "段落长度偏好？" | 一句一段 / 3-5行短段 / 正常段落 |
| 特殊节奏 | "有没有特别的节奏要求？" | 重点展开次要带过 / 均匀分布 |

### 如有参考文章：风格提炼

1. 分析参考文章的具体特征：
   - 段落长度分布（统计平均行数）
   - 句式特征（短句为主？长短交替？）
   - 人称和口头禅
   - 情绪表达方式（克制/外露/自嘲）
   - 格式习惯（加粗/列表/图片使用频率）
2. 提炼为可执行的规则（每条规则必须具体到 LLM 能遵循）
3. 向用户确认

### 输出格式

使用脚手架 `templates/outputs/components/style/_scaffold.md`：

```markdown
风格要求：

- {{tone_rule}}
- {{narrative_rule}}
- {{detail_rule}}
- {{rhythm_rule}}
- {{readability_rule}}
- {{ending_rule}}
```

每条规则必须是**具体可执行的指令**，不是模糊描述。

| 差的规则 | 好的规则 |
|---------|---------|
| "写得生动一些" | "用故事和场景代替概念解释，让读者'看到'而不是'学到'" |
| "段落要短" | "段落短小，多用短句，适合手机竖屏阅读，每段不超过 4-5 行" |
| "语气轻松" | "第一人称，口语化，像在跟朋友聊天" |

---

## 第三层：类型定义（Type）

类型是结构契约，定义"产出长什么样"。模板通过 frontmatter `type:` 引用类型，继承其默认配置。

### 采集信息

| 信息 | 问法 | 选项 |
|------|------|------|
| 读者 | "读者是谁？" | 技术人员 / 普通人 / 特定社群 |
| 拆分粒度 | "一个视角生成几篇文章？" | `per-kl`（每 KL 一篇）/ `per-perspective`（整个视角一篇）/ `per-group` |
| 文件命名 | "文件怎么命名？" | `sequence`（01/02/03）/ `date`（日期）/ `slug`（标题缩写） |
| 所需变量 | 根据拆分粒度自动推断 | per-kl 需要 kl_* 变量；per-perspective 需要 all_kl_summaries |
| 结构蓝图 | "文章结构是什么样的？" | 用户描述或从参考文章推断 |
| 质量标准 | "什么算写得好？" | 用户描述或推荐通用标准 |

### 变量速查

| 拆分模式 | 必需变量 | 可选变量 |
|---------|---------|---------|
| `per-kl` | kl_id, kl_thesis, kl_content, journal_content, groups_content | scqa_content, kl_date, kl_filename |
| `per-perspective` | perspective_thesis, scqa_content, all_kl_summaries, all_groups_content | perspective_dir |
| `per-group` | group_id, group_content, related_atoms | synthesis_content |

### 输出格式

使用脚手架 `templates/outputs/types/_scaffold.md`：

```markdown
---
name: {{type_name}}
audience: {{target_audience}}
split: {{split_mode}}
fileNaming: {{file_naming}}
requiredVars: [{{required_vars}}]
optionalVars: [{{optional_vars}}]
---

# {{type_display_name}}

{{type_description}}

## 结构蓝图

{{structure_blueprint}}

## 质量标准

{{quality_criteria}}
```

---

## 第四层：模板文件（Prompt）

模板是最终的产物，组装人设 + 风格 + 约束 + 输出格式 + 生成指令。

### 模板的五个区段

| 区段 | 必需 | 填充内容 |
|------|------|---------|
| `# System Prompt` | 是 | `{{@include}}` 组件 + 输出格式定义 |
| `# Unit Prompt` | 是 | 变量注入 + 生成指令（写作要点） |
| `# Skeleton Template` | 否 | 骨架文件的正文结构 |
| `# Review Prompt` | 否 | 引用 base review + 额外审校维度 |
| `# Stage: <name>` | 否 | 多阶段流水线（高级用法） |

### System Prompt 组装

```markdown
# System Prompt

{{@include persona/{name}.md}}

{{@include style/{name}.md}}

{{@include constraints.md}}

输出格式：

（用代码块定义完整的文章骨架，包含标题格式、元信息、正文结构、结尾格式）
```

### Unit Prompt 设计

Unit Prompt 的核心是**生成指令**——告诉 LLM 怎么使用注入的素材。

设计原则：
1. **素材区段明确**：每个 `{{变量}}` 前加说明，告诉 LLM 这段素材的用途
2. **写作要点编号**：5-8 条具体的写作指令
3. **最重要的规则排第一条**：LLM 对列表开头和结尾的注意力更高
4. **不重复 System Prompt**：Unit Prompt 补充的是 per-unit 的具体指令

### Skeleton Template 设计

骨架是"待填充"的半成品文件，用于人工审查素材引用后再生成。

- 使用 `{{变量}}` 占位符，由脚本替换
- 包含 `（待生成）` 标记表示需要 LLM 填充的部分
- 结构应与 System Prompt 的输出格式一致

### Review Prompt 设计

```markdown
# Review Prompt

{{@include review/base.md}}

额外审校维度（本模板特有）：

6. **{{dimension_name}}**：{{dimension_description}}
7. ...
```

额外维度应针对模板的特殊需求，如：
- 公众号文章 → 通俗性、叙事弧线一致性
- 技术博客 → 代码准确性、术语一致性
- 日记 → 时间线连贯性、情感真实度

---

## 完整创建流程

### Step 1: 需求采集

按四层依次收集信息。如果用户提供了参考文章或现有模板作为起点，可以跳过已知项。

### Step 2: 创建组件

1. 创建 persona 组件 → 保存到 `{baseDir}/outputs/_templates/components/persona/{name}.md`
2. 创建 style 组件 → 保存到 `{baseDir}/outputs/_templates/components/style/{name}.md`
3. 向用户展示组件内容并确认

### Step 3: 创建类型（如需新类型）

如果现有类型已满足需求，跳过此步，在模板 frontmatter 中引用现有类型即可。

### Step 4: 创建模板

1. 组装 System Prompt（引用刚创建的组件）
2. 设计 Unit Prompt（变量注入 + 生成指令）
3. 设计 Skeleton Template（可选）
4. 设计 Review Prompt（引用 base + 额外维度）
5. 保存到 `{baseDir}/outputs/_templates/{name}.md`

### Step 5: 验证

1. `knowledge_prism_list_templates` 确认新模板可被发现
2. 建议用户试跑：`knowledge_prism_output --perspective <dir> --template <name> --dry-run`

---

## 迭代优化流程

当用户对已有模板不满意时：

1. 收集反馈："生成结果哪里不对？"
2. 定位问题层级：
   - 身份感不对 → 修改 persona
   - 语气/节奏不对 → 修改 style
   - 结构不对 → 修改 type 或模板的输出格式
   - 内容取舍不对 → 修改 Unit Prompt 的生成指令
   - 质量问题 → 修改 Review Prompt
3. 只修改对应层级的文件，不要牵一发动全身

---

## 质量检查清单

### 组件检查

- [ ] persona 是否包含具体身份 + 排除声明
- [ ] style 的每条规则是否具体可执行
- [ ] 组件文件是否保存到知识库的 `_templates/components/` 下

### 类型检查

- [ ] `requiredVars` 是否与 `split` 模式匹配
- [ ] 结构蓝图是否清晰定义了文章各部分
- [ ] 质量标准是否可衡量

### 模板检查

- [ ] System Prompt 是否正确 `{{@include}}` 了组件
- [ ] 输出格式是否完整定义了文章骨架
- [ ] Unit Prompt 的生成指令是否不超过 8 条
- [ ] 最重要的指令是否排在第一条
- [ ] Unit Prompt 是否没有重复 System Prompt 的内容
- [ ] Skeleton Template 的结构是否与输出格式一致
- [ ] Review Prompt 的额外维度是否针对模板特殊需求
- [ ] 模板文件是否保存到知识库的 `_templates/` 下（不是工具项目）

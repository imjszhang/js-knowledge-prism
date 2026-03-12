# 产出（Outputs）

基于 [pyramid/structure/](../pyramid/structure/) 视角生成的面向读者的内容。

## 架构概览

```mermaid
flowchart LR
    subgraph templates ["模板体系"]
        Components["components/\n可复用组件"]
        Types["types/\n类型定义"]
        Prompts["prompts/\n模板文件"]
        Rewrites["rewrites/\n改写定义"]
        Components -.->|"{{@include}}"| Prompts
        Components -.->|"{{@include}}"| Rewrites
        Types -.->|"type: xxx"| Prompts
    end

    subgraph sources ["素材来源"]
        Persp["pyramid/structure/\n视角"]
        Analysis["pyramid/analysis/\ngroups · synthesis"]
    end

    subgraph engine ["引擎"]
        Resolve["素材解析策略"]
        Generate["生成循环\n(lib/output.mjs)"]
        Review["质量审校"]
        Pipeline["多阶段流水线"]
        Rewrite["风格改写\n(lib/rewrite.mjs)"]
    end

    Prompts --> Generate
    Persp --> Resolve
    Analysis --> Resolve
    Resolve --> Generate
    Generate --> Review
    Pipeline --> Generate
    Generate --> Rewrite
    Rewrites --> Rewrite
```

## 目录结构

```
outputs/
  README.md           # 本文件
  INDEX.md.tpl        # 产出索引模板
  _templates/         # 知识库自定义模板（优先于内置）
    components/       #   自定义组件
    types/            #   自定义类型
    rewrites/         #   自定义改写定义
  components/         # 内置 Prompt 组件
    constraints.md    #   全局硬性约束
    persona/          #   人设组件
      blogger.md
    style/            #   风格组件
      narrative.md
    review/           #   审校组件
      base.md
  types/              # 内置类型定义
    diary.md          #   日记类型
    blog.md           #   博客类型
  prompts/            # 内置 Prompt 模板
    practice-diary.md #   实践日记模板
  rewrites/           # 内置改写定义
    kzk-wechat.md     #   微信公众号卡兹克风格
```

## 模板查找优先级

引擎加载模板、组件和类型时按以下顺序查找，找到即停：

| 资源 | 1. 知识库自定义（优先） | 2. 内置（回退） |
| ---- | ---- | ---- |
| 模板 | `outputs/_templates/*.md` | `outputs/prompts/` |
| 组件 | `outputs/_templates/components/` | `outputs/components/` |
| 类型 | `outputs/_templates/types/` | `outputs/types/` |
| 改写 | `outputs/_templates/rewrites/` | `outputs/rewrites/` |

与内置同名的文件会覆盖内置版本。通过 `prism_scaffold_template` / `prism_scaffold_component` / `prism_scaffold_rewrite` 创建的自定义资源默认写入 `_templates/`。

## 核心概念

### 组件（Components）

可复用的 Prompt 片段，通过 `{{@include path}}` 语法在模板中引用。

- `constraints.md` — 全局硬性约束（不编造、精确链接等），几乎所有模板共用
- `persona/` — 人设定义（技术博主、教程作者等）
- `style/` — 风格定义（叙事驱动、结构化教程等）
- `review/` — 审校标准

### 类型（Types）

产出的结构契约，声明读者画像、拆分粒度、变量需求和质量标准。

模板通过 frontmatter `type: diary` 引用类型，继承类型的默认配置（split、fileNaming 等），模板级可覆盖。

### 模板（Prompts）

实际的 Prompt 模板文件，包含最多五个区段：

| 区段 | 必需 | 说明 |
| ---- | ---- | ---- |
| `# System Prompt` | 是 | LLM 系统提示（人设、风格、约束） |
| `# Unit Prompt` | 是 | 每个产出单元的用户提示（含变量占位符） |
| `# Skeleton Template` | 否 | 骨架文件正文模板 |
| `# Review Prompt` | 否 | 质量审校提示（`--review` 时使用） |
| `# Stage: <name>` | 否 | 多阶段流水线的各阶段提示 |

### 改写（Rewrites）

已生成产出的风格变换定义。与模板不同，改写接受一篇已有文章作为输入，输出风格改写后的版本。

改写定义包含最多两个区段：

| 区段 | 必需 | 说明 |
| ---- | ---- | ---- |
| `# Rewrite Prompt` | 是 | 改写提示词，使用 `{{article_content}}` 和 `{{source_context}}` 变量 |
| `# Review Prompt` | 否 | 改写后信息保留度审校（`--review` 时使用） |

Frontmatter 字段：`name`、`description`、`platform`（wechat/zhihu/twitter/generic）、`preserveStructure`、`preserveLinks`、`preserveFrontmatter`。

改写结果写入原产出目录的 `_rewrites/<style>/` 子目录，不覆盖原文。

### 素材拆分粒度（Split）

| 值 | 说明 | 产出文件数 |
| ---- | ---- | ---- |
| `per-kl` | 每个 Key Line 一篇（默认） | N（KL 数量） |
| `per-perspective` | 整个视角一篇 | 1 |
| `per-group` | 每个 Group 一篇 | M（Group 数量） |

### 素材来源（Source）

| 来源类型 | 说明 |
| ---- | ---- |
| 单一视角 | 默认：`--perspective P01-xxx` |
| 多视角交叉 | `--perspective P01,P02` 或 frontmatter `source.type: cross-perspective` |
| 直接从 analysis | `--source analysis --groups G01,G02` |

## 新建产出流程

1. 确认素材就绪（视角已完成 scqa + tree，或 analysis groups 已充实）
2. 选择或创建类型定义（`types/`）
3. 创建 Prompt 模板（`prompts/`），引用组件和类型
4. 生成骨架：`output --skeleton --perspective ... --template ...`
5. 人工审查骨架
6. 生成产出：`output --perspective ... --template ...`
7. 可选审校：`output --perspective ... --template ... --review`
8. 可选改写：`rewrite --style kzk-wechat --dir outputs/<template>/<perspective>/`
9. 更新 [INDEX.md](INDEX.md) 的产出总览表

## CLI 参考

```
js-knowledge-prism output [选项]

--perspective <dir>  视角目录名（逗号分隔多个）
--template <name>    输出模板名
--output-dir <dir>   输出目录
--kl <id,...>        只处理指定 KL
--source <type>      素材来源（analysis）
--groups <ids>       指定 groups（配合 --source analysis）
--skeleton           只生成骨架
--validate           验证骨架引用
--dry-run            只预览
--force              覆盖已完成文件
--review             LLM 审校
--rewrite <style>    生成后自动执行风格改写
--stage <name>       从指定流水线阶段开始
--list-templates     列出可用模板
--list-types         列出可用类型
```

```
js-knowledge-prism rewrite [选项]

--style <name>       改写风格名
--file <path>        改写单个文件
--dir <path>         批量改写目录
--output-dir <dir>   自定义输出目录（默认 _rewrites/<style>/）
--force              覆盖已存在的改写结果
--review             改写后审校
--dry-run            只预览
--list-styles        列出可用改写定义
```

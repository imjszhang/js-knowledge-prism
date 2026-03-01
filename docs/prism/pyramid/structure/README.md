# 自上而下：组织阶段

从读者视角出发，将 analysis/ 的分析产出组织为面向表达的金字塔结构。

## 按视角组织

不同的读者视角会引出不同的情境-冲突-疑问-答案（SCQA），进而展开不同的金字塔树。每个视角是一套独立完整的组织方案。

同一套 analysis/ 产出（atoms、groups、synthesis）可以被多个视角复用，但每个视角有自己的 SCQA、tree 和 validation。

→ [视角总览与变更日志](INDEX.md)

## 视角目录命名规则

- 格式：`P01-简短描述/`（P = Perspective）
- 编号仅做标识，不代表优先级
- 每个视角目录下包含一套完整的 scqa.md + tree/ + validation.md

## 新建视角流程

1. 在 `structure/` 下创建 `PXX-描述/` 目录
2. 从 `_template/` 复制模板文件
3. 填写 scqa.md（读者画像 + S-C-Q-A 四要素）
4. **审视 [synthesis.md](../analysis/synthesis.md) 的候选观点**——从读者视角重新判断：
   - 哪些候选直接成为 Key Line？
   - 哪些需要合并或降级？
   - 是否有读者会追问但 synthesis 中缺失的观点？
5. 展开 tree/（从塔尖到 Key Line 到逐层论点）
6. 完成 validation.md（MECE 检查 + 缺口标记 + 与 synthesis 的差异记录）
7. 更新 [INDEX.md](INDEX.md) 的视角总览表

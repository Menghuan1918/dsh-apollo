---
name: main-agent-driven-development
description: "仅当用户或编排技能显式调用 /main-agent-driven-development 来完成一个边界明确的实现任务时使用。"
---

# 主代理驱动开发

由当前 Agent 会话直接实现一个边界明确的 Spec。外层 `/exec` 编排器负责 worktree 和合入生命周期。

## Worktree 模式

只选一种：

- **预建模式** — 调用方已提供隔离 worktree 并声明负责生命周期时，直接使用；不得创建、合并或删除 worktree。
- **独立模式** — 否则识别目标仓库，要求基线位于命名分支，记录起始 SHA，在仓库 `.worktrees/` 下创建 worktree。

所有操作必须在选定 worktree 内完成。隔离后不得编辑原始 checkout。

## 流程

1. 读取分配的 Spec 及相关仓库指令。
2. 确认任务边界、依赖、验收标准和必要验证。只有缺失决策真正阻塞实现时才提问。
3. 根据 Spec 初始化任务列表。
4. 项目初始化 + 基线验证。基线失败时先报告；仅当失败明确无关且已记录时才继续。
5. 直接实现，限定在 Spec 范围。遵循 `tdd` skill（本包已捆绑）：先写失败测试，再写最小实现。
6. 每个逻辑步骤后运行聚焦验证、自审 diff，内容完整时提交。验证标准：本轮运行命令并确认输出，不得以"应该通过"代替实际运行。
7. 实现完成后运行全部必要验证。
8. 验证失败或 CR 发现 bug 时，遵循 `diagnosing-bugs` skill（本包已捆绑）：先建反馈循环找根因，再修复。
9. 执行内部 CR 循环（见下文）。例外：作为 `/exec` dev 后端 workflow 波次中的实现节点时，**跳过本步**——CR 循环由编排脚本承担，节点只实现、验证、提交、报告。
10. 提交全部已批准修复，向调用方报告。

保持 KISS。优先复用既有模式，小而完整的修改，只做 Spec 必需的针对性重构。

## 内部 CR 循环

完整验证后，派遣恰好一个全新只读 reviewer 子代理（质量档 = 本会话最强模型）：

```
subagent(
  prompt="Review <worktree-abs-path> from <base_sha> to HEAD.
         Spec: <path>
         Implementation summary: <brief>
         Changed files: <list>
         Verification already run: <commands and results>"
)
```

要求附文件和行号，返回一种状态：`APPROVED` / `APPROVED_WITH_NOTES` / `CHANGES_REQUIRED` / `BLOCKED`。

用 `wait_subagent` 等待审查完成。收到结果后直接修复所有必要的正确性错误、Spec 缺口、安全问题、集成风险和验证缺口——不需要询问用户。验证并提交修复后，再用 `subagent` 派遣全新 reviewer。重复直到 `APPROVED` 或仅含非阻塞建议。

不得自我批准，不得复用旧 reviewer。

## 完成契约

报告完成前必须满足：

- 所有分配的验收标准已实现
- 必要验证已在本轮运行并通过（有命令输出为证）
- 没有未提交的实现修改
- 内部 CR 已通过且无必要修复项
- 可提供最终 commit SHA

如实报告阻塞。不得自行合入；调用方负责集成和清理。

---
name: dev
description: "DSH 执行后端的节点契约：实现节点与审查节点的 prompt 要求、报告 schema 与失败语义。"
---

# 内置开发后端（节点契约）

本技能定义执行后端的两类节点。波次编排（worktree、合并、清理、CR 循环调度）归 `/exec`；本技能不得创建、合并或删除 worktree。子代理没有独立工作目录，也看不到编排会话：节点的一切输入靠 prompt 自带（worktree 绝对路径、Spec 路径、共享契约、验证命令），bash 一律 `workdir`、文件工具一律绝对路径。

「质量档」指本会话可用的最强模型；不指定路由时子代理继承父会话的 provider/model，具体档位由调用方的会话配置决定，本技能不写死供应商。

## 实现节点（develop）

一个全新子代理（质量档）处理恰好一个子 Spec，以预建 worktree 模式遵循 `main-agent-driven-development`（在 `/exec` 的 workflow 波次中跳过其内部 CR 步骤——CR 循环由编排脚本承担，节点不自行派 reviewer）。

报告 schema（结构化输出）：

```js
{
  status: 'complete' | 'blocked',
  commit: '<最终 commit SHA>',
  verification: '<本轮已跑的验证命令与结果>',
  summary: '<实现摘要，供 reviewer 与编排器使用>',
  blocker: '<status=blocked 时必填>'
}
```

## 审查节点（review-only）

全新只读子代理（质量档）。prompt 自带：worktree 绝对路径、diff 范围、Spec 路径、实现摘要、已跑验证。四态判定 schema：

```js
{
  status: 'APPROVED' | 'APPROVED_WITH_NOTES' | 'CHANGES_REQUIRED' | 'BLOCKED',
  findings: ['<问题，附文件与行号>']
}
```

严重正确性错误、Spec 缺口、集成风险、安全问题或缺失验证必须 `CHANGES_REQUIRED`。不得编辑、提交、合并。

## 失败语义

子代理失败（error / 空返回）= `node-failed`；`blocked`、超时、部分回复或未提交的结果均不得视为完成。调用方决定重派，或仅在对同一子 Spec 解除阻塞时用 `send_message` 续谈。不得复用节点处理其他子 Spec。

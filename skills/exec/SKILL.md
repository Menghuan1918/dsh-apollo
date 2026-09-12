---
name: exec
description: "当用户调用 /exec 并提供已批准的主 Spec 时使用。负责编排逐 Spec worktree、波次 workflow 执行、合并、验证和最终代码审查。"
---

# 执行多 Spec 任务

在目标仓库的 `.worktrees/` 隔离 worktree 中执行已批准的子 Spec。主工作区始终是合入目标；编排状态只保存在当前会话上下文中。

## 前置条件

- 主 Spec 索引至少两个子 Spec。
- 确认唯一目标仓库；主工作区位于命名分支且工作树干净。
- `.worktrees/` 已被目标仓库 `.gitignore` 覆盖；没有就先提示用户加入。

## 执行

1. 读取主 Spec 和全部子 Spec，确认共享契约、依赖 DAG、验证命令。
2. 按依赖波次创建任务列表。
3. 每波：从主工作区 HEAD 建分支，在 `<repo>/.worktrees/exec-<任务>/<子任务>` 建 worktree，再派遣整波节点。前置波全部合入后才创建下一波 worktree。

## 波次执行：workflow 驱动

每波恰好一次 `workflow` 工具调用：脚本只做波内扇出与 CR 循环——worktree 创建、合并、清理全在主线程（workflow 引擎无文件系统，脚本碰不了 git）。节点契约（prompt 要素、schema、失败语义）见 `dev` skill。本波 specs 经 workflow 的 `args` 传入，每个元素带具体值：`{ id, specPath, worktree, contracts, verify }`（`worktree` 为绝对路径）。

```js
const specs = args.specs
// 质量档 = 本会话可用的最强模型。留空即不覆盖路由：子代理继承父会话的
// provider/model，任何环境都能跑。有固定质量档时只改这一处，例如：
// const quality = { provider: '<provider>', model: '<model>' }
const quality = {}
const implSchema = { type: 'object', required: ['status', 'commit', 'verification', 'summary'], properties: { status: { type: 'string', enum: ['complete', 'blocked'] }, commit: { type: 'string' }, verification: { type: 'string' }, summary: { type: 'string' }, blocker: { type: 'string' } }, additionalProperties: false }
const verdictSchema = { type: 'object', required: ['status', 'findings'], properties: { status: { type: 'string', enum: ['APPROVED', 'APPROVED_WITH_NOTES', 'CHANGES_REQUIRED', 'BLOCKED'] }, findings: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }
const implPrompt = (s) => `你在隔离 worktree ${s.worktree} 中工作：bash 一律 workdir=${s.worktree}，文件工具用绝对路径。以预建 worktree 模式遵循 main-agent-driven-development skill（跳过其内部 CR 步骤，CR 由本编排循环承担，节点不自行派 reviewer）。只实现 ${s.specPath} 的子 Spec，遵守共享契约：${s.contracts}。运行验证：${s.verify}。提交后按 schema 报告。不得合入或删除 worktree；阻塞时 status=blocked 并填 blocker。`
const reviewPrompt = (s, impl) => `只读审查 worktree ${s.worktree} 相对基线的完整 diff（bash 一律 workdir=${s.worktree}）。Spec：${s.specPath}。实现摘要：${impl.summary}。已跑验证：${impl.verification}。按严重度列出问题，每条附文件与行号；按 schema 四态判定。不得编辑、提交、合并。`
const fixPrompt = (s, impl, verdict) => `你在隔离 worktree ${s.worktree} 中继续前人的实现（bash 一律 workdir=${s.worktree}，文件工具用绝对路径）。此前摘要：${impl.summary}（commit ${impl.commit}）。reviewer 发现：${verdict.findings.join('；')}。逐条修复真实问题，对误报在 summary 中给出理由；重跑验证：${s.verify}；提交后按 schema 报告。不得合入。`
log(`wave: dispatching ${specs.length} spec(s)`)
return await parallel(specs.map((s) => async () => {
  let impl = await agent(implPrompt(s), { label: `${s.id}-impl`, schema: implSchema, ...quality })
  if (!impl || impl.status !== 'complete') return { spec: s.id, status: 'node-failed', impl }
  let verdict = await agent(reviewPrompt(s, impl), { label: `${s.id}-cr-1`, schema: verdictSchema, ...quality })
  let round = 1
  while (verdict && verdict.status === 'CHANGES_REQUIRED' && round < 5) {
    impl = await agent(fixPrompt(s, impl, verdict), { label: `${s.id}-fix-${round}`, schema: implSchema, ...quality })
    if (!impl || impl.status !== 'complete') return { spec: s.id, status: 'fix-failed', round }
    round += 1
    verdict = await agent(reviewPrompt(s, impl), { label: `${s.id}-cr-${round}`, schema: verdictSchema, ...quality })
  }
  return { spec: s.id, status: verdict ? verdict.status : 'review-failed', rounds: round, impl, verdict }
}))
```

要点：

- CR 循环是代码不是纪律：每轮全新 reviewer（`agent()` 一次一代理）、schema 校验判定、5 轮熔断。
- 子代理失败 resolve `null` → 该 Spec 记 `node-failed`，`parallel` 等整波，单个失败不拖垮其他 Spec。
- 质量档（本会话最强模型）在脚本顶部一处定义，impl / review / fix 节点全部使用；留空则由子代理继承父会话路由。
- 调用前台阻塞至整波结束，波内无人工交互；节点的疑问一律按 blocked 上报，由主线程处置。
- 返回值是结构化波次报告：只有 `status` 为 `APPROVED` / `APPROVED_WITH_NOTES` 的 Spec 进入合并。

## 合并

对每个完成节点：确认已提交且验证通过 → 检查变更文件排除越界 → 合入主工作区 → 合并后验证 → 删除 worktree 和子分支。

小而明确的冲突由主代理直接解决。复杂冲突用 `.worktrees/` 下新的修复 worktree 和开发节点。不得合并失败或阻塞的节点。

## 最终审查

所有子 Spec 合入后，运行完整集成验证，然后派遣一个全新只读 reviewer 子代理（质量档 = 本会话最强模型）审查全量集成结果：

```
subagent(
  prompt="只读审查 <workspace> 的 <base>..HEAD diff（bash 一律 workdir=<workspace>）。
         主 Spec: <path> | 全部子 Spec | 共享契约 | 变更文件 | 实现摘要 | 验证结果。
         按严重度列出问题，每条附文件与行号。
         返回 APPROVED / APPROVED_WITH_NOTES / CHANGES_REQUIRED / BLOCKED。不得编辑、提交、合并。"
)
```

用 `wait_subagent` 等待。`CHANGES_REQUIRED` 时不需要询问用户——主代理直接分类并修复所有真实 bug，对误报和既有行为在上下文中简述理由；修复后重新验证，再派全新 reviewer 复审。软熔断 3 轮后仍存在严重或阻塞问题则停止修复循环，如实向用户报告剩余问题。

## 收尾

运行完整验证，核对 Spec，报告分支、提交、验证结果和遗留问题，询问用户下一步。未经用户选择不得创建 PR 或删除分支。

## KISS

- 一个子 Spec、一个 worktree、一个开发节点。
- 主线程只持仓库拓扑（分支/worktree/合并/清理）；波内扇出交给一次 workflow 调用。
- 状态只保存在会话上下文；不增加集成分支、调度脚本或状态文件。
- 等待靠完成通知自动送达，需要结果才继续时再等待。不得用 `sleep` 轮询。

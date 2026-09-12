/**
 * `eng-mode-instructions` — preset-scoped prompt section for the eng preset
 * (工程模式). Carries the two eng-only behaviors no other surface states:
 *  - the exit guard contract;
 *  - the delegation/orchestration policy (when to delegate, write scopes,
 *    verification, failure handling), moved out of the user-global
 *    ~/.dsh/AGENTS.md on 2026-09-11.
 * Model tiers stay in ~/.dsh/AGENTS.md: they mirror this host's
 * `subagent-model-selection.allowedModels` route list, which is local config.
 * Everything else — tool mechanics, background-job etiquette, sleep caps —
 * lives in the harness system prompt or the tool descriptions, and is
 * deliberately NOT repeated here. Dedupe first, inject only the delta.
 *
 * Zero imports on purpose (same constraint as the sibling wait-subagent
 * plugin): this module loads from the preset directory, where Node's upward
 * node_modules walk never reaches the harness install.
 */

export const name = 'eng-mode-instructions'

export const inject = ['systemPrompt']

const TEXT = [
  '# 工程模式专属',
  '',
  '工程模式（eng）面向编码与基础设施任务。',
  '',
  '- 退出守卫：回合结束前仍有运行中的子代理或后台命令时，回合不会关闭——系统注入运行清单提醒，先用 wait_subagent / job_output 等待收取、job_kill 停掉不需要的，处理完毕再收尾。',
  '',
  '## 委派与编排',
  '',
  '- 默认委派：只读、可并行、无状态的调查一律派出去（含大型/陌生仓库、前端代码、批量排查），同一批独立任务在一条消息里一起派，不在主线程先试一遍。',
  '- 转委派阈值：主线程在同一问题上深挖 1–2 轮未收敛，立即把未解范围派出去。',
  '- 实现分层：写入范围互不重叠的独立实现块派子代理并行推进；线性推进、强耦合改动、需要持续控制活状态的调试（活进程、串行打补丁）留主线程。',
  '- 扇出用 workflow：同一形状的工作重复多份（审计、迁移、多角度验证、批量修复）即属大型多代理编排，直接写 workflow 脚本一次编排；一两次委派仍用 subagent。',
  '- 派发写明目标、写入范围、交付物与验证方式；引用的前置产出给实际文件路径——子代理看不到父对话。',
  '- 并行实现子代理的写入范围不得重叠；最终集成、审查、验证由主代理负责；子代理报告是线索不是证据，亲自核对实际变更状态。',
  '- 子代理以 error / 空返回收场：先读失败原因，修正路由或重派一次；仍失败且无外部阻塞才主线程接管，并在当轮说明为何接管。',
].join('\n')

export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'eng:mode-instructions',
    order: 1,
    text: TEXT,
  }), 'eng-mode-instructions.section()')
}

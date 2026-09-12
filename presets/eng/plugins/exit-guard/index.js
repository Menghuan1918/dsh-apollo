/**
 * `eng-exit-guard` — 工程模式退出守卫（预设本地插件）。
 *
 * pi-atlas task guard 的 DSH 等价物：回合即将结束时（`agent/turn-stopping`，
 * serial 事件——监听器跑完后 agent-loop 会重查 inbox，`agent.steer()` 加入的
 * next-step 消息使回合不关闭），若本代理仍有运行中的直接子代理或后台任务，
 * 注入一条提醒强制回合继续，直到 wait_subagent / job_output 等待收取、
 * job_kill 停止，或用户中断（被中断的回合在 dispatch 前即 throwIfAborted，
 * 天然不触发本守卫——Esc 始终是逃生口）。
 *
 * 无豁免机制（曾有 exitGuardIgnore 子串清单，因会被用来静默绕过守卫而移除
 * ——实测有会话中 agent 被拦一次后自行写入豁免，后续回合全部静默放行）：
 * 任何存活的后台 job 都必须被收取或停止，回合才能收尾。需要跨回合常驻的
 * 服务（dev server、watcher）用 pm2/systemd/裸 nohup 等脱离 DSH job 注册表
 * 的方式管理——守卫只看本地 job 注册表与直接子代理。
 *
 * 每次事件前重读 `<dshHome>/eng.json` 的 exitGuard（布尔开关，**默认关闭**，
 * 显式写 `true` 才生效；旧名 atlas.json 仍被回退读取），改配置即时生效。
 * 查询失败（listChildren / jobs.list 抛错）按 fail-open 处理：告警并放行本次
 * 回合结束，避免查询故障把回合卡死。
 *
 * 零 bare import（同 wait-subagent 约束）；消息构造参照 goal-round-driver /
 * repeat-tool-reminder 的 plain-object 模式。
 */

import { readEngConfig } from '../lib/atlas-config.js'

export const name = 'eng-exit-guard'

export const inject = ['subagents', 'agents']

/** 后台任务终态（dsh-jobs-local isTerminal 同款）。 */
const JOB_TERMINAL = new Set(['completed', 'killed', 'failed'])

/** 渲染一条运行项清单行。 */
function lineOf(prefix, id, detail) {
  return `  - ${prefix} ${id}${detail === undefined || detail === '' ? '' : `（${detail}）`}`
}

/**
 * 构造 steer 提醒消息（模型可见，进入会话日志）。
 * @param children - 运行中的直接子代理 listChildren 条目。
 * @param jobs - 运行中的后台任务快照。
 * @returns 一条 user 角色的 plugin notice 消息。
 */
function buildMessage(children, jobs) {
  const lines = []
  for (const child of children) {
    // 0.1.1-rc.2 的条目是 meta:{mode,label}，0.1.2 起 mode/label 升为顶级；
    // 兼容回退只影响展示措辞，绝不抛错。
    lines.push(lineOf('子代理', child.id, child.label ?? child.meta?.label))
  }
  for (const job of jobs) {
    lines.push(lineOf('后台任务', job.id, job.label === undefined ? job.kind : `${job.label}，${job.kind}`))
  }
  const text = [
    '⚠️ 以下后台工作仍在运行，回合不能结束：',
    ...lines,
    '',
    '请先用 wait_subagent 等待运行中的子代理（需要续用其对话用 send_message）、'
      + '用 job_output 收取后台命令的结果；确属不需要的用 job_kill 停止，全部处理完毕后再收尾。',
  ].join('\n')
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'eng-exit-guard',
      form: 'notice',
      summary: `运行中的后台工作阻止回合结束（子代理 ${children.length}，后台任务 ${jobs.length}）`,
    },
    id: crypto.randomUUID(),
  }
}

/**
 * 收集本代理仍在运行的后台工作。
 * @param ctx - 预设插件上下文（subagents / agents 注入，jobs 可选）。
 * @param agent - 回合即将结束的代理。
 * @returns `{ children, jobs }`；查询失败抛出由调用方按 fail-open 处理。
 */
async function collectRunning(ctx, agent) {
  const children = []
  for (const entry of await ctx.subagents.listChildren(agent.id)) {
    if (ctx.agents.get(entry.id)?.status === 'running') children.push(entry)
  }
  const jobs = ctx.get('jobs')
  const runningJobs = jobs === undefined
    ? []
    : jobs.list(agent).filter((job) => !JOB_TERMINAL.has(job.status))
  return { children, jobs: runningJobs }
}

export function apply(ctx) {
  ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload?.agent
    if (agent === undefined || payload?.signal?.aborted) return
    try {
      if (!readEngConfig().exitGuard) return
      const { children, jobs } = await collectRunning(ctx, agent)
      if (children.length === 0 && jobs.length === 0) return
      if (payload.signal?.aborted) return
      agent.steer(buildMessage(children, jobs))
    } catch (error) {
      // fail-open：查询或注入失败时放行本次回合结束，守卫不应卡死会话。
      ctx.logger?.warn?.(`eng-exit-guard: guard skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

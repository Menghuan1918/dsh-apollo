/**
 * exit-guard 单元测试：运行检测、steer 注入、开关、中断跳过、fail-open。
 * 以 fake ctx 直接驱动 apply 注册的 agent/turn-stopping 监听器。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../presets/eng/plugins/exit-guard/index.js'

/** 构造 fake ctx：捕获事件处理器，注入可控行的 subagents/agents/jobs。 */
function makeCtx({ children = [], agentStatus = new Map(), jobs } = {}) {
  const handlers = new Map()
  const warnings = []
  return {
    handlers,
    warnings,
    on: (event, fn) => handlers.set(event, fn),
    subagents: { listChildren: async () => children },
    agents: { get: (id) => agentStatus.get(id) },
    get: (serviceName) => (serviceName === 'jobs' ? jobs : undefined),
    logger: { warn: (text) => warnings.push(text) },
  }
}

/** 装载守卫并触发一次 turn-stopping，返回被 steer 的消息数组。 */
async function fireTurnStopping(ctx, agent, { aborted = false } = {}) {
  apply(ctx)
  const steered = []
  agent.steer = (message) => steered.push(message)
  const handler = ctx.handlers.get('agent/turn-stopping')
  assert.equal(typeof handler, 'function', 'apply 应注册 agent/turn-stopping 监听器')
  await handler({ agent, turn: 1, signal: { aborted } })
  return steered
}

/**
 * 临时 DSH_HOME + 指定 eng.json 内容（旧名 atlas.json 仍被回退读取）。
 * 守卫默认关闭，故「应触发」的用例都必须显式写入开启配置。
 * @param content - 配置文件内容；undefined 表示不写任何配置文件（走默认）。
 * @param run - 在临时 home 生效期间执行的用例体。
 */
function withConfig(content, run) {
  const home = mkdtempSync(join(tmpdir(), 'eng-guard-'))
  const prev = process.env.DSH_HOME
  if (content !== undefined) writeFileSync(join(home, 'eng.json'), content)
  process.env.DSH_HOME = home
  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    })
}

const PARENT = { id: 'parent-1' }
/** 守卫是显式开关：默认关闭，开启必须写进 eng.json。 */
const ENABLED = '{"exitGuard": true}'

test('插件契约：name 与 inject', () => {
  assert.equal(name, 'eng-exit-guard')
})

test('有运行中子代理 → steer 一次，消息含清单与工具指引', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: { label: '探索仓库' } }, { id: 'child-2', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'running' }], ['child-2', { status: 'idle' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    const [message] = steered
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'plugin')
    assert.equal(message.source.plugin, 'eng-exit-guard')
    assert.equal(typeof message.id, 'string')
    const text = message.content[0].text
    assert.match(text, /child-1/)
    assert.match(text, /探索仓库/)
    assert.doesNotMatch(text, /child-2/)
    assert.match(text, /wait_subagent/)
    assert.match(text, /job_output/)
    assert.match(text, /job_kill/)
  })
})

test('子代理全部空闲 → 不 steer', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'idle' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
  })
})

test('listChildren 新形状（0.1.2：label 顶级）与旧形状（meta.label）都能展示标签', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [
        { id: 'child-new', label: '新版标签', mode: 'continuable' },
        { id: 'child-old', meta: { label: '旧版标签', mode: 'continuable' } },
      ],
      agentStatus: new Map([['child-new', { status: 'running' }], ['child-old', { status: 'running' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    const text = steered[0].content[0].text
    assert.match(text, /新版标签/)
    assert.match(text, /旧版标签/)
  })
})

test('无子代理注册（agents.get 未命中）→ 不 steer', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-cold', meta: {} }],
      agentStatus: new Map(),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
  })
})

test('运行中后台任务 → steer，终态任务忽略', async () => {
  await withConfig(ENABLED, async () => {
    const jobs = {
      list: () => [
        { id: 'job-1', kind: 'bash', label: 'build', status: 'running' },
        { id: 'job-2', kind: 'bash', label: 'done', status: 'completed' },
        { id: 'job-3', kind: 'bash', label: 'killed', status: 'killed' },
        { id: 'job-4', kind: 'bash', label: 'failed', status: 'failed' },
      ],
    }
    const ctx = makeCtx({ jobs })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    const text = steered[0].content[0].text
    assert.match(text, /job-1/)
    assert.doesNotMatch(text, /job-2/)
    assert.doesNotMatch(text, /job-3/)
    assert.doesNotMatch(text, /job-4/)
  })
})

test('jobs 服务缺失 → 仅按子代理判定，不崩溃', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'running' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
  })
})

test('遗留 exitGuardIgnore 键不再有任何豁免效果（机制已移除）', async () => {
  await withConfig('{"exitGuard": true, "exitGuardIgnore": ["watch_glm53.sh", "--profile web --patch"]}', async () => {
    const jobs = {
      list: () => [{ id: 'bash-7', kind: 'bash', label: 'bash: /tmp/watch_glm53.sh >> log', status: 'running' }],
    }
    const ctx = makeCtx({
      children: [{ id: 'child-1', label: '探索仓库结构' }],
      agentStatus: new Map([['child-1', { status: 'running' }]]),
      jobs,
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    const text = steered[0].content[0].text
    assert.match(text, /bash-7/)
    assert.match(text, /child-1/)
    assert.doesNotMatch(text, /豁免/)
  })
})

test('exitGuard=false → 不 steer', async () => {
  await withConfig('{"exitGuard": false}', async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'running' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
  })
})

test('配置文件缺失 → 默认关闭，不 steer', async () => {
  await withConfig(undefined, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'running' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
  })
})

test('signal.aborted → 不 steer（用户中断逃生口）', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      children: [{ id: 'child-1', meta: {} }],
      agentStatus: new Map([['child-1', { status: 'running' }]]),
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT }, { aborted: true })
    assert.equal(steered.length, 0)
  })
})

test('listChildren 抛错 → fail-open：不 steer 不崩溃并告警', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx()
    ctx.subagents.listChildren = async () => { throw new Error('boom') }
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /boom/)
  })
})

test('jobs.list 抛错 → fail-open：不 steer 不崩溃并告警', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      jobs: { list: () => { throw new Error('jobs boom') } },
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /jobs boom/)
  })
})

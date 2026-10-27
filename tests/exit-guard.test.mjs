/**
 * exit-guard 单元测试：只对后台 job 生效、source kind、steer 注入、开关、
 * 中断跳过、fail-open。以 fake ctx 直接驱动 apply 注册的 agent/turn-stopping
 * 监听器。运行中子代理的拦截属于 dsh-better-subagent，不在这里断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, buildJobGuardMessage, name, NOTICE_SOURCE_KIND } from '../presets/eng/plugins/exit-guard/index.js'

let liveConfig = {}

/** Fake the same profile-backed live config used by the real guard. */
function makeCtx({ jobs, listError } = {}) {
  const handlers = new Map()
  const warnings = []
  const listed = []
  return {
    handlers,
    warnings,
    listed,
    on: (event, fn) => handlers.set(event, fn),
    get: (serviceName) => {
      if (serviceName === 'jobs') {
        return jobs === undefined ? undefined : {
          list: (sessionId) => {
            listed.push(sessionId)
            if (listError !== undefined) throw listError
            return jobs
          },
        }
      }
      if (serviceName === 'configEditor') {
        return { entries: () => [{ options: { id: 'apollo-skills' }, fiber: { config: liveConfig } }] }
      }
      return undefined
    },
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

/** Change the live configuration without reloading the guard. */
function withConfig(content, run) {
  const previous = liveConfig
  liveConfig = content === undefined ? {} : JSON.parse(content)
  return Promise.resolve().then(run).finally(() => { liveConfig = previous })
}

const PARENT = { id: 'parent-1' }
/** 守卫是显式开关：默认关闭，开启必须写进 profile 配置。 */
const ENABLED = '{"exitGuard": true}'

test('插件契约：name 与 producer-owned source kind', () => {
  assert.equal(name, 'eng-exit-guard')
  assert.equal(NOTICE_SOURCE_KIND, 'better-apollo-job-exit-guard')
  // session format v4 拒绝 {kind:'plugin'}；kind 必须是生产者自有、非空字符串。
  const message = buildJobGuardMessage([{ id: 'job-1', kind: 'bash', label: 'build', status: 'running' }])
  assert.equal(message.source.kind, NOTICE_SOURCE_KIND)
  assert.notEqual(message.source.kind, 'plugin')
  assert.equal(Object.hasOwn(message.source, 'plugin'), false)
})

test('运行中后台任务 → steer 一次，消息含 job 清单与工具指引', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({
      jobs: [
        { id: 'job-1', kind: 'bash', label: 'build', status: 'running' },
        { id: 'job-2', kind: 'bash', label: 'done', status: 'completed' },
        { id: 'job-3', kind: 'bash', label: 'killed', status: 'killed' },
        { id: 'job-4', kind: 'bash', label: 'failed', status: 'failed' },
      ],
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    const [message] = steered
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, NOTICE_SOURCE_KIND)
    assert.equal(typeof message.id, 'string')
    const text = message.content[0].text
    assert.match(text, /background job job-1 \(build, bash\)/)
    assert.doesNotMatch(text, /job-2/)
    assert.doesNotMatch(text, /job-3/)
    assert.doesNotMatch(text, /job-4/)
    assert.match(text, /job_output/)
    assert.match(text, /job_kill/)
    assert.doesNotMatch(text, /wait_subagent/)
    assert.doesNotMatch(text, /subagent/)
    assert.deepEqual(ctx.listed, [PARENT.id], 'job registry list 必须收到 SessionId')
  })
})

test('没有运行中 job（全终态）→ 不 steer', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({ jobs: [{ id: 'job-1', kind: 'bash', status: 'completed' }] })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
  })
})

test('jobs 服务缺失 → 不 steer，不崩溃', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({ jobs: undefined })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
    assert.deepEqual(ctx.warnings, [])
  })
})

test('exitGuard 默认关闭 → 不查询、不 steer', async () => {
  await withConfig('{}', async () => {
    const ctx = makeCtx({ jobs: [{ id: 'job-1', kind: 'bash', status: 'running' }] })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
    assert.deepEqual(ctx.listed, [], '开关关闭时不应查询 job 注册表')
  })
})

test('用户中断（signal aborted）→ 不 steer', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({ jobs: [{ id: 'job-1', kind: 'bash', status: 'running' }] })
    const steered = await fireTurnStopping(ctx, { ...PARENT }, { aborted: true })
    assert.equal(steered.length, 0)
  })
})

test('查询失败按 fail-open 放行并告警', async () => {
  await withConfig(ENABLED, async () => {
    const ctx = makeCtx({ jobs: [], listError: new Error('registry offline') })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 0)
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /guard skipped: registry offline/)
  })
})

test('遗留 exitGuardIgnore 键不再有任何豁免效果（机制已移除）', async () => {
  await withConfig('{"exitGuard": true, "exitGuardIgnore": ["watch.sh"]}', async () => {
    const ctx = makeCtx({
      jobs: [{ id: 'bash-7', kind: 'bash', label: 'bash: /tmp/watch.sh >> log', status: 'running' }],
    })
    const steered = await fireTurnStopping(ctx, { ...PARENT })
    assert.equal(steered.length, 1)
    assert.match(steered[0].content[0].text, /bash-7/)
  })
})

test('日志样式：job 无 label 时使用 kind', () => {
  const message = buildJobGuardMessage([{ id: 'job-9', kind: 'pwsh', status: 'running' }])
  assert.match(message.content[0].text, /background job job-9 \(pwsh\)/)
  assert.match(message.source.summary, /1/)
})

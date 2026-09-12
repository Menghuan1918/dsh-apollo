/**
 * wait-subagent 单元测试：数组入参契约、正常等待、已完成快路径、刚派发未启动
 * 的宽限等待、宽限超时、用户超时、错误收场、非直接子代理 fail-fast、多 id
 * 并发、混合收场、去重、不动父代理 inbox。
 * 以 fake ctx 直接驱动 apply 注册的 subagent/end 监听器与 wait_subagent 工具。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../presets/eng/plugins/wait-subagent/index.js'

/** 构造 fake ctx：捕获事件处理器与注册的工具，注入可控行的 agents/subagents。 */
function makeCtx({ children = [] } = {}) {
  const handlers = new Map()
  const agentStatus = new Map()
  let tool
  const ctx = {
    handlers,
    agentStatus,
    on: (event, fn) => handlers.set(event, fn),
    subagents: { listChildren: async () => children },
    agents: { get: (id) => agentStatus.get(id) },
    tools: { register: (definition) => { tool = definition } },
  }
  apply(ctx)
  ctx.getTool = () => tool
  return ctx
}

/** 每个用例独立的 exec（parent agent 可携带 inbox）。 */
function makeExec(inbox) {
  return { agent: { id: 'parent-1', inbox } }
}

/** 让 execute 走过首个 await（listChildren），到达等待注册点。 */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 触发一次 subagent/end。 */
function fireEnd(ctx, info) {
  const handler = ctx.handlers.get('subagent/end')
  assert.equal(typeof handler, 'function', 'apply 应注册 subagent/end 监听器')
  handler(info)
}

const DONE = (id, stop = 'completed') =>
  `subagent ${id} done (${stop}); its closing message follows as the settlement notice.`

test('插件契约：name / inject / 工具注册（subagent_id 为数组）', () => {
  assert.equal(name, 'tool-wait-subagent')
  assert.deepEqual(inject, ['tools', 'subagents', 'agents'])
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const tool = ctx.getTool()
  assert.equal(tool.name, 'wait_subagent')
  assert.deepEqual(tool.parameters.required, ['subagent_id'])
  assert.equal(tool.parameters.properties.subagent_id.type, 'array')
  assert.equal(tool.parameters.properties.subagent_id.items.type, 'string')
  assert.equal(tool.parameters.properties.subagent_id.minItems, 1)
  assert.equal(tool.isConcurrencySafe(), true)
})

test('运行中的子代理完成 → 返回短 done 行，不含子代理消息内容', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '扫描完成：3 个入口', stopReason: 'completed' })
  const out = await pending
  assert.equal(out, DONE('child-1'))
  // 内容交还框架 settlement notice，工具结果本身不携带。
  assert.ok(!out.includes('扫描完成'))
})

test('非直接子代理 → unknown 提示，不等待', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const out = await ctx.getTool().execute({ subagent_id: ['stranger'] }, makeExec())
  assert.match(out, /unknown subagent "stranger"/)
})

test('批量含非直接子代理 → 列出全部未知 id，立即 fail-fast 不等待', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  // stranger 与 ghost 都不是直接子代理：直接返回，child-1 不被等待
  //（返回发生在任何 fireEnd 之前）。
  const out = await ctx.getTool().execute({ subagent_id: ['child-1', 'stranger', 'ghost'] }, makeExec())
  assert.match(out, /unknown subagent "stranger", "ghost"/)
  assert.ok(!out.includes('child-1 done'))
})

test('本轮早已完成的子代理（idle + 已有 settlement）→ 立即返回 done 行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: '早前已完成' }], stopReason: 'completed' })
  ctx.agentStatus.set('child-1', { status: 'idle' })
  const out = await ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  assert.equal(out, DONE('child-1'))
})

test('刚派发、尚未启动的子代理 → 宽限等待其启动并完成，不再误报 not running（竞态修复）', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  // 尚未注册进 agents（status 视为 ready），也无 settlement —— 旧实现会立刻
  // 返回 "is not running" 导致回合早退；新实现等它启动。
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  ctx.agentStatus.set('child-1', { status: 'running' })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '竞态场景下的结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
})

test('宽限期内子代理始终未启动 → 返回可重试的 not-started 提示', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  t.mock.timers.tick(31_000)
  const out = await pending
  assert.match(out, /has not started after 30s/)
  assert.match(out, /status: ready/)
  assert.match(out, /wait_subagent again/)
})

test('等待已启动子代理时用户 timeout_ms 到期 → timed out 提示', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'], timeout_ms: 5000 }, makeExec())
  await flushMicrotasks()
  t.mock.timers.tick(5000)
  const out = await pending
  assert.match(out, /timed out waiting for subagent child-1/)
})

test('子代理以 error 收场 → done 行标注 error stopReason，内容仍在框架通知', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: 'Model not found', stopReason: 'error' })
  const out = await pending
  assert.equal(out, DONE('child-1', 'error'))
  assert.ok(!out.includes('Model not found'))
})

test('多 id 并发等待：先后结算，按输入顺序各出一行 done', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'] }, makeExec())
  await flushMicrotasks()
  // child-2 先结算，child-1 后结算；返回仍按输入顺序。
  fireEnd(ctx, { id: 'child-2', lastAssistantMessage: '二号线结果', stopReason: 'completed' })
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '一号结果', stopReason: 'completed' })
  assert.equal(await pending, `${DONE('child-1')}\n${DONE('child-2')}`)
})

test('混合收场：一个结算一个超时 → done 行 + timed out 行', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  ctx.agentStatus.set('child-2', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-2'], timeout_ms: 5000 }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '快的结果', stopReason: 'completed' })
  t.mock.timers.tick(5000)
  const out = await pending
  const lines = out.split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], DONE('child-1'))
  assert.match(lines[1], /timed out waiting for subagent child-2/)
})

test('重复 id 去重：同 id 传两次只出一行', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const pending = ctx.getTool().execute({ subagent_id: ['child-1', 'child-1'] }, makeExec())
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
})

test('收场时不做 inbox 手术：父代理 pending 队列原样保留（内容由框架投递）', async () => {
  const ctx = makeCtx({ children: [{ id: 'child-1' }, { id: 'child-2' }] })
  ctx.agentStatus.set('child-1', { status: 'running' })
  const spliced = []
  // 框架在 subagent/end 之前已把 settlement notice steer 进运行中父代理的
  // next-step（0.1.2-alpha.4 起 report 被 send_message 取代，kind 为
  // agent-message）。wait_subagent 只回 done 行，pending 消息一条都不动。
  const inbox = {
    nextStep: [
      { source: { kind: 'subagent-settled', senderSessionId: 'child-2' } },
      { source: { kind: 'agent-message', senderSessionId: 'child-1' } },
      { source: { kind: 'subagent-settled', senderSessionId: 'child-1' } },
    ],
    nextTurn: [],
    splice: (queue, index, count, items) => {
      spliced.push({ queue, index, count })
      const arr = queue === 'next-step' ? inbox.nextStep : inbox.nextTurn
      arr.splice(index, count, ...(items ?? []))
    },
  }
  const pending = ctx.getTool().execute({ subagent_id: ['child-1'] }, makeExec(inbox))
  await flushMicrotasks()
  fireEnd(ctx, { id: 'child-1', lastAssistantMessage: '结果', stopReason: 'completed' })
  assert.equal(await pending, DONE('child-1'))
  // 零 splice：通知与 mid-run 消息全部留给框架投递。
  assert.deepEqual(spliced, [])
  assert.equal(inbox.nextStep.length, 3)
})

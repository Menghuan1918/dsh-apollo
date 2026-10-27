/**
 * subagents 独立契约测试：installCliRouting 的 public 行为面。
 *
 * 契约来源（不镜像实现，只断言对外可观察的结果）：
 * - DSH 的 `tools/guard` 与 `tools/execute` 是官方 seam：guard 只返回拒绝原因字符串或
 *   undefined（`…/dsh-tools/lib/types/index.d.ts` 的 ToolGuard），execute 返回
 *   `ToolExecutionResult`（`{isError:false, value, content}` 或 `{isError:true, error, content}`），
 *   不调 `next()` 即短路（官方 `dsh-tool-call-timeout-policy` 同款用法）。
 * - `ctx.subagents.startActivation(spec)` 的 spec 形如
 *   `{provider, label, childId, signal, delivery:'parent', request:{parent, prompt, cwd, agentOptions, maxDepth?}}`，
 *   返回 `{childId, messageId}`（`…/dsh-subagent/lib/types/types.d.ts` 的
 *   `SubagentActivationSpec` / `SubagentActivation`）。
 * - `ctx.subagents.drainChildren(parent, childIds)` 用于取消/失败后的清理。
 * - `ctx.workingDirectory.ensure(parent, signal)` 是父 Agent 当前目录的唯一权威
 *   （`…/dsh-working-directory/lib/types/index.d.ts`）；Session header 的 cwd
 *   只是原始项目目录，可能已过时。
 * - subagent 工具的成功输出在 0.2.1 起是 `{kind:'activation', subagentId}`。
 *
 * 运行：node --test tests/subagents.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliCatalog, installCliRouting, startCliSubagent } from '../src/subagents.js'

// ── 契约配置工厂 ─────────────────────────────────────────────────────────────
// 形状取自 src/* 的消费点：subagents[cli] = {enabled, executable, profile,
// permissionMode, defaultModel, models:[{id, model?, efforts, defaultEffort}]}。

/**
 * 构造一个「两个 CLI 后端都启用」的配置对象。
 * @param {{global?: boolean, eng?: boolean, codex?: object, claude?: object}} overrides
 */
function makeConfig({ global = true, eng = false, codex = {}, claude = {} } = {}) {
  const backend = (extra) => ({
    enabled: true,
    executable: 'codex',
    profile: '',
    permissionMode: 'read-only',
    defaultModel: 'gpt-5-codex',
    models: [
      { id: 'gpt-5-codex', efforts: ['low', 'high'], defaultEffort: 'low' },
      { id: 'gpt-5-codex-mini', efforts: ['low'], defaultEffort: 'low' },
    ],
    ...extra,
  })
  return {
    subagents: {
      global,
      eng,
      codex: backend(codex),
      claude: backend({ executable: 'claude', defaultModel: 'sonnet', models: [{ id: 'sonnet', efforts: ['low', 'max'], defaultEffort: 'low' }], ...claude }),
    },
  }
}

/**
 * 一个最小 Agent：只需 session.header（preset/cwd/parent/origin）。
 * header.cwd 是「原始项目目录」，新实现不得把它当作当前目录的唯一来源。
 */
function makeAgent({ preset = 'eng', cwd = '/tmp/apollo-work', id = 'parent-1', parentSession = undefined, origin = undefined, provider = undefined } = {}) {
  return {
    id,
    options: provider === undefined ? {} : { provider },
    session: { header: { agentPreset: preset, cwd, parentSession, origin } },
  }
}

/**
 * 造一个 fake working-directory service：记录 ensure 调用，返回可控的「当前目录」。
 * 真实契约：`ensure(agent, signal)` 返回已存在的绝对目录（会先校验，必要时恢复原项目）。
 * @param {{current?: string, failure?: Error}} options
 */
function makeWorkingDirectory({ current = '/tmp/apollo-work', failure } = {}) {
  const ensured = []
  return {
    ensured,
    current,
    async ensure(agent, signal) {
      ensured.push({ agent, signal })
      signal?.throwIfAborted?.()
      if (failure !== undefined) throw failure
      return current
    },
  }
}

/** 记录 put/delete 调用的内存 session store（满足 CliSessions 的公开方法面）。 */
function makeSessions(initial = {}) {
  const records = new Map(Object.entries(initial))
  const calls = []
  return {
    records,
    calls,
    get: (id) => (records.has(id) ? structuredClone(records.get(id)) : undefined),
    async put(record) {
      calls.push(['put', record.id])
      records.set(record.id, structuredClone(record))
    },
    async delete(id) {
      calls.push(['delete', id])
      records.delete(id)
    },
    has: (id) => records.has(id),
  }
}

/** 捕获 guard / execute / systemPrompt 段 / tools/result 的 fake ctx。 */
function makeCtx({ subagents = {}, agents = {}, subprocess = {}, workingDirectory = makeWorkingDirectory(), logger } = {}) {
  const guards = []
  const handlers = new Map()
  const handlersOf = new Map()
  const sections = []
  const resolved = []
  const warnings = []
  const ctx = {
    guards,
    handlers,
    handlersOf,
    sections,
    resolved,
    warnings,
    tools: { guard: (guard) => { guards.push(guard); return () => {} } },
    on: (event, handler) => {
      handlers.set(event, handler)
      const list = handlersOf.get(event) ?? []
      list.push(handler)
      handlersOf.set(event, list)
      return () => {}
    },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    subagents: {
      resolveMaxDepth: () => undefined,
      // 真实契约（0.2.1）：manager 返回的 childId 就是调用方预留的 spec.childId。
      startActivation: async (spec) => ({ childId: spec.childId, messageId: 'msg-1' }),
      drainChildren: async () => {},
      ...subagents,
    },
    workingDirectory,
    agents: { get: () => undefined, ...agents },
    subprocess: {
      // 真实契约：resolveExecutable 返回规范化的可执行路径（…/dsh-subprocess/lib/types/index.d.ts:79-94）。
      resolveExecutable: async (command) => { resolved.push(command); return `/resolved/${command}` },
      ...subprocess,
    },
    logger: logger ?? { warn: (text) => warnings.push(String(text)) },
  }
  return ctx
}

/** 跑一遍所有已注册 guard，返回拒绝原因数组（undefined 过滤掉）。 */
function guardReasons(ctx, exec, args = {}) {
  return ctx.guards.map((guard) => guard({ ...exec, arguments: args })).filter((reason) => reason !== undefined)
}

/** 一次工具调用的 exec：contract 要求带 signal（短路路径会 throwIfAborted）。 */
function makeExec(agent, { aborted = false } = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return { agent, signal: controller.signal }
}

/** tools/execute 监听器（installCliRouting 注册的那个），带一个 spying next。 */
function executeHandler(ctx, delegated) {
  const handler = ctx.handlers.get('tools/execute')
  assert.equal(typeof handler, 'function', 'installCliRouting 应注册 tools/execute 监听器')
  const singleton = delegated ?? { isError: false, value: 'upstream', content: [{ type: 'text', text: 'upstream' }] }
  const next = async () => {
    next.calls += 1
    return singleton
  }
  next.calls = 0
  return [handler, next]
}

// ── A. ordinary next 委托 ────────────────────────────────────────────────────

test('ordinary：非子代理工具调用一律 next() 委托，不短路', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const [handler, next] = executeHandler(ctx)
  const upstream = await next()
  const exec = makeExec(makeAgent())
  for (const name of ['bash', 'read', 'job_output', 'subagent_codex']) {
    next.calls = 0
    const out = await handler({ ...exec, name, arguments: { provider: 'codex' } }, next)
    assert.equal(next.calls, 1, `${name} 应委托一次`)
    assert.equal(out, upstream, `${name} 必须原样返回 next() 的结果`)
  }
})

test('ordinary：subagent 不带 CLI provider 时 next() 委托（原有行为保持）', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const delegated = { isError: false, value: { kind: 'activation', subagentId: 'native-1' }, content: [] }
  const [handler, next] = executeHandler(ctx, delegated)
  const out = await handler({ ...makeExec(makeAgent()), name: 'subagent', arguments: { description: 'd', prompt: 'p', provider: 'spawn' } }, next)
  assert.equal(next.calls, 1)
  assert.equal(out, delegated)
})

test('ordinary：list_subagent_models 无参调用时把 CLI 目录追加到上游文本', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const [handler, next] = executeHandler(ctx, { isError: false, value: 'spawn — Spawn', content: [] })
  const out = await handler({ ...makeExec(makeAgent()), name: 'list_subagent_models', arguments: {} }, next)
  assert.equal(next.calls, 1, '必须先取上游目录再追加')
  assert.equal(out.isError, false)
  assert.match(out.value, /^spawn — Spawn\n/)
  assert.match(out.value, /codex — Codex CLI/)
  assert.match(out.value, /claude — Claude CLI/)
})

test('ordinary：上游 list_subagent_models 报错时原样透传，不拼接目录', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const failure = { isError: true, error: { message: 'boom' }, content: [] }
  const [handler, next] = executeHandler(ctx, failure)
  const out = await handler({ ...makeExec(makeAgent()), name: 'list_subagent_models', arguments: {} }, next)
  assert.equal(out, failure)
})

test('ordinary：list_subagent_models 带具体 provider/model 时走 CLI 目录而非上游', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const [handler, next] = executeHandler(ctx, { isError: false, value: 'upstream', content: [] })
  const out = await handler({ ...makeExec(makeAgent()), name: 'list_subagent_models', arguments: { provider: 'codex', model: 'gpt-5-codex' } }, next)
  assert.equal(next.calls, 0, 'CLI provider/model 查询必须短路，不去问上游')
  assert.match(out.value, /gpt-5-codex/)
  assert.match(out.value, /Reasoning efforts/)
})

test('ordinary：list_subagent_models 带非 CLI provider 时仍委托上游（不劫持 spawn/fork 目录）', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const delegated = { isError: false, value: 'spawn models', content: [] }
  const [handler, next] = executeHandler(ctx, delegated)
  const out = await handler({ ...makeExec(makeAgent()), name: 'list_subagent_models', arguments: { provider: 'spawn' } }, next)
  assert.equal(next.calls, 1)
  assert.equal(out, delegated)
})

// ── B. 开关组合 ──────────────────────────────────────────────────────────────

test('开关：global=false 且 eng=false → 不短路，且 CLI provider 请求被 guard 明确拒绝（而非静默落到 spawn）', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: false, eng: false }), makeSessions())
  const delegated = { isError: false, value: 'native', content: [] }
  const [handler, next] = executeHandler(ctx, delegated)
  for (const preset of ['eng', 'eng-ptc', 'standard']) {
    next.calls = 0
    const out = await handler({ ...makeExec(makeAgent({ preset })), name: 'subagent', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }, next)
    assert.equal(out, delegated, `${preset}：开关全关时必须保持原生行为`)
    assert.equal(next.calls, 1)
    const reasons = guardReasons(ctx, { name: 'subagent', agent: makeAgent({ preset }) }, { provider: 'codex' })
    assert.equal(reasons.length, 1, `${preset}：显式请求 CLI provider 但未启用时必须给出可读拒绝`)
    assert.match(reasons[0], /disabled/)
  }
  assert.deepEqual(guardReasons(ctx, { name: 'subagent', agent: makeAgent({ preset: 'eng' }) }, { provider: 'spawn' }), [], '原生 provider 不受影响')
})

test('开关：global=true 覆盖包括 standard 在内的所有预设', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: true }), makeSessions({
    'child-1': { version: 1, id: 'child-1', parentId: 'parent-1', cli: 'codex', cwd: '/tmp/x', executable: 'codex', profile: '', model: 'gpt-5-codex', effort: 'low', delivered: [] },
  }))
  const [handler, next] = executeHandler(ctx)
  for (const preset of ['eng', 'eng-ptc', 'standard']) {
    next.calls = 0
    const out = await handler({ ...makeExec(makeAgent({ preset })), name: 'subagent', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }, next)
    assert.equal(next.calls, 0, `${preset}：global 开启时不得委托原生路径`)
    assert.equal(out.value.kind, 'activation')
  }
})

test('开关：eng=true 只覆盖 eng / eng-ptc 两个预设', async () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: false, eng: true }), makeSessions({
    'child-1': { version: 1, id: 'child-1', parentId: 'parent-1', cli: 'codex', cwd: '/tmp/x', executable: 'codex', profile: '', model: 'gpt-5-codex', effort: 'low', delivered: [] },
  }))
  const [handler, next] = executeHandler(ctx)
  for (const preset of ['eng', 'eng-ptc']) {
    next.calls = 0
    const out = await handler({ ...makeExec(makeAgent({ preset })), name: 'subagent', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }, next)
    assert.equal(next.calls, 0, `${preset} 预设应被接管`)
    assert.equal(out.value.kind, 'activation')
  }
  const delegated = { isError: false, value: 'native', content: [] }
  const [handler2, next2] = executeHandler(ctx, delegated)
  const out = await handler2({ ...makeExec(makeAgent({ preset: 'standard' })), name: 'subagent', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }, next2)
  assert.equal(out, delegated, '非 eng 预设不应被接管')
})

test('开关：守卫只拒绝「已禁用路径」且不影响原生 provider', () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: false, eng: true }), makeSessions())
  assert.deepEqual(guardReasons(ctx, { name: 'subagent', agent: makeAgent({ preset: 'eng' }) }, { provider: 'codex' }), [], 'eng 预设启用时拒绝原因清零（execute 负责真正分流）')
  assert.deepEqual(guardReasons(ctx, { name: 'subagent', agent: makeAgent({ preset: 'standard' }) }, { provider: 'spawn' }), [], '原生 provider 永不因 CLI 开关被拦')
})

test('开关：systemPrompt 段在开关关闭或目录为空时渲染空串，开启时含用法', () => {
  const off = makeCtx()
  installCliRouting(off, makeConfig({ global: false, eng: false }), makeSessions())
  const section = off.sections[0]
  assert.equal(section.name, 'apollo:cli-subagents')
  assert.equal(section.text({ agent: makeAgent({ preset: 'eng' }) }), '')

  const on = makeCtx()
  installCliRouting(on, makeConfig(), makeSessions())
  const text = on.sections[0].text({ agent: makeAgent() })
  assert.match(text, /provider="codex"/)
  assert.match(text, /provider="claude"/)
  assert.match(text, /background/)
  assert.match(text, /send_message/)
})

test('开关：systemPrompt 段在无 agent 时不抛错并渲染空串', () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: false, eng: false }), makeSessions())
  assert.doesNotThrow(() => ctx.sections[0].text({ session: { id: 'x' } }))
  assert.equal(ctx.sections[0].text({ session: { id: 'x' } }), '')
})

// ── C. CLI 只后台 / fork 拒绝 ────────────────────────────────────────────────

test('只后台：显式传 run_in_background（true 或 false）都明确报「已移除」，不静默忽略', async () => {
  const ctx = makeCtx()
  for (const value of [true, false]) {
    const sessions = makeSessions()
    await assert.rejects(
      () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p', run_in_background: value }, { agent: makeAgent(), signal: new AbortController().signal }),
      /run_in_background was removed/,
      `run_in_background=${value} 必须报已移除，而不是被忽略`,
    )
    assert.deepEqual(sessions.calls, [], '拒绝时必须未落任何持久化记录')
  }
  assert.deepEqual(ctx.workingDirectory.ensured, [], '参数校验失败不得去查目录')
})

test('只后台：省略 run_in_background 时照常后台创建（输出 kind=activation）', async () => {
  const started = []
  const ctx = makeCtx({
    subagents: {
      startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm1' } },
    },
  })
  const sessions = makeSessions()
  const out = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.equal(out.kind, 'activation')
  assert.equal(out.subagentId, started[0].childId)
  assert.equal(started.length, 1)
})

test('agent_preset：CLI 本轮不支持，显式传入必须明确报不支持且不落盘', async () => {
  const ctx = makeCtx()
  for (const provider of ['codex', 'claude']) {
    const sessions = makeSessions()
    await assert.rejects(
      () => startCliSubagent(ctx, makeConfig(), sessions, { provider, description: 'd', prompt: 'p', agent_preset: 'eng' }, { agent: makeAgent(), signal: new AbortController().signal }),
      /agent_preset is not supported/,
      `${provider} 显式传 agent_preset 必须明确报不支持`,
    )
    assert.deepEqual(sessions.calls, [], '拒绝时必须未落任何持久化记录')
  }
})

test('fork 拒绝：subagent_fork 带 CLI provider 或父路由为内部 CLI 时被 guard 拦下', () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  const withProvider = guardReasons(ctx, { name: 'subagent_fork', agent: makeAgent() }, { provider: 'claude' })
  assert.equal(withProvider.length, 1)
  assert.match(withProvider[0], /background/)

  const inherited = guardReasons(ctx, { name: 'subagent_fork', agent: makeAgent({ provider: 'apollo-cli-codex' }) }, {})
  assert.equal(inherited.length, 1)

  const ordinary = guardReasons(ctx, { name: 'subagent_fork', agent: makeAgent({ provider: 'spawn' }) }, {})
  assert.deepEqual(ordinary, [])
})

test('fork 拒绝：subagent_fork 即使开关关闭也拦内部 CLI 父路由（避免跨 provider 误建）', () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig({ global: false, eng: false }), makeSessions())
  const reasons = guardReasons(ctx, { name: 'subagent_fork', agent: makeAgent({ provider: 'apollo-cli-claude' }) }, {})
  assert.equal(reasons.length, 1)
})

test('内部路由保留：把内部 adapter 名当 provider 传会被显式拒绝', () => {
  const ctx = makeCtx()
  installCliRouting(ctx, makeConfig(), makeSessions())
  for (const provider of ['apollo-cli-codex', 'apollo-cli-claude']) {
    const reasons = guardReasons(ctx, { name: 'subagent', agent: makeAgent() }, { provider })
    assert.equal(reasons.length, 1, `${provider} 应被拒绝`)
    assert.match(reasons[0], /reserved/)
  }
})

// ── D. 白名单（模型 / effort / backend 开关）─────────────────────────────────

test('白名单：backend 关闭时拒绝', async () => {
  const ctx = makeCtx()
  const config = makeConfig({ codex: { enabled: false } })
  await assert.rejects(() => startCliSubagent(ctx, config, makeSessions(), { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }), /disabled/)
})

test('白名单：不在 allowed models 里的模型被拒且不落盘', async () => {
  const ctx = makeCtx()
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p', model: 'gpt-9-evil' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /not allowed/,
  )
  assert.deepEqual(sessions.calls, [])
})

test('白名单：模型不允许的 effort 被拒；允许的 effort 落到 agentOptions', async () => {
  const started = []
  const ctx = makeCtx({ subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } } })
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'codex', description: 'd', prompt: 'p', model: 'gpt-5-codex-mini', reasoning_effort: 'high' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /effort/,
  )
  await startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'codex', description: 'd', prompt: 'p', model: 'gpt-5-codex', reasoning_effort: 'high' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.equal(started[0].request.agentOptions.reasoningEffort, 'high')
  assert.equal(started[0].request.agentOptions.provider, 'apollo-cli-codex')
  assert.equal(started[0].request.agentOptions.model, 'gpt-5-codex')
})

test('白名单：省略 model/effort 时使用默认档', async () => {
  const started = []
  const ctx = makeCtx({ subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } } })
  await startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'claude', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.equal(started[0].request.agentOptions.model, 'sonnet')
  assert.equal(started[0].request.agentOptions.reasoningEffort, 'low')
})

test('cliCatalog：目录只列 enabled 的 backend，且模型清单来自白名单', () => {
  const config = makeConfig({ codex: { enabled: false } })
  assert.doesNotMatch(cliCatalog(config), /codex/)
  assert.match(cliCatalog(config), /claude/)
  assert.match(cliCatalog(config, { provider: 'claude' }), /sonnet/)
  assert.throws(() => cliCatalog(config, { provider: 'codex' }), /disabled/)
  assert.throws(() => cliCatalog(config, { provider: 'claude', model: 'nope' }), /not allowed/)
  const efforts = cliCatalog(config, { provider: 'claude', model: 'sonnet' })
  assert.match(efforts, /low \(default\)/)
  assert.match(efforts, /max/)
})

// ── E. 稳定 ID 持久化与原生 manager 参数 ─────────────────────────────────────

test('稳定 ID：先落 KV 再 startActivation，childId 与记录 id 一致', async () => {
  const order = []
  const sessions = makeSessions()
  const ctx = makeCtx({
    subagents: {
      startActivation: async (spec) => {
        order.push(['start', sessions.records.has(spec.childId)])
        return { childId: spec.childId, messageId: 'm' }
      },
    },
  })
  const out = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'desc', prompt: 'do it' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.deepEqual(order, [['start', true]], 'startActivation 时稳定 id 必须已在 KV')
  assert.equal(sessions.has(out.subagentId), true)
  const record = sessions.get(out.subagentId)
  assert.equal(record.parentId, 'parent-1')
  assert.equal(record.cli, 'codex')
  assert.equal(record.cwd, '/tmp/apollo-work')
  assert.equal(record.started, false, '创建阶段不置 started')
  assert.deepEqual(record.delivered, [])
  assert.match(out.subagentId, /^[a-zA-Z0-9_-]+$/)
})

test('稳定 ID：两个子代理得到不同 id，互不覆盖', async () => {
  const ctx = makeCtx({ subagents: { startActivation: async (spec) => ({ childId: spec.childId, messageId: 'm' }) } })
  const sessions = makeSessions()
  const a = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'a', prompt: 'a' }, { agent: makeAgent(), signal: new AbortController().signal })
  const b = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'claude', description: 'b', prompt: 'b' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.notEqual(a.subagentId, b.subagentId)
  assert.equal(sessions.has(a.subagentId) && sessions.has(b.subagentId), true)
})

test('原生 manager 参数：provider 恒为 spawn，prompt/label/maxDepth 逐项传递', async () => {
  const started = []
  const ctx = makeCtx({
    subagents: {
      resolveMaxDepth: () => 3,
      startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } },
    },
  })
  const agent = makeAgent()
  await startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'codex', description: 'label-here', prompt: 'prompt-here' }, { agent, signal: new AbortController().signal })
  const spec = started[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'label-here')
  assert.equal(spec.delivery, 'parent', '结果必须送回父 Agent（0.2.1 的显式投递策略）')
  assert.equal(spec.request.parent, agent)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'prompt-here' }])
  assert.equal(spec.request.maxDepth, 3)
  assert.equal(spec.request.cwd, '/tmp/apollo-work')
  assert.equal(Object.hasOwn(spec.request, 'signal'), false, 'spec.request 不重复携带 signal')
  assert.equal(Object.hasOwn(spec.request, 'label'), false, 'spec.request 不重复携带 label')
  assert.equal(spec.signal instanceof AbortSignal, true)
})

test('原生 manager 参数：resolveMaxDepth 返回 undefined 时不传 maxDepth（交给宿主默认）', async () => {
  const started = []
  const ctx = makeCtx({ subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } } })
  await startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.equal(Object.hasOwn(started[0].request, 'maxDepth'), false)
})

test('cwd：父 Agent 当前目录取自 workingDirectory.ensure，与 header.cwd 不同时以它为准', async () => {
  const started = []
  const workingDirectory = makeWorkingDirectory({ current: '/tmp/apollo-current' })
  const ctx = makeCtx({
    workingDirectory,
    subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } },
  })
  const sessions = makeSessions()
  const agent = makeAgent({ cwd: '/tmp/apollo-stale-header' })
  const signal = new AbortController().signal
  const out = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent, signal })
  assert.equal(workingDirectory.ensured.length, 1, '必须向 working-directory 服务要当前目录')
  assert.equal(workingDirectory.ensured[0].agent, agent)
  assert.equal(workingDirectory.ensured[0].signal, signal)
  assert.equal(sessions.get(out.subagentId).cwd, '/tmp/apollo-current', 'KV 记录当前目录，而不是过时的 header.cwd')
  assert.equal(started[0].request.cwd, '/tmp/apollo-current', 'request.cwd 固定同一个绝对目录')
})

test('cwd：绝对 args.cwd 直接使用，完全不去查父目录（不调用 ensure）', async () => {
  const started = []
  const workingDirectory = makeWorkingDirectory({ current: '/tmp/apollo-current' })
  const ctx = makeCtx({
    workingDirectory,
    subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } },
  })
  const sessions = makeSessions()
  const out = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p', cwd: '/tmp/explicit-dir' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.deepEqual(workingDirectory.ensured, [], '显式绝对目录不需要 ensure')
  assert.equal(sessions.get(out.subagentId).cwd, '/tmp/explicit-dir')
  assert.equal(started[0].request.cwd, '/tmp/explicit-dir')
})

test('cwd：相对 args.cwd 相对 workingDirectory 的当前目录解析（不相对 header.cwd）', async () => {
  const started = []
  const workingDirectory = makeWorkingDirectory({ current: '/tmp/apollo-current' })
  const ctx = makeCtx({
    workingDirectory,
    subagents: { startActivation: async (spec) => { started.push(spec); return { childId: spec.childId, messageId: 'm' } } },
  })
  const sessions = makeSessions()
  const out = await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p', cwd: 'kid' }, { agent: makeAgent({ cwd: '/tmp/apollo-stale-header' }), signal: new AbortController().signal })
  assert.equal(workingDirectory.ensured.length, 1)
  assert.equal(sessions.get(out.subagentId).cwd, '/tmp/apollo-current/kid')
  assert.equal(started[0].request.cwd, '/tmp/apollo-current/kid', 'manager 收到的必须是解析后的绝对目录')
})

test('cwd：ensure 返回非绝对目录时拒绝且不落盘', async () => {
  const ctx = makeCtx({ workingDirectory: makeWorkingDirectory({ current: 'relative/dir' }) })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /absolute/,
  )
  assert.deepEqual(sessions.calls, [])
})

test('cwd：workingDirectory.ensure 失败（原项目也不可用）→ 原样抛错且不落盘', async () => {
  const ctx = makeCtx({ workingDirectory: makeWorkingDirectory({ failure: new Error('working directory is unavailable') }) })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /working directory is unavailable/,
  )
  assert.deepEqual(sessions.calls, [])
})

test('原生 manager 参数：缺 prompt/description 时报错且不落盘', async () => {
  const ctx = makeCtx()
  const sessions = makeSessions()
  const exec = { agent: makeAgent(), signal: new AbortController().signal }
  await assert.rejects(() => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd' }, exec), /prompt/)
  await assert.rejects(() => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', prompt: 'p' }, exec), /description/)
  assert.deepEqual(sessions.calls, [])
})

test('原生 manager 参数：未开启的 provider 名被拒（不落到 spawn）', async () => {
  const ctx = makeCtx()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'acp', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /Unknown Apollo CLI provider/,
  )
})

// ── F. 创建失败 / 取消的清理 ─────────────────────────────────────────────────

test('清理：startActivation 失败 → drain 稳定 id + 删除记录 + 原样抛错', async () => {
  const drained = []
  const ctx = makeCtx({
    subagents: {
      startActivation: async () => { throw new Error('spawn backend exploded') },
      drainChildren: async (parent, ids) => { drained.push([parent, [...ids]]) },
    },
  })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /spawn backend exploded/,
  )
  assert.equal(drained.length, 1)
  assert.equal(drained[0][0].id, 'parent-1')
  assert.equal(drained[0][1].length, 1)
  assert.equal(sessions.has(drained[0][1][0]), false, '失败必须删掉预落的记录')
})

test('清理：创建后立即中断 → drain created child 并抛 AbortError，记录被删', async () => {
  const drained = []
  const controller = new AbortController()
  let createdId
  const ctx = makeCtx({
    subagents: {
      startActivation: async (spec) => {
        createdId = spec.childId
        controller.abort(new Error('user interrupted'))
        return { childId: spec.childId, messageId: 'm' }
      },
      drainChildren: async (parent, ids) => { drained.push([...ids]) },
    },
  })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: controller.signal }),
    (error) => error.name === 'AbortError' || /interrupt/i.test(error.message),
  )
  assert.ok(createdId, 'startActivation 应已被调用')
  assert.ok(drained.length >= 1, 'created child 必须被 drain')
  for (const ids of drained) assert.deepEqual(ids, [createdId], 'drain 的必须是 startActivation 返回的 childId')
  assert.equal(sessions.has(createdId), false, '中断后必须删掉预落的记录')
})

test('清理：进入前已中断 → 不查目录、不落盘、不调用 startActivation', async () => {
  let called = false
  const controller = new AbortController()
  controller.abort()
  const ctx = makeCtx({ subagents: { startActivation: async () => { called = true; return { childId: 'x', messageId: 'm' } } } })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: controller.signal }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(called, false)
  assert.deepEqual(ctx.workingDirectory.ensured, [], '已中断时不得再查父目录')
  assert.deepEqual(sessions.calls, [])
})

test('清理：无调用 Agent 时直接报错（不允许无父委派）', async () => {
  const ctx = makeCtx()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), makeSessions(), { provider: 'codex', description: 'd', prompt: 'p' }, { agent: undefined, signal: new AbortController().signal }),
    /calling Agent/,
  )
})

// ── G. 可执行文件预检（创建前 resolveExecutable）────────────────────────────

test('可执行预检：缺失 → 不落 KV、不调用 startActivation、错误可读', async () => {
  let created = 0
  const ctx = makeCtx({
    subprocess: {
      resolveExecutable: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) },
    },
    subagents: { startActivation: async () => { created += 1; return { childId: 'x', messageId: 'm' } } },
  })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal }),
    /executable is unavailable/,
  )
  assert.equal(created, 0, '预检失败不得调用 manager')
  assert.deepEqual(sessions.calls, [], '预检失败不得落 KV')
})

test('可执行预检：`~/` 展开为 home，且解析后的绝对路径固化进记录', async () => {
  const ctx = makeCtx()
  const sessions = makeSessions()
  const config = makeConfig({ codex: { executable: '~/bin/codex' } })
  await startCliSubagent(ctx, config, sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
  assert.equal(ctx.resolved.length, 1, '应恰好解析一次')
  assert.match(ctx.resolved[0], /bin\/codex$/)
  assert.doesNotMatch(ctx.resolved[0], /^~/, '~ 必须先展开')
  const [record] = [...sessions.records.values()]
  assert.match(record.executable, /^\/resolved\//, '记录里必须是解析后的路径而非用户输入')
})

test('可执行预检：预检期间被中断 → 抛 AbortError（不是「可执行不可用」）', async () => {
  const controller = new AbortController()
  const ctx = makeCtx({
    subprocess: {
      resolveExecutable: async () => {
        controller.abort()
        throw new Error('aborted')
      },
    },
  })
  const sessions = makeSessions()
  await assert.rejects(
    () => startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: controller.signal }),
    (error) => error.name === 'AbortError',
  )
  assert.deepEqual(sessions.calls, [])
})

// ── G2. CLI home 固化 ───────────────────────────────────────────────────────

test('CLI home：codex 记录 CODEX_HOME，claude 记录默认 ~/.claude（env 缺失时也固化）', async () => {
  const savedCodex = process.env.CODEX_HOME
  const savedClaude = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  try {
    const ctx = makeCtx()
    const sessions = makeSessions()
    await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
    await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'claude', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
    const records = [...sessions.records.values()]
    const codex = records.find((r) => r.cli === 'codex')
    const claude = records.find((r) => r.cli === 'claude')
    assert.match(codex.cliHome, /\.codex$/)
    assert.match(claude.cliHome, /\.claude$/, 'claude 也必须固化一个 CLI home')
    assert.equal(claude.claudeDefaultHome, true, '默认模式必须独立记录，不能显式设置 CLAUDE_CONFIG_DIR')
    assert.equal(codex.claudeDefaultHome, undefined)
    assert.equal(claude.profile, '', 'claude 没有 profile 概念')
  } finally {
    if (savedCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodex
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
  }
})

test('CLI home：显式 env（CODEX_HOME / CLAUDE_CONFIG_DIR）优先于默认目录', async () => {
  const savedCodex = process.env.CODEX_HOME
  const savedClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.CODEX_HOME = '/tmp/codex-home'
  process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-home'
  try {
    const ctx = makeCtx()
    const sessions = makeSessions()
    await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'codex', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
    await startCliSubagent(ctx, makeConfig(), sessions, { provider: 'claude', description: 'd', prompt: 'p' }, { agent: makeAgent(), signal: new AbortController().signal })
    const records = [...sessions.records.values()]
    assert.equal(records.find((r) => r.cli === 'codex').cliHome, '/tmp/codex-home')
    assert.equal(records.find((r) => r.cli === 'claude').cliHome, '/tmp/claude-home')
    assert.equal(records.find((r) => r.cli === 'claude').claudeDefaultHome, undefined, '显式目录不能改成原生默认模式')
  } finally {
    if (savedCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodex
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedClaude
  }
})

// ── H. tools/result 回收未交付 child ────────────────────────────────────────

/** 触发一次 tools/result（installCliRouting 注册的监听器）。 */
function fireToolsResult(ctx, exec, result) {
  const listeners = ctx.handlersOf.get('tools/result')
  assert.ok(Array.isArray(listeners) && listeners.length > 0, 'installCliRouting 应注册 tools/result 监听器')
  for (const listener of listeners) listener(exec, result)
}

test('回收：被策略阻止（isError）→ drain 未交付 child 并删记录', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-1', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const out = await handler(exec, next)
  assert.equal(out.value.kind, 'activation')
  const id = out.value.subagentId
  fireToolsResult(ctx, exec, { isError: true, error: { message: 'blocked' }, content: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(drained, [[id]])
  assert.equal(sessions.has(id), false)
})

test('回收：结果被替换成别的 id → 也回收，且只回收一次（幂等）', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-2', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const out = await handler(exec, next)
  const id = out.value.subagentId
  fireToolsResult(ctx, exec, { isError: false, value: { kind: 'activation', subagentId: 'other-id' }, content: [] })
  fireToolsResult(ctx, exec, { isError: true, error: { message: 'again' }, content: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(drained, [[id]], '替换 id 时回收一次；重复通知不得再回收')
  assert.equal(sessions.has(id), false)
})

test('回收：成功的同 id 结果不回收（child 保留、记录保留）', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-3', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const out = await handler(exec, next)
  const id = out.value.subagentId
  fireToolsResult(ctx, exec, { isError: false, value: { kind: 'activation', subagentId: id }, content: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(drained, [], '成功接收 id 必须保留 child')
  assert.equal(sessions.has(id), true)
})

test('回收：与本次创建无关的 tools/result 不影响在册 child', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-4', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const out = await handler(exec, next)
  fireToolsResult(ctx, { token: 'unrelated' }, { isError: true, error: { message: 'x' }, content: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(drained, [])
  assert.equal(sessions.has(out.value.subagentId), true)
})

test('回收：只回收未被接收的那个 child，不误停 sibling', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  const stop = installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const first = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-s1', arguments: { provider: 'codex', description: 'a', prompt: 'a' } }
  const second = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-s2', arguments: { provider: 'codex', description: 'b', prompt: 'b' } }
  const one = (await handler(first, next)).value.subagentId
  const two = (await handler(second, next)).value.subagentId
  assert.notEqual(one, two)
  fireToolsResult(ctx, first, { isError: true, error: { message: 'blocked' }, content: [] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(drained, [[one]], '只回收被拒绝的那一个 child')
  assert.equal(sessions.has(one), false)
  assert.equal(sessions.has(two), true, 'sibling 记录必须保留')
  await stop()
  assert.deepEqual(drained, [[one], [two]], '卸载时只补收另一个未交付 child')
  assert.equal(sessions.has(two), false)
})

test('卸载：stopRouting 是 async，收尾时回收所有未收到结果的 child', async () => {
  const drained = []
  const ctx = makeCtx({ subagents: { drainChildren: async (parent, ids) => { drained.push([...ids]) } } })
  const sessions = makeSessions()
  const stopRouting = installCliRouting(ctx, makeConfig(), sessions)
  assert.equal(typeof stopRouting, 'function')
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'tok-5', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const out = await handler(exec, next)
  const stop = stopRouting()
  assert.equal(typeof stop?.then, 'function', 'stopRouting 必须返回可 await 的 promise')
  await stop
  assert.deepEqual(drained, [[out.value.subagentId]])
  assert.equal(sessions.has(out.value.subagentId), false)
})

test('卸载：等待在途创建回滚，且之后拒绝新创建', async () => {
  let release
  let signal
  let entered
  const arrived = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = makeCtx({ subprocess: { resolveExecutable: async (_command, _env, current) => {
    signal = current
    entered()
    await gate
    return '/bin/codex'
  } } })
  const sessions = makeSessions()
  const stop = installCliRouting(ctx, makeConfig(), sessions)
  const [handler, next] = executeHandler(ctx)
  const exec = { ...makeExec(makeAgent()), name: 'subagent', token: 'inflight', arguments: { provider: 'codex', description: 'd', prompt: 'p' } }
  const pending = handler(exec, next)
  const failed = assert.rejects(pending, /routing unloaded/)
  await arrived
  let stopped = false
  const stopping = stop().then(() => { stopped = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(signal.aborted, true)
  assert.equal(stopped, false)
  release()
  await Promise.all([failed, stopping])
  assert.equal(sessions.records.size, 0)
  await assert.rejects(handler(exec, next), /routing unloaded/)
})

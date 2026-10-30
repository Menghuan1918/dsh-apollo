/**
 * Apollo 0.5.x real-profile integration smoke.
 *
 * Boots an isolated headless DSH profile from the installed runtime
 * (DSH_PACKAGE_ROOT), Apollo's shipped files and the three independent plugin
 * packages, with a scripted LLM adapter (no credentials, no real CLI):
 *
 *   apollo     — Apollo + both independent rows. One stable row each, real
 *                eng session turn, native subagent create/wait, manual
 *                /compact through dsh-better-compact's engine, HTTP inspect,
 *                old-Apollo config migration, save → requiresReload → profile
 *                restart → activeConfig update.
 *   standalone — the two independent bundles without Apollo.
 *   both       — Apollo and the standalone bundles selected explicitly:
 *                Loader still activates one row each, but configEditor/
 *                settings cannot address the duplicated rows (DSH 0.2.1-rc.2
 *                unaddressable/read-only limitation).
 *
 * Run: DSH_PACKAGE_ROOT=… node scripts/runtime-smoke.mjs <apollo|standalone|both|all>
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  authenticate,
  bootProfile,
  dshRoot,
  hostPackage,
  prepareProfile,
  rowCounts,
  waitUntil,
  COMPACT_NAME,
  SUBAGENT_NAME,
} from './lib/profile.mjs'

const mode = process.argv[2] ?? 'apollo'
assert.ok(['apollo', 'standalone', 'both', 'all'].includes(mode), 'mode must be apollo, standalone, both or all')
if (mode === 'all') {
  const { spawnSync } = await import('node:child_process')
  for (const one of ['apollo', 'standalone', 'both']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), one], { stdio: 'inherit', env: process.env })
    assert.equal(result.status, 0, `${one} scenario failed`)
  }
  process.exit(0)
}

const dsh = dshRoot()
const llm = await import(hostPackage('dsh-llm/lib/index.js'))
const createMessage = llm.createUserMessage
assert.equal(typeof createMessage, 'function', 'dsh-llm must export createUserMessage')

const checks = []
const check = (name) => { checks.push(name); console.log('CHECK', name) }
const results = { mode, dsh: JSON.parse(await readFile(join(dsh, 'package.json'), 'utf8')).version, checks, passed: false }

const GOAL_TEMPLATE = [
  '# Goal checkpoint',
  '## Current Goal and Unresolved Requests',
  '- smoke goal',
  '## Constraints, Preferences, and Approved Boundaries',
  '- constraints',
  '## Decisions and Reasons',
  '- decision',
  '## Completed Work',
  '- verified turn output',
  '## In Progress',
  '- smoke',
  '## Blocked, Pending, and Unverified',
  '- unverified',
  '## Key References',
  '- file: package.json',
  '## Next Actions',
  '- finish the smoke',
].join('\n')

/** Last user text block, matching how the scripted provider inspects a request. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    return (blocks ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  }
  return ''
}

/** A scripted tool call. */
function* toolCall(name, args) {
  const id = `smoke-${randomUUID()}`
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Scripted provider: normal turns echo a fixed text, compaction returns the goal structure. */
function makeAdapter(state) {
  const info = { provider: 'it-noop', id: 'noop', name: 'Noop', inputModalities: ['text'] }
  const adapter = {
    providerInfo: (id) => ({ id, name: 'Apollo integration scripted adapter' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [info],
    resolveModel: async (provider, id) => ({
      provider, id, name: id, inputModalities: ['text'],
      context: { contextWindow: 200000 }, defaultMaxTokens: 64,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    }),
    async prepareCall(provider, model) {
      return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) }
    },
    async *stream(options) {
      if (options.purpose === 'compaction') {
        state.compactions += 1
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: state.summaryText ?? GOAL_TEMPLATE } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      state.calls += 1
      const userText = lastUserText(options.messages ?? [])
      // Real-host job exit guard: start a background job, then react to the
      // injected Apollo notice by killing it so the turn can finish.
      if (state.jobGuard !== undefined) {
        if (state.jobGuard.phase === 'start') {
          state.jobGuard.phase = 'waiting'
          yield* toolCall('bash', { command: 'sleep 30', description: 'exit guard smoke job', run_in_background: true })
          return
        }
        if (state.jobGuard.phase === 'waiting' && userText.includes('This background work is still running')) {
          state.jobGuard.guardSeen = true
          state.jobGuard.phase = 'killing'
          state.jobGuard.jobId = /background job (\S+)/.exec(userText)?.[1]
          yield* toolCall('job_kill', { job_id: state.jobGuard.jobId })
          return
        }
      }
      const text = state.normalText ?? 'Smoke response.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return adapter
}

/** Record session events for one agent. */
function record(ctx, agent) {
  const events = []
  const waiters = new Set()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.id) return
    events.push(event)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  })
  return {
    events,
    waitFor(predicate, label = 'event', timeout = 20_000) {
      return new Promise((resolvePromise, reject) => {
        const waiter = { predicate, resolve: resolvePromise }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`timed out waiting for ${label}; saw ${events.map((event) => event.type).join(',')}`))
        }, timeout)
        waiters.add(waiter)
      })
    },
    count(type) { return events.filter((event) => event.type === type).length },
    dispose() { off() },
  }
}

async function createAgent(ctx, { preset } = {}) {
  const created = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: join(process.env.DSH_HOME, 'workspace') },
    agentOptions: { provider: 'it-noop', model: 'noop' },
    setup: preset === undefined ? async () => {} : async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) },
  })
  return created.agent
}

async function runTurn(agent, recorder, text) {
  const pending = recorder.waitFor((event) => event.type === 'turn/end', 'turn/end')
  agent.followup(createMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  const end = await pending
  assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end.data))
  await agent.whenIdle()
}

async function call(ctx, agent, name, args) {
  const result = await ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal })
  assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
  return result.value
}

async function inspectHttp(ctx, cookie, sessionId) {
  const origin = ctx.get('webServer').getOrigin()
  const suffix = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  const response = await fetch(`${origin}/better-compact/api/inspect${suffix}`, { headers: { cookie } })
  const body = await response.json().catch(() => undefined)
  return { status: response.status, body }
}

function assertOneRow(counts, id) {
  assert.equal(counts.get(id), 1, `${id} must have exactly one active Loader entry; got ${counts.get(id)}`)
}

const OLD_APOLLO = {
  exitGuard: true,
  tiers: { fast: { provider: 'old-fast', model: 'old-fast-model', reasoningEffort: 'low' } },
  subagents: { eng: false, codex: { enabled: true, executable: 'codex-old', defaultModel: 'gpt-old', models: [{ id: 'gpt-old', efforts: ['low'], defaultEffort: 'low' }] } },
  trustedHosts: ['proxy.local'],
}
const TARGET_SUBAGENT = { tiers: { quality: { provider: 'target-quality', model: 'target-model', reasoningEffort: '' } }, subagents: { global: true, codex: { models: [] } } }
const TARGET_COMPACT = { mode: 'goal', auto: false, thresholdRatio: 0.55 }
const OLD_PRESET_PTC = {
  id: 'eng-ptc', name: '工程(PTC)模式', description: 'legacy native compaction config', order: 11,
  plugins: [{ id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: true, thresholdRatio: 0.7, retainTokens: 4321, maxTokens: 256, compactionRetries: 2, maxOverflowRetries: 0 } }] }],
}

/** Rows shared by every scenario: no headless one-shot, real webserver/connection. */
function basePatch(extra = []) {
  return [
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { id: 'workflow-ptc', disabled: true },
    { id: 'tool-workflow', disabled: true },
    { id: 'credentials', disabled: false, config: { watch: false } },
    ...extra,
    { insert: [
      { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0, compression: 'none' } },
      { id: 'connection', name: '@deepseek-ai/dsh-client-connection', config: { trustedHosts: [], cookieMaxAgeDays: 30 } },
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [{ provider: 'it-noop', model: 'noop' }] } },
    ] },
  ]
}

async function scenarioApollo() {
  const info = await prepareProfile({
    bundles: ['@menghuan1918/dsh-apollo'],
    patch: basePatch([
      { id: 'apollo-skills', config: OLD_APOLLO },
      { id: 'dsh-better-subagent', config: TARGET_SUBAGENT },
      { id: 'dsh-better-compact', config: TARGET_COMPACT },
      { id: 'preset-eng-ptc', config: OLD_PRESET_PTC },
      { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng-ptc' } }] },
    ]),
    prefix: 'apollo-smoke-',
  })
  const state = { calls: 0, compactions: 0, normalText: 'x'.repeat(900) }
  let ctx
  let cookie
  try {
    ctx = await bootProfile(info)
    await mkdir(join(info.home, 'workspace'), { recursive: true })
    ctx.llm.registerAdapter(['it-noop'], makeAdapter(state))
    cookie = await authenticate(ctx)

    // ── one stable row instance each ────────────────────────────────────────
    const counts = rowCounts(ctx)
    for (const id of ['dsh-better-goal', 'dsh-better-compact', 'dsh-better-compact-engine', 'dsh-better-subagent', 'apollo-skills']) assertOneRow(counts, id)
    const editable = new Set(ctx.configEditor.entries().map((entry) => entry.options.id))
    for (const id of ['dsh-better-subagent', 'dsh-better-compact', 'dsh-better-compact-engine']) assert.ok(editable.has(id), `${id} must be addressable when only Apollo is selected`)
    assert.ok(ctx.compaction, 'the host-plane compaction engine must be mounted')
    assert.equal(ctx.compaction.constructor.name, 'BetterCompactEngine')
    check('apollo-one-row-each')

    // ── migration from the old Apollo row / native preset config ────────────
    await waitUntil(async () => {
      const rows = await ctx.settings.describe()
      const subagent = rows.find((row) => row.ns === 'dsh-better-subagent')
      const compact = rows.find((row) => row.ns === 'dsh-better-compact')
      return subagent?.value?.childExitGuard === true && compact?.value?.retainTokens === 4321
    }, 'old config migration', 15_000)
    const migrated = await ctx.settings.describe()
    const subagent = migrated.find((row) => row.ns === 'dsh-better-subagent')
    const compact = migrated.find((row) => row.ns === 'dsh-better-compact')
    assert.equal(subagent.value.tiers.fast.provider, 'old-fast')
    assert.deepEqual(subagent.value.tiers.quality, { provider: 'target-quality', model: 'target-model', reasoningEffort: '' })
    assert.equal(subagent.value.subagents.eng, false)
    assert.equal(subagent.value.subagents.global, true, 'target explicit scope wins')
    assert.deepEqual(subagent.value.subagents.codex.models, [], 'target explicit empty list wins')
    assert.equal(compact.value.thresholdRatio, 0.55, 'target explicit threshold wins')
    assert.equal(compact.value.retainTokens, 4321)
    assert.equal(compact.value.auto, false)
    const target = ctx.configEditor.entries().find((entry) => entry.options.id === 'dsh-better-subagent')
    assert.deepEqual(target.options.config.trustedHosts, ['proxy.local'], 'trustedHosts migrated through configEditor')
    check('old-config-migration')

    // Migration persists volatile settings but cannot replace the engine's
    // frozen load-time snapshot; prove a profile restart applies them.
    await ctx.fiber.dispose()
    ctx = await bootProfile(info)
    ctx.llm.registerAdapter(['it-noop'], makeAdapter(state))
    cookie = await authenticate(ctx)
    const migratedSnapshot = (await inspectHttp(ctx, cookie)).body
    assert.equal(migratedSnapshot.requiresReload, false)
    assert.equal(migratedSnapshot.activeConfig.retainTokens, 4321)
    assert.equal(migratedSnapshot.activeConfig.auto, false)
    check('reload-applies-migrated-config')

    // ── real eng prompt + turn ──────────────────────────────────────────────
    const agent = await createAgent(ctx, { preset: 'eng' })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const names = assembly.sections.map((section) => section.name)
    assert.ok(names.includes('eng:mode-instructions'))
    assert.ok(names.includes('better-subagent:delegation'))
    assert.equal(names.filter((name) => name === 'better-subagent:delegation').length, 1, 'one delegation source')
    const recorder = record(ctx, agent)
    await runTurn(agent, recorder, 'Run the integration smoke turn.')
    check('eng-turn-and-prompt')

    // ── native subagent create → wait ───────────────────────────────────────
    assert.ok(ctx.tools.get('wait_subagent', agent), 'the independent wait tool is visible')
    const activation = await call(ctx, agent, 'subagent', { description: 'smoke child', prompt: 'Reply once.' })
    assert.equal(activation.kind, 'activation')
    const waited = await call(ctx, agent, 'wait_subagent', { subagent_id: [activation.subagentId] })
    assert.match(waited, new RegExp(`subagent ${activation.subagentId} done \\(completed\\)`))
    await agent.whenIdle()
    check('native-subagent-create-wait')

    // ── manual /compact through the better-compact engine ───────────────────
    await runTurn(agent, recorder, 'More history one.')
    await runTurn(agent, recorder, 'More history two.')
    const before = recorder.count('compaction/start')
    const command = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
    assert.equal(command.result.kind, 'success', JSON.stringify(command))
    assert.equal(recorder.count('compaction/start'), before + 1)
    const start = [...recorder.events].reverse().find((event) => event.type === 'compaction/start')
    const id = start.data.compactionId
    assert.ok(recorder.events.some((event) => event.type === 'compaction/summary' && event.data.compactionId === id))
    assert.ok(recorder.events.some((event) => event.type === 'compaction/end' && event.data.compactionId === id))
    const inspected = await inspectHttp(ctx, cookie, agent.id)
    assert.equal(inspected.status, 200)
    assert.equal(inspected.body.engine.owner, 'better-compact-preset')
    assert.equal(inspected.body.lastCompaction.status, 'completed')
    assert.equal(inspected.body.lastCompaction.mode, 'goal')
    assert.equal(inspected.body.activeConfig.mode, 'goal')
    assert.equal(inspected.body.requiresReload, false)
    check('manual-compact-and-inspect')

    // ── real-host background-job exit guard ────────────────────────────────
    const apolloRow = (await ctx.settings.describe()).find((entry) => entry.ns === 'apollo-skills')
    await ctx.settings.update('apollo-skills', { exitGuard: true }, apolloRow.revision)
    const guardAgent = await createAgent(ctx, { preset: 'eng' })
    const guardRecorder = record(ctx, guardAgent)
    state.jobGuard = { phase: 'start', guardSeen: false, jobId: undefined }
    try {
      await runTurn(guardAgent, guardRecorder, 'Start a background job for the exit guard smoke.')
      assert.equal(state.jobGuard.guardSeen, true, 'the job guard notice must reach the model')
      assert.ok(state.jobGuard.jobId, 'the notice names the running job')
      assert.ok(guardRecorder.events.some((event) => event.type === 'user/message'
        && event.data?.source?.kind === 'better-apollo-job-exit-guard'), 'the guard notice is durably logged with its producer kind')
      await waitUntil(() => ctx.get('jobs').list(guardAgent.id)
        .every((job) => ['completed', 'killed', 'failed'].includes(job.status)), 'background job to settle', 5_000)
    } catch (error) {
      const { currentConfig } = await import('../src/config.js')
      results.jobGuard = {
        state: state.jobGuard,
        exitGuard: currentConfig(ctx).exitGuard,
        jobs: ctx.get('jobs').list(guardAgent.id).map((job) => ({
          ...job, output: ctx.get('jobs').readAt(job.id, 0, guardAgent.id),
        })),
        events: guardRecorder.events.filter((event) => ['tool/call', 'tool/result', 'turn/end'].includes(event.type)
          || (event.type === 'user/message' && event.data?.source?.kind === 'better-apollo-job-exit-guard')),
        eventTypes: guardRecorder.events.map((event) => event.type),
      }
      throw error
    } finally {
      state.jobGuard = undefined
      const again = (await ctx.settings.describe()).find((entry) => entry.ns === 'apollo-skills')
      await ctx.settings.update('apollo-skills', { exitGuard: false }, again.revision)
      guardRecorder.dispose()
    }
    check('job-exit-guard-real-host')

    // ── save → requiresReload → profile restart → activeConfig ──────────────
    const row = (await ctx.settings.describe()).find((entry) => entry.ns === 'dsh-better-compact')
    await ctx.settings.update('dsh-better-compact', { mode: 'native' }, row.revision)
    await waitUntil(async () => (await inspectHttp(ctx, cookie)).body.requiresReload === true, 'requiresReload after save', 5_000)
    const pending = (await inspectHttp(ctx, cookie)).body
    assert.equal(pending.activeConfig.mode, 'goal', 'a running engine keeps its frozen snapshot')
    recorder.dispose()
    await ctx.fiber.dispose()
    ctx = undefined
    ctx = await bootProfile(info)
    ctx.llm.registerAdapter(['it-noop'], makeAdapter(state))
    cookie = await authenticate(ctx)
    const reloaded = (await inspectHttp(ctx, cookie)).body
    assert.equal(reloaded.requiresReload, false)
    assert.equal(reloaded.activeConfig.mode, 'native', 'profile restart applies the saved engine snapshot')
    check('save-requires-reload-restart-active-config')

    results.passed = true
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function scenarioStandalone() {
  const info = await prepareProfile({
    bundles: [SUBAGENT_NAME, COMPACT_NAME],
    patch: basePatch([
      { id: 'dsh-better-subagent', config: { subagents: { global: true } } },
      { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'better-compact' } }] },
    ]),
    prefix: 'apollo-standalone-',
  })
  const state = { calls: 0, compactions: 0, normalText: 's'.repeat(900) }
  let ctx
  try {
    ctx = await bootProfile(info)
    await mkdir(join(info.home, 'workspace'), { recursive: true })
    ctx.llm.registerAdapter(['it-noop'], makeAdapter(state))
    const cookie = await authenticate(ctx)
    const counts = rowCounts(ctx)
    for (const id of [COMPACT_NAME, 'dsh-better-compact-engine', 'dsh-better-subagent']) assertOneRow(counts, id)
    assert.equal(counts.get('apollo-skills') ?? 0, 0, 'Apollo must not be loaded')
    assert.equal(ctx.configEditor.entries().some((entry) => entry.options.id === 'apollo-skills'), false)
    const presets = await ctx.agentPresets.list()
    assert.ok(presets.some((preset) => preset.id === 'better-compact'), JSON.stringify(presets))
    const agent = await createAgent(ctx)
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const names = assembly.sections.map((section) => section.name)
    assert.ok(names.includes('better-subagent:delegation'), 'global scope renders delegation without Apollo')
    assert.equal(names.includes('eng:mode-instructions'), false)
    assert.ok(ctx.tools.get('wait_subagent', agent))
    assert.ok(ctx.compaction, 'host-plane compact engine must be live')
    check('standalone-rows-and-prompt')

    const recorder = record(ctx, agent)
    await runTurn(agent, recorder, 'Standalone smoke turn one.')
    await runTurn(agent, recorder, 'Standalone smoke turn two.')
    await runTurn(agent, recorder, 'Standalone smoke turn three.')
    const command = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
    assert.equal(command.result.kind, 'success', JSON.stringify(command))
    assert.ok(recorder.count('compaction/start') >= 1)
    const inspected = await inspectHttp(ctx, cookie, agent.id)
    assert.equal(inspected.status, 200)
    assert.equal(inspected.body.engine.owner, 'host')
    assert.equal(inspected.body.lastCompaction.status, 'completed')
    check('standalone-manual-compact')
    recorder.dispose()
    results.passed = true
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function scenarioBoth() {
  const info = await prepareProfile({
    bundles: ['@menghuan1918/dsh-apollo', SUBAGENT_NAME, COMPACT_NAME],
    patch: basePatch([
      { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } }] },
    ]),
    prefix: 'apollo-both-',
  })
  let ctx
  try {
    ctx = await bootProfile(info)
    const counts = rowCounts(ctx)
    for (const id of ['dsh-better-compact', 'dsh-better-compact-engine', 'dsh-better-subagent', 'apollo-skills']) assertOneRow(counts, id)
    check('both-one-row-each')

    // DSH 0.2.1-rc.2 keeps the rows readable but cannot write a profile
    // override for an id inserted by two explicit bundle sources: configEditor
    // rejects the write as overridden. That is the documented unaddressable /
    // read-only limitation (the Web row manager label itself is UI-only and is
    // not exercised by this headless smoke).
    const rows = await ctx.settings.describe()
    for (const ns of ['dsh-better-compact', 'dsh-better-subagent']) {
      assert.ok(rows.some((row) => row.ns === ns), `${ns} stays readable`)
    }
    for (const [ns, patch] of [['dsh-better-subagent', { childExitGuard: true }], ['dsh-better-compact', { auto: false }]]) {
      await assert.rejects(
        () => ctx.settings.update(ns, patch),
        /overridden by a home patch or command-line overlay|No configurable plugin entry/,
        `${ns} must be read-only when two explicit bundles insert the same row`,
      )
    }
    check('both-read-only-write-limitation')

    // The single active instance still works.
    await mkdir(join(info.home, 'workspace'), { recursive: true })
    ctx.llm.registerAdapter(['it-noop'], makeAdapter({ calls: 0, compactions: 0 }))
    const agent = await createAgent(ctx, { preset: 'eng' })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    assert.equal(assembly.sections.filter((section) => section.name === 'better-subagent:delegation').length, 1)
    assert.ok(ctx.tools.get('wait_subagent', agent))
    assert.ok(ctx.compaction)
    check('both-single-effective-instance')
    results.passed = true
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

try {
  if (mode === 'apollo') await scenarioApollo()
  else if (mode === 'standalone') await scenarioStandalone()
  else await scenarioBoth()
  console.log('APOLLO_INTEGRATION_SMOKE_PASSED', JSON.stringify(results))
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error)
  console.error('APOLLO_INTEGRATION_SMOKE_FAILED', JSON.stringify(results, null, 2))
  process.exitCode = 1
}

/**
 * Real eng-ptc / Node PTC integration smoke; no credentials or current-host restart.
 * Run with APOLLO_PLUGIN_SOURCE_ROOT=/path/to/Code DSH_PACKAGE_ROOT=/path/to/@deepseek-ai/dsh
 *   node scripts/ptc-smoke.mjs
 * Only model responses and the host question answerer are deterministic. Every
 * tool, child agent, deadline, cancellation and job uses the booted host registry.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { bootProfile, hostPackage, prepareProfile, rowCounts, waitUntil } from './lib/profile.mjs'

const BUDGET = 1000
const WAIT = 2500
const PROVIDER = 'ptc-smoke-local'
const MODEL = 'deterministic'
const checks = []
const results = { passed: false, budgetMs: BUDGET, waitMs: WAIT, checks }
const state = { scenarios: new Map(), children: [], questions: [] }
const { createUserMessage } = await import(hostPackage('dsh-llm/lib/index.js'))

function lastUserText(messages) {
  const message = messages.findLast(message => message.role === 'user')
  const content = message?.content
  return typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function makeAdapter() {
  const model = { provider: PROVIDER, id: MODEL, name: MODEL, inputModalities: ['text'], context: { contextWindow: 200000 }, defaultMaxTokens: 64 }
  const adapter = {
    providerInfo: id => ({ id, name: 'PTC smoke local adapter' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [model],
    resolveModel: async () => model,
    async prepareCall() { return { model, stream: options => adapter.stream(options) } },
    async *stream(options) {
      const text = (options.messages ?? []).filter(message => message.role === 'user').map(message => lastUserText([message])).join('\n')
      if (text.includes('PTC_SMOKE_DELAYED_CHILD')) {
        const child = { startedAt: Date.now() }
        state.children.push(child)
        await delay(WAIT, undefined, { signal: options.signal })
        child.finishedAt = Date.now()
      }
      const scenario = [...state.scenarios].findLast(([prompt, scenario]) => !scenario.issued && text.includes(prompt))?.[1]
      if (scenario && !scenario.issued) {
        scenario.issued = true
        const id = randomUUID()
        const args = JSON.stringify({ code: scenario.code, description: scenario.name, timeoutMs: BUDGET })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PTC smoke turn complete.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return adapter
}

const info = await prepareProfile({
  prefix: 'apollo-ptc-smoke-',
  patch: [
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { id: 'workflow-ptc', disabled: true },
    { id: 'tool-workflow', disabled: true },
    { id: 'credentials', config: { watch: false } },
    { id: 'apollo-skills', config: { exitGuard: false } },
    { id: 'dsh-better-subagent', config: { childExitGuard: false } },
    { id: 'dsh-better-ask-user', config: { questionTimeoutSeconds: 10, timeoutBehavior: 'native' } },
    { id: 'ptc-runtime', config: { executionMode: 'per-call' } },
    { insert: [
      { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng-ptc' } },
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [{ provider: PROVIDER, model: MODEL }] } },
    ] },
  ],
})
let ctx
let agent
let offQuestion
let offEvents
const events = []
const activeCalls = new Set()
const questionTasks = new Set()
let cancelQuestion
let questionMode = 'answer'
function pass(name, evidence = {}) {
  checks.push({ name, ...evidence })
  console.log('PASS', name, JSON.stringify(evidence))
}
function track(promise) {
  activeCalls.add(promise)
  promise.then(() => activeCalls.delete(promise), () => activeCalls.delete(promise))
  return promise
}
async function execute(code, signal = new AbortController().signal, timeoutMs = BUDGET) {
  return track(ctx.tools.execute({ callId: randomUUID(), name: 'run_code', arguments: { code, description: 'PTC smoke registry invocation', timeoutMs }, agent, signal }))
}
async function modelRun(name, code, expectError = false) {
  const prompt = 'PTC_SMOKE_SCENARIO ' + randomUUID()
  state.scenarios.set(prompt, { name, code, issued: false })
  const start = events.length
  const startedAt = Date.now()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await waitUntil(() => events.slice(start).some(event => event.type === 'turn/end'), name + ' turn/end', 20000)
  await agent.whenIdle()
  const turn = events.slice(start)
  const end = turn.find(event => event.type === 'turn/end')
  assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end.data))
  const calls = turn.filter(event => event.type === 'tool/call')
  assert.equal(calls.length, 1, 'the model must issue exactly one real run_code call')
  assert.equal(calls[0].data.name, 'run_code')
  const message = turn.findLast(event => event.type === 'tool/result')?.data.message
  assert.ok(message, 'run_code must produce a durable tool result')
  assert.equal(message.isError === true, expectError, JSON.stringify(message))
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return { text, value: expectError ? undefined : JSON.parse(text), elapsedMs: Date.now() - startedAt }
}
const askCode = id => 'return await tools.ask_user_question({ questions: [{ id: ' + JSON.stringify(id) + ', question: "Local smoke question", options: [{ label: "smoke-answer" }] }] });'
try {
  ctx = await bootProfile(info)
  await mkdir(join(info.home, 'workspace'), { recursive: true })
  ctx.llm.registerAdapter([PROVIDER], makeAdapter())
  agent = (await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: join(info.home, 'workspace') }, agentOptions: { provider: PROVIDER, model: MODEL }, setup: async actor => { await ctx.agentPresets.mount(actor, 'eng-ptc') } })).agent
  offEvents = ctx.on('session/event', (session, event) => { if (session.id === agent.id) events.push(event) })
  assert.equal(ctx.ptcRuntime.constructor.name, 'NodePtcRuntime')
  assert.equal(ctx.ptcRuntime.programFormat, 'function-body')
  assert.ok(ctx.betterPtc, 'singleton exemption service is mounted')
  assert.equal(rowCounts(ctx).get('dsh-better-ptc'), 1)
  assert.ok(ctx.tools.get('run_code', agent))
  pass('real-eng-ptc-node-runtime-and-singleton')

  offQuestion = agent.ctx.on('user-questions/request', (request, next) => {
    if (questionMode === 'pending') return next()
    const question = { id: request.questions[0].id, startedAt: Date.now(), callId: request.wait?.callId }
    state.questions.push(question)
    const task = (async () => {
      try {
        if (questionMode === 'cancel') {
          cancelQuestion?.()
          await delay(20000, undefined, { signal: request.signal })
        } else {
          await delay(WAIT, undefined, { signal: request.signal })
        }
        question.finishedAt = Date.now()
        return { answers: request.questions.map(item => ({ id: item.id, selected: ['smoke-answer'] })) }
      } catch (error) {
        question.aborted = request.signal?.aborted === true
        throw error
      }
    })()
    questionTasks.add(task)
    task.then(() => questionTasks.delete(task), () => questionTasks.delete(task))
    return task
  })

  const child = await modelRun('subagent and delayed wait through PTC',
    'const child = await tools.subagent({ description: "PTC smoke real child", prompt: "PTC_SMOKE_DELAYED_CHILD: reply once", provider: ' + JSON.stringify(PROVIDER) + ', model: ' + JSON.stringify(MODEL) + ' }); const started = Date.now(); const waited = await tools.wait_subagent({ subagent_id: [child.subagentId] }); return { child, waited, waitMs: Date.now() - started };')
  assert.equal(child.value.child.kind, 'activation')
  assert.ok(child.value.waited.includes('subagent ' + child.value.child.subagentId + ' done (completed)'), child.text)
  assert.ok(child.value.waitMs >= WAIT - 100, child.text)
  assert.ok(state.children.some(item => item.finishedAt - item.startedAt >= WAIT - 100))
  pass('model-run_code-real-subagent-wait-exceeds-budget', { waitMs: child.value.waitMs, childId: child.value.child.subagentId })

  const answer = await modelRun('delayed question answer through PTC', askCode('answered'))
  assert.deepEqual(answer.value.answers, [{ id: 'answered', selected: ['smoke-answer'] }])
  const question = state.questions.find(item => item.id === 'answered')
  assert.ok(question.callId, 'real pending carrier supplies the nested call identity')
  assert.ok(question.finishedAt - question.startedAt >= WAIT - 100)
  pass('model-run_code-real-question-delayed-answer', { elapsedMs: answer.elapsedMs, carrierMs: question.finishedAt - question.startedAt })

  const cpu = await modelRun('ordinary computation deadline', 'const until = Date.now() + 4000; while (Date.now() < until) {} return "unreachable";', true)
  assert.match(cpu.text, /code run failed \(timeout\).*execution deadline reached \(1000ms\)/s)
  pass('ordinary-computation-still-times-out', { elapsedMs: cpu.elapsedMs })

  const nested = await modelRun('ordinary nested bash deadline', 'return await tools.bash({ description: "PTC ordinary nested wait", command: "sleep 4", timeoutMs: 5000 });', true)
  assert.match(nested.text, /code run failed \(timeout\)/)
  pass('ordinary-nested-tool-still-times-out', { elapsedMs: nested.elapsedMs })

  const resumed = await modelRun('deadline resumes after question', askCode('resumed').replace('return await', 'await') + ' const until = Date.now() + 4000; while (Date.now() < until) {} return "unreachable";', true)
  assert.match(resumed.text, /code run failed \(timeout\)/)
  assert.ok(state.questions.find(item => item.id === 'resumed')?.finishedAt)
  pass('deadline-resumes-after-exempt-question', { elapsedMs: resumed.elapsedMs })

  const row = (await ctx.settings.describe()).find(row => row.ns === 'dsh-better-ask-user')
  await ctx.settings.update('dsh-better-ask-user', { questionTimeoutSeconds: 2 }, row.revision)
  questionMode = 'pending'
  const pending = await modelRun('native pending carrier through PTC', askCode('pending'))
  assert.equal(pending.value.pending, true)
  assert.ok(pending.value.callId)
  assert.match(pending.value.message, /pending/)
  assert.ok(pending.elapsedMs > BUDGET)
  pass('native-pending-question-exceeds-budget', { elapsedMs: pending.elapsedMs, callId: pending.value.callId })

  questionMode = 'cancel'
  const controller = new AbortController()
  let cancelTimer
  cancelQuestion = () => { cancelTimer = setTimeout(() => controller.abort('PTC smoke explicit cancellation'), 1500) }
  const cancelStarted = Date.now()
  let cancelled
  try { cancelled = await execute(askCode('cancelled'), controller.signal) } finally { clearTimeout(cancelTimer) }
  assert.equal(controller.signal.aborted, true, 'the cancellation must occur after question dispatch')
  assert.equal(cancelled.isError, true, JSON.stringify(cancelled))
  assert.match(JSON.stringify(cancelled), /abort|cancel/i)
  assert.equal(state.questions.find(item => item.id === 'cancelled')?.aborted, true)
  pass('explicit-cancellation-aborts-exempt-question', { elapsedMs: Date.now() - cancelStarted })

  const collected = await execute('const job = await tools.bash({ description: "PTC tracked smoke job", command: "sleep 0.2; printf ptc-job-collected", run_in_background: true }); const output = await tools.job_output({ job_id: job.jobId, wait: true, timeout_ms: 5000 }); return { jobId: job.jobId, output };', new AbortController().signal, 5000)
  assert.equal(collected.isError, false, JSON.stringify(collected))
  const job = collected.value.result
  assert.equal(job.output.job.status, 'completed')
  assert.match(job.output.text, /ptc-job-collected/)
  pass('real-background-job-collected-through-ptc', { jobId: job.jobId, status: job.output.job.status })
  assert.equal(activeCalls.size, 0)
  assert.equal(questionTasks.size, 0)
  results.passed = true
} catch (error) {
  results.error = error.stack ?? String(error)
  results.recentEvents = events.filter(event => ['tool/call', 'tool/result', 'turn/end'].includes(event.type)).slice(-12)
  process.exitCode = 1
} finally {
  // Every admitted call is drained, including failures; the isolated host owns
  // child/process teardown. Never leave a smoke job running after a failed check.
  offQuestion?.()
  if (ctx && agent) {
    for (const job of ctx.jobs.list(agent.id)) {
      if (!['completed', 'killed', 'failed'].includes(job.status)) await ctx.jobs.kill(job.id, agent.id)
      results.jobs ??= []
      results.jobs.push({ id: job.id, status: ctx.jobs.list(agent.id).find(item => item.id === job.id)?.status, output: ctx.jobs.readAt(job.id, 0, agent.id) })
    }
  }
  if (ctx) await ctx.fiber.dispose()
  await Promise.allSettled([...activeCalls, ...questionTasks])
  offEvents?.()
  await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log('PTC_SMOKE_RESULT', JSON.stringify(results, null, 2))
}

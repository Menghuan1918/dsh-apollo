/**
 * Real Node PTC -> executor -> native exit_plan_mode -> userQuestions coverage.
 * Only the human answerer is controlled; no tool or runtime binding is replaced.
 * Run with DSH_PACKAGE_ROOT and (for local unreleased plugins)
 * APOLLO_PLUGIN_SOURCE_ROOT set, like the other real-profile integration tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { bootProfile, hostPackage, prepareProfile, rowCounts } from '../scripts/lib/profile.mjs'

const enabled = !!process.env.DSH_PACKAGE_ROOT
const BUDGET = 700
const WAIT = 1800
const PLAN = '# Real runtime approval plan\n\nVerify an isolated temporary profile.'
const REVIEW = 'await tools.exit_plan_mode({ plan: ' + JSON.stringify(PLAN) + ' })'
const PROVIDER = 'plan-review-local'
const MODEL = 'no-network'

for (const assembly of ['standalone', 'apollo']) {
  test('real plan review: ' + assembly, {
    skip: enabled ? false : 'DSH_PACKAGE_ROOT is not set',
    timeout: 60000,
  }, async (t) => {
    const info = await prepareProfile({
      bundles: [assembly === 'apollo' ? '@menghuan1918/dsh-apollo' : 'dsh-better-ptc'],
      prefix: 'apollo-plan-review-',
      patch: [
        { id: 'headless-startup', disabled: true },
        { id: 'headless-runner', disabled: true },
        { id: 'workflow-ptc', disabled: true },
        { id: 'tool-workflow', disabled: true },
        { id: 'credentials', config: { watch: false } },
        { id: 'ptc-runtime', config: { executionMode: 'per-call' } },
        ...(assembly === 'apollo' ? [
          { id: 'apollo-skills', config: { exitGuard: false } },
          { id: 'dsh-better-subagent', config: { childExitGuard: false } },
          // A short ask-user countdown must not leak into blocking plan review.
          { id: 'dsh-better-ask-user', config: { questionTimeoutSeconds: 1, timeoutBehavior: 'default' } },
        ] : []),
        { insert: [
          { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
          { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: assembly === 'apollo' ? 'eng-ptc' : 'standard' } },
        ] },
      ],
    })
    let ctx
    const active = new Set()
    const controllers = new Set()
    try {
      ctx = await bootProfile(info)
      await mkdir(join(info.home, 'workspace'), { recursive: true })
      const model = { provider: PROVIDER, id: MODEL, name: MODEL, inputModalities: ['text'], context: { contextWindow: 200000 }, defaultMaxTokens: 64 }
      ctx.llm.registerAdapter([PROVIDER], {
        providerInfo: id => ({ id, name: 'Local plan review test' }),
        providerRetryPolicy: () => undefined,
        imageRequestPricing: () => undefined,
        listModels: async () => [model],
        resolveModel: async () => model,
      })
      const executor = await import(hostPackage('dsh-tool-executor-ptc/lib/index.js'))
      const { UserQuestionError } = await import(hostPackage('dsh-user-questions/lib/index.js'))
      const { agent } = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: join(info.home, 'workspace') },
        agentOptions: { provider: PROVIDER, model: MODEL },
        setup: async actor => {
          if (assembly === 'apollo') await ctx.agentPresets.mount(actor, 'eng-ptc')
          else await actor.plugin(executor)
        },
      })
      const planMode = assembly === 'apollo' ? ctx.agentPresets.serviceFor(agent, 'planMode') : agent.ctx.get('planMode')
      assert.ok(planMode, 'native plan-mode service is mounted in the calling scope')
      assert.equal(ctx.ptcRuntime.constructor.name, 'NodePtcRuntime')
      assert.equal(rowCounts(ctx).get('dsh-better-ptc'), 1)
      assert.ok(ctx.betterPtc)
      assert.equal(rowCounts(ctx).has('apollo-skills'), assembly === 'apollo')
      // Guard against install-anchor resolution silently loading ancestor packages.
      for (const id of assembly === 'apollo' ? ['dsh-better-ptc', 'apollo-skills'] : ['dsh-better-ptc']) {
        const entry = [...ctx.root.loader.entries()].find(entry => entry.options?.id === id)
        const dir = info.profilePackage(entry.options.name)
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
        const copiedModule = await import(pathToFileURL(join(dir, manifest.main)).href)
        assert.equal(entry.moduleNamespace.apply, copiedModule.apply, id + ' must run from the copied temporary profile package')
        if (id === 'dsh-better-ptc') assert.equal(manifest.version, '0.2.0')
      }

      async function runReview(code, outcome) {
        planMode.set(agent, true)
        assert.deepEqual(planMode.get(agent), { active: true })
        const arrived = Promise.withResolvers()
        const answer = Promise.withResolvers()
        const controller = new AbortController()
        controllers.add(controller)
        let request
        let requests = 0
        let settled = false
        let aborted = false
        const off = agent.ctx.on('user-questions/request', async current => {
          requests += 1
          request = current
          arrived.resolve(current)
          const onAbort = () => {
            aborted = true
            answer.reject(current.signal.reason)
          }
          current.signal.addEventListener('abort', onAbort, { once: true })
          try { return await answer.promise }
          finally { current.signal.removeEventListener('abort', onAbort) }
        })
        const task = (async () => {
          const signal = controller.signal
          const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: PROVIDER, model: MODEL }, signal })
          try {
            return await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: randomUUID(), name: 'run_code', arguments: JSON.stringify({ code, description: 'Review a real isolated runtime plan', timeoutMs: BUDGET }) }],
              agent, signal, toolSet,
            })
          } finally { toolSet.dispose() }
        })()
        active.add(task)
        task.then(() => { settled = true; active.delete(task) }, () => { settled = true; active.delete(task) })
        try {
          request = await Promise.race([arrived.promise, task.then(result => { throw new Error('run_code settled before native review: ' + JSON.stringify(result)) })])
          assert.equal(request.agent, agent)
          assert.equal(request.wait, undefined, 'plan review is blocking, not a timed ask-user carrier')
          assert.equal(request.questions.length, 1)
          assert.equal(request.questions[0].detail, PLAN)
          assert.equal(request.questions[0].intent.kind, 'plan-review')
          assert.ok(request.questions[0].intent.callId)
          assert.equal(request.questions[0].intent.approve, 'Approve')
          for (let check = 0; check < 2; check += 1) {
            await delay(WAIT / 2)
            assert.equal(settled, false, 'review must remain pending beyond both PTC budget and ask-user countdown')
            assert.equal(request.signal.aborted, false)
            assert.deepEqual(planMode.get(agent), { active: true }, 'pending review is never implicit approval')
          }
          if (outcome === 'abort') controller.abort('explicit plan review test cancellation')
          else if (outcome === 'dismiss') answer.reject(new UserQuestionError('User dismissed plan review', 'ASK_CANCELLED'))
          else answer.resolve({ answers: [{ id: 'plan-review', selected: [outcome === 'approve' ? 'Approve' : 'Keep planning'], ...(outcome === 'keep' ? { custom: 'Add a rollback check.' } : {}) }] })
          const batch = await task
          assert.equal(requests, 1, 'exactly one real plan review, no fallback or auto-answer')
          assert.equal(batch.results.length, 1)
          return { batch, result: batch.results[0].result, aborted }
        } finally {
          controller.abort('plan review test cleanup')
          await Promise.allSettled([task])
          controllers.delete(controller)
          off()
        }
      }

      await t.test('approval remains pending past the short budget and explicitly approves only the next step', async () => {
        const { result, batch } = await runReview('return ' + REVIEW, 'approve')
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.deepEqual(result.value.result, { approved: true })
        assert.equal(batch.concluded, false)
        assert.deepEqual(planMode.get(agent), { active: true, pending: false })
        await agent.ctx.waterfall('agent/pre-step', { agent, messages: [], step: 1, modelSelection: { provider: PROVIDER, model: MODEL }, signal: new AbortController().signal }, async () => ({ kind: 'accept', messages: [] }))
        assert.deepEqual(planMode.get(agent), { active: false })
      })

      await t.test('keep planning returns explicit feedback, never approval', async () => {
        const { result, batch } = await runReview('try { return ' + REVIEW + ' } catch (error) { return { tool: error.toolName, message: error.message } }', 'keep')
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.equal(result.value.result.tool, 'exit_plan_mode')
        assert.match(result.value.result.message, /keep planning.*Add a rollback check/s)
        assert.equal(batch.concluded, false)
        assert.deepEqual(planMode.get(agent), { active: true })
      })

      await t.test('dismissal returns unapproved and concludes the turn without leaving plan mode', async () => {
        const { result, batch } = await runReview('return ' + REVIEW, 'dismiss')
        assert.equal(result.isError, false, JSON.stringify(result))
        assert.deepEqual(result.value.result, { approved: false })
        assert.equal(batch.concluded, true)
        assert.deepEqual(planMode.get(agent), { active: true })
      })

      for (const outcome of ['approve', 'keep', 'dismiss']) {
        await t.test(outcome + ' resumes only the unused budget, not a fresh deadline', async () => {
          // Both active slices fit a fresh budget separately, but together exceed it.
          const code = 'const before = Date.now() + 300; while (Date.now() < before) {} try { ' + REVIEW + ' } catch (error) { console.log(error.message) } const after = Date.now() + 500; while (Date.now() < after) {} return "incorrectly reset budget"'
          const { result } = await runReview(code, outcome)
          assert.equal(result.isError, true, JSON.stringify(result))
          assert.match(JSON.stringify(result), /code run failed \(timeout\).*execution deadline reached \(700ms\)/s)
          assert.deepEqual(planMode.get(agent), outcome === 'approve' ? { active: true, pending: false } : { active: true })
          // Reset the selected next-step intent through the public mode API.
          planMode.set(agent, true)
        })
      }

      await t.test('caller cancellation still aborts a pending exempt review and drains its answerer', async () => {
        const { result, aborted } = await runReview('return ' + REVIEW, 'abort')
        assert.equal(aborted, true)
        assert.equal(result.isError, true, JSON.stringify(result))
        assert.match(JSON.stringify(result), /abort|cancel/i)
        assert.doesNotMatch(JSON.stringify(result), /code run failed \(timeout\)/)
        assert.deepEqual(planMode.get(agent), { active: true })
      })
      assert.equal(active.size, 0)
      assert.equal(ctx.jobs.list(agent.id).length, 0, 'the test creates no background jobs')
      assert.equal(ctx.get('webServer'), undefined, 'the isolated headless profile mounts no HTTP server')
    } finally {
      for (const controller of controllers) controller.abort('plan review fixture teardown')
      await Promise.allSettled([...active])
      if (ctx) await ctx.fiber.dispose()
      await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { prepareProfile, bootProfile, waitUntil } from '../scripts/lib/profile.mjs'

const enabled = !!process.env.DSH_PACKAGE_ROOT

test('real profile: migration that changes the engine blocks requests until a profile reload', {
  skip: enabled ? false : 'DSH_PACKAGE_ROOT is not set',
}, async () => {
  const patch = [
    { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
    { id: 'workflow-ptc', disabled: true }, { id: 'tool-workflow', disabled: true },
    { id: 'credentials', disabled: false, config: { watch: false } },
    { id: 'preset-eng', config: { id: 'eng', name: 'legacy', plugins: [{
      id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false, thresholdRatio: 0.7, maxTokens: 256 },
    }] } },
    { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } }] },
  ]
  const info = await prepareProfile({ bundles: ['@menghuan1918/dsh-apollo'], patch, prefix: 'apollo-admission-' })
  let ctx
  try {
    ctx = await bootProfile(info)
    await waitUntil(() => {
      const companion = ctx.get('betterCompactConfig')
      return companion && companion.current().thresholdRatio === 0.7
    }, 'native values migrated')
    // Updating the settings projection happens before migration verifies its
    // writes and publishes the terminal result; both interim and final states
    // must refuse execution.
    await new Promise(resolve => setImmediate(resolve))
    let called = false
    await assert.rejects(async () => {
      for await (const chunk of ctx.waterfall('llm/stream', {}, async function* () { called = true; yield 'provider' })) void chunk
    }, /迁移|重载/)
    assert.equal(called, false)
    await ctx.fiber.dispose(); ctx = undefined
    ctx = await bootProfile(info)
    await waitUntil(async () => {
      try {
        for await (const chunk of ctx.waterfall('llm/stream', {}, async function* () { yield 'provider' })) void chunk
        return true
      } catch (error) { if (/迁移/.test(error.message)) return false; throw error }
    }, 'verified unchanged configuration admits work after reload')
    const chunks = []
    for await (const chunk of ctx.waterfall('llm/stream', {}, async function* () { yield 'provider' })) chunks.push(chunk)
    assert.deepEqual(chunks, ['provider'])
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true })
  }
})

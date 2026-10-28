/**
 * 真实宿主 temp-profile 迁移测试。
 *
 * 用安装版 DSH 启动一个 headless profile：Apollo 0.5.x 装配两个独立插件的
 * 稳定行，profile patch 里保留 0.4.x 风格的旧 Apollo 行配置，以及一个仍带
 * 原生 compaction-basic 显式配置的旧 eng-ptc 预设覆盖。Apollo 启动后应：
 *   - 把子代理字段补进 dsh-better-subagent（目标显式值优先）；
 *   - 把旧原生压缩配置补进 dsh-better-compact；
 *   - 用 configEditor 写非 volatile 的 trustedHosts；
 *   - 重读验证、不删旧来源、重复执行不再写入。
 *
 * 没有 DSH_PACKAGE_ROOT 或未安装三个独立包时跳过（与 upstream-drift 一致），
 * 不把跳过当成通过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { bootProfile, prepareProfile, waitUntil } from '../scripts/lib/profile.mjs'
import { COMPACT_NS, SUBAGENT_NS, runMigration } from '../src/migrate.js'

const enabled = process.env.DSH_PACKAGE_ROOT !== undefined

const OLD_APOLLO = {
  exitGuard: true,
  tiers: {
    fast: { provider: 'old-fast', model: 'old-fast-model', reasoningEffort: 'low' },
    quality: { provider: 'old-quality', model: 'old-quality-model', reasoningEffort: '' },
  },
  subagents: {
    eng: false,
    global: false,
    codex: {
      enabled: true,
      executable: 'codex-old',
      profile: 'legacy',
      permissionMode: 'read-only',
      defaultModel: 'gpt-old',
      models: [{ id: 'gpt-old', efforts: ['low'], defaultEffort: 'low' }],
    },
    claude: { enabled: false, executable: 'claude', permissionMode: 'plan', defaultModel: '', models: [] },
  },
  trustedHosts: ['proxy.local'],
  declareOwnsHost: false,
}

const TARGET_SUBAGENT = {
  tiers: { quality: { provider: 'target-quality', model: 'target-model', reasoningEffort: '' } },
  subagents: { global: true, codex: { models: [] } },
}

const TARGET_COMPACT = { mode: 'goal', auto: false, thresholdRatio: 0.55 }

const OLD_PRESET_PTC = {
  id: 'eng-ptc',
  name: '工程(PTC)模式',
  description: 'legacy native compaction config',
  order: 11,
  plugins: [{
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [{
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
      config: {
        auto: true,
        thresholdRatio: 0.7,
        retainTokens: 1234,
        maxTokens: 256,
        compactionRetries: 2,
        maxOverflowRetries: 0,
      },
    }],
  }],
}

const PATCH = [
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true },
  { id: 'workflow-ptc', disabled: true },
  { id: 'tool-workflow', disabled: true },
  { id: 'credentials', disabled: false, config: { watch: false } },
  { id: 'apollo-skills', config: OLD_APOLLO },
  { id: 'dsh-better-subagent', config: TARGET_SUBAGENT },
  { id: 'dsh-better-compact', config: TARGET_COMPACT },
  // Simulates a 0.4.x user override that still restates the old native preset.
  { id: 'preset-eng-ptc', config: OLD_PRESET_PTC },
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng-ptc' } },
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  ] },
]

test('真实 temp profile：旧 Apollo 子代理/压缩配置迁移到独立行', { skip: enabled ? false : 'DSH_PACKAGE_ROOT is not set' }, async () => {
  const info = await prepareProfile({ bundles: ['@menghuan1918/dsh-apollo'], patch: PATCH, prefix: 'apollo-migration-' })
  let ctx
  try {
    ctx = await bootProfile(info)
    // Wait for Apollo's asynchronous migration to persist and re-read.
    await waitUntil(async () => {
      const rows = await ctx.settings.describe()
      const subagent = rows.find((row) => row.ns === SUBAGENT_NS)
      const compact = rows.find((row) => row.ns === COMPACT_NS)
      return subagent?.user?.childExitGuard === true && compact?.user?.retainTokens === 1234
    }, 'Apollo config migration', 15_000)

    const rows = await ctx.settings.describe()
    const subagent = rows.find((row) => row.ns === SUBAGENT_NS)
    const compact = rows.find((row) => row.ns === COMPACT_NS)
    const apollo = rows.find((row) => row.ns === 'apollo-skills')
    assert.ok(subagent && compact && apollo, 'all three rows must expose their formal config')

    // Subagent: source fields migrated; target explicit values win.
    assert.equal(subagent.value.childExitGuard, true, 'old exitGuard → childExitGuard')
    assert.deepEqual(subagent.value.tiers.fast, { provider: 'old-fast', model: 'old-fast-model', reasoningEffort: 'low' })
    assert.deepEqual(subagent.value.tiers.quality, { provider: 'target-quality', model: 'target-model', reasoningEffort: '' })
    assert.equal(subagent.value.subagents.eng, false, 'explicit source false is migrated')
    assert.equal(subagent.value.subagents.global, true, 'target explicit global wins over source default false')
    assert.equal(subagent.value.subagents.codex.enabled, true)
    assert.equal(subagent.value.subagents.codex.executable, 'codex-old')
    assert.equal(subagent.value.subagents.codex.profile, 'legacy')
    assert.equal(subagent.value.subagents.codex.defaultModel, 'gpt-old')
    assert.deepEqual(subagent.value.subagents.codex.models, [], 'target explicit empty model list wins')
    assert.equal('trustedHosts' in subagent.value, false, 'trustedHosts stays a deployment field outside the editable form')

    // trustedHosts is non-volatile: written through configEditor, not settings.update.
    const entry = ctx.configEditor.entries().find((candidate) => candidate.options.id === SUBAGENT_NS)
    assert.ok(entry, 'the target row must be addressable')
    assert.deepEqual(entry.options.config.trustedHosts, ['proxy.local'])

    // Compact: source explicit native config carried; target explicit values win.
    assert.equal(compact.value.mode, 'goal')
    assert.equal(compact.value.auto, false, 'target explicit auto wins')
    assert.equal(compact.value.thresholdRatio, 0.55, 'target explicit threshold wins')
    assert.equal(compact.value.retainTokens, 1234)
    assert.equal(compact.value.retainRatio ?? null, null, 'retention forms stay mutually exclusive')
    assert.equal(compact.value.maxTokens, 256)
    assert.equal(compact.value.compactionRetries, 2)
    assert.equal(compact.value.maxOverflowRetries, 0)

    // Old source is preserved (no deletion before verified persistence).
    assert.equal(apollo.value.exitGuard, true)
    assert.equal(apollo.value.tiers.fast.provider, 'old-fast')
    assert.deepEqual(apollo.value.subagents.codex.models, [{ id: 'gpt-old', efforts: ['low'], defaultEffort: 'low' }])

    // No CLI identity KV or goal state is created by the migration.
    const storages = `${info.home}/storages`
    if (existsSync(storages)) {
      const names = await readdir(storages)
      assert.equal(names.some((name) => name.startsWith('apollo_cli_')), false, 'migration must not copy the CLI KV namespace')
    }

    // Idempotence: a second run reports complete and does not rewrite the patch.
    const before = await readFile(info.patchPath, 'utf8')
    const rerun = await runMigration(ctx, { timeoutMs: 200, intervalMs: 10 })
    assert.equal(rerun.status, 'complete', JSON.stringify(rerun))
    assert.equal(rerun.subagent.status, 'no-change')
    assert.equal(rerun.compact.status, 'no-change')
    assert.equal(await readFile(info.patchPath, 'utf8'), before, 'idempotent migration must not rewrite the profile patch')
    const after = await ctx.settings.describe()
    assert.deepEqual(
      after.find((row) => row.ns === SUBAGENT_NS).user,
      subagent.user,
      'second run must not change the target user values',
    )
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

const SKIPPED_GUARD_PATCH = [
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true },
  { id: 'workflow-ptc', disabled: true },
  { id: 'tool-workflow', disabled: true },
  { id: 'credentials', disabled: false, config: { watch: false } },
  // Historical unscoped row name: the Loader treats `name` as a guard and
  // skips this override, but configEditor.configuration().override keeps it.
  { id: 'apollo-skills', name: 'dsh-apollo', config: { subagents: { eng: false }, exitGuard: true } },
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } },
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  ] },
]

test('真实 temp profile：旧 name: dsh-apollo 行被 Loader 跳过时仍迁移显式值', { skip: enabled ? false : 'DSH_PACKAGE_ROOT is not set' }, async () => {
  const info = await prepareProfile({ bundles: ['@menghuan1918/dsh-apollo'], patch: SKIPPED_GUARD_PATCH, prefix: 'apollo-skipped-guard-' })
  let ctx
  try {
    ctx = await bootProfile(info)
    await waitUntil(async () => {
      const rows = await ctx.settings.describe()
      const subagent = rows.find((row) => row.ns === SUBAGENT_NS)
      return subagent?.user?.childExitGuard === true && subagent?.user?.subagents?.eng === false
    }, 'migration from the skipped legacy row', 15_000)

    const rows = await ctx.settings.describe()
    const subagent = rows.find((row) => row.ns === SUBAGENT_NS)
    const apollo = rows.find((row) => row.ns === 'apollo-skills')
    assert.equal(subagent.value.childExitGuard, true, 'explicit old exitGuard is recovered')
    assert.equal(subagent.value.subagents.eng, false, 'explicit old false is recovered, not the effective default true')
    assert.equal(apollo.value.exitGuard, false, 'the skipped row must still show the effective default')
    assert.equal(apollo.value.subagents.eng, true, 'the skipped row must still show the effective default')

    const configuration = ctx.configEditor.configuration().find((row) => row.entry.options.id === 'apollo-skills')
    assert.deepEqual(configuration.override, { subagents: { eng: false }, exitGuard: true }, 'the raw override is the recovery source')
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await rm(info.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

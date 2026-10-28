/**
 * 旧配置迁移（src/migrate.js）纯函数 + 编排单元测试。
 *
 * 真实宿主 temp-profile 覆盖在 tests/migration.runtime.test.mjs；这里用受控
 * fake settings/configEditor 钉死选择规则、显式空值、目标优先、ambiguity、
 * trustedHosts 和幂等/验证失败语义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_NS,
  SUBAGENT_NS,
  compactionConfigOf,
  mergeConfigOverride,
  migrateCompact,
  migrateSubagent,
  mountMigration,
  planCompactMigration,
  planSubagentMigration,
  planTrustedHostsMigration,
  runMigration,
  selectCompactionSource,
  verifyCompactMigration,
  verifySubagentMigration,
  waitForDescriptors,
} from '../src/migrate.js'

const EMPTY_TIER = { provider: '', model: '', reasoningEffort: '' }
const CODEX = {
  enabled: false,
  executable: 'codex',
  profile: '',
  permissionMode: 'read-only',
  defaultModel: '',
  models: [],
}
const CLAUDE = { enabled: false, executable: 'claude', permissionMode: 'plan', defaultModel: '', models: [] }
const SUBAGENT_BASE = {
  childExitGuard: false,
  tiers: { fast: { ...EMPTY_TIER }, quality: { ...EMPTY_TIER } },
  subagents: { eng: true, global: false, codex: { ...CODEX, models: [] }, claude: { ...CLAUDE, models: [] } },
}
const COMPACT_BASE = {
  mode: 'goal',
  auto: true,
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  retainTokens: null,
  summarizationProvider: '',
  summarizationModel: '',
  reasoningEffort: '',
  cachePriority: true,
  maxTokens: null,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  modelPolicies: [],
}
const APOLLO_DEFAULT = {
  exitGuard: false,
  tiers: { fast: { ...EMPTY_TIER }, quality: { ...EMPTY_TIER } },
  subagents: {
    eng: true,
    global: false,
    codex: { ...CODEX, models: [] },
    claude: { ...CLAUDE, models: [] },
  },
  trustedHosts: [],
  declareOwnsHost: false,
}

function deepMerge(base, patch) {
  const result = structuredClone(base ?? {})
  for (const [key, value] of Object.entries(patch ?? {})) {
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(result[key], value)
      : structuredClone(value)
  }
  return result
}

// ── 子代理迁移 ─────────────────────────────────────────────────────────────

test('planSubagentMigration：复制分档/范围/后端/childExitGuard，目标默认值不重复写', () => {
  const source = {
    ...APOLLO_DEFAULT,
    exitGuard: true,
    tiers: {
      fast: { provider: 'p', model: 'm', reasoningEffort: 'high' },
      quality: { ...EMPTY_TIER },
    },
    subagents: {
      eng: false,
      global: true,
      codex: {
        enabled: true,
        executable: '/opt/codex',
        profile: 'work',
        permissionMode: 'workspace-write',
        defaultModel: 'gpt-5',
        models: [{ id: 'gpt-5', efforts: ['low', 'high'], defaultEffort: 'high' }],
      },
      claude: { ...CLAUDE, models: [] },
    },
  }
  const { patch, fields } = planSubagentMigration({ source, targetUser: {}, targetBase: SUBAGENT_BASE })
  assert.deepEqual(patch, {
    childExitGuard: true,
    tiers: { fast: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
    subagents: {
      eng: false,
      global: true,
      codex: {
        enabled: true,
        executable: '/opt/codex',
        profile: 'work',
        permissionMode: 'workspace-write',
        defaultModel: 'gpt-5',
        models: [{ id: 'gpt-5', efforts: ['low', 'high'], defaultEffort: 'high' }],
      },
    },
  })
  assert.equal(fields.includes('tiers.quality'), false, '空分档等于目标默认，不写')
  assert.equal(fields.includes('subagents.claude.enabled'), false, '默认后端字段不写')
})

test('planSubagentMigration：显式 false/0/空串/空列表是值，不是缺失', () => {
  const source = { ...APOLLO_DEFAULT, subagents: { ...APOLLO_DEFAULT.subagents, eng: false } }
  const { patch } = planSubagentMigration({ source, targetUser: {}, targetBase: SUBAGENT_BASE })
  assert.equal(patch.subagents.eng, false, '显式关闭必须迁移')
  const empty = planSubagentMigration({ source: APOLLO_DEFAULT, targetUser: {}, targetBase: SUBAGENT_BASE })
  assert.deepEqual(empty.patch, {}, '来源默认值与目标默认相同 → 无写入')
})

test('planSubagentMigration：目标显式值优先（含空列表与部分分档）', () => {
  const source = {
    ...APOLLO_DEFAULT,
    tiers: { fast: { provider: 'src', model: 'src-model', reasoningEffort: '' }, quality: { ...EMPTY_TIER } },
    subagents: {
      eng: false,
      global: false,
      codex: { ...CODEX, enabled: true, models: [{ id: 'src', efforts: ['low'], defaultEffort: 'low' }] },
      claude: { ...CLAUDE, models: [] },
    },
  }
  const targetUser = {
    tiers: { fast: { provider: 'user', model: 'user-model', reasoningEffort: '' } },
    subagents: {
      eng: true,
      codex: { models: [], enabled: false },
    },
  }
  const { patch } = planSubagentMigration({ source, targetUser, targetBase: SUBAGENT_BASE })
  assert.equal(patch.tiers, undefined, '目标已有任一显式分档字段 → 整档不混写')
  const subagents = patch.subagents ?? {}
  assert.equal(subagents.eng, undefined, '目标显式 true 优先')
  assert.equal(subagents.codex?.models, undefined, '目标显式空列表是值')
  assert.equal(subagents.codex?.enabled, undefined, '目标显式 false 是值')
  assert.equal(subagents.global, undefined, '来源 false 等于目标默认，无需写')
})

test('planTrustedHostsMigration：目标未声明才写；空来源或目标显式空列表不写', () => {
  assert.deepEqual(planTrustedHostsMigration({ source: { trustedHosts: ['proxy.local'] }, targetRaw: {} }), ['proxy.local'])
  assert.equal(planTrustedHostsMigration({ source: { trustedHosts: ['proxy.local'] }, targetRaw: { trustedHosts: [] } }), undefined)
  assert.equal(planTrustedHostsMigration({ source: { trustedHosts: [] }, targetRaw: {} }), undefined)
})

test('mergeConfigOverride：嵌套对象递归合并，数组与显式空值覆盖', () => {
  const base = {
    subagents: { eng: true, global: false, codex: { enabled: true, models: ['a'] } },
    tiers: { fast: { provider: 'p', model: 'm' } },
    trustedHosts: ['old'],
  }
  const merged = mergeConfigOverride(base, {
    subagents: { eng: false, codex: { models: [], enabled: false } },
    trustedHosts: [],
    tiers: { fast: { provider: '' } },
  })
  assert.deepEqual(merged, {
    subagents: { eng: false, global: false, codex: { enabled: false, models: [] } },
    tiers: { fast: { provider: '', model: 'm' } },
    trustedHosts: [],
  })
  assert.deepEqual(base.subagents.eng, true, '不修改输入')
  assert.deepEqual(mergeConfigOverride(undefined, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeConfigOverride({ a: [1] }, { a: [2] }), { a: [2] })
  assert.deepEqual(mergeConfigOverride({ a: { b: 1 } }, { a: 0 }), { a: 0 })
})

test('verifySubagentMigration：数组/嵌套字段按目标生效值校验', () => {
  const patch = {
    childExitGuard: true,
    tiers: { fast: { provider: 'p', model: 'm', reasoningEffort: '' } },
    subagents: { codex: { models: [{ id: 'gpt-5', efforts: ['low'], defaultEffort: 'low' }] } },
  }
  const value = deepMerge(SUBAGENT_BASE, patch)
  assert.deepEqual(verifySubagentMigration({ patch, targetValue: value }), [])
  value.subagents.codex.models = []
  assert.deepEqual(verifySubagentMigration({ patch, targetValue: value }), ['subagents.codex.models'])
})

// ── compact 迁移 ───────────────────────────────────────────────────────────

const COMPACTION_GROUP = (config) => ({
  id: 'compaction',
  name: 'cordis:group',
  group: true,
  config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', ...(config === undefined ? {} : { config }) }],
})
const PRESET = (id, compactionConfig) => ({
  id,
  name: '@deepseek-ai/dsh-agent-preset',
  config: { id: id.replace('preset-', ''), order: 10, plugins: [COMPACTION_GROUP(compactionConfig)] },
})

test('compactionConfigOf：只取显式 config；无 config 或空对象视为无来源', () => {
  assert.deepEqual(compactionConfigOf({ plugins: [COMPACTION_GROUP({ auto: false })] }), { auto: false })
  assert.equal(compactionConfigOf({ plugins: [COMPACTION_GROUP()] }), undefined)
  assert.equal(compactionConfigOf({ plugins: [COMPACTION_GROUP({})] }), undefined)
  assert.equal(compactionConfigOf({}), undefined)
})

test('selectCompactionSource：默认预设权威；非 Apollo 默认时唯一/相同来源可用，不同来源报 ambiguity', () => {
  const presets = [
    { rowId: 'preset-eng', config: PRESET('preset-eng', { auto: false }).config },
    { rowId: 'preset-eng-ptc', config: PRESET('preset-eng-ptc', { auto: true }).config },
  ]
  assert.equal(selectCompactionSource(presets, 'eng').config.auto, false)
  assert.equal(selectCompactionSource(presets, 'eng-ptc').config.auto, true)
  assert.deepEqual(selectCompactionSource(presets, 'standard'), { status: 'ambiguous', rowIds: ['preset-eng', 'preset-eng-ptc'] })

  const same = presets.map((row) => ({ ...row, config: PRESET(row.rowId, { auto: false }).config }))
  assert.equal(selectCompactionSource(same, 'standard').shared, true)

  const one = [presets[0], { rowId: 'preset-eng-ptc', config: PRESET('preset-eng-ptc').config }]
  assert.equal(selectCompactionSource(one, 'standard').rowId, 'preset-eng')
  assert.equal(selectCompactionSource([presets[0]], 'eng-ptc').status, 'source-missing')
  assert.equal(selectCompactionSource([], undefined).status, 'absent')
})

test('planCompactMigration：复制原生键、保留互斥保留方式、缺失 mode 补 goal', () => {
  const source = {
    auto: false,
    thresholdRatio: 0.7,
    headroomTokens: 4096,
    retainRatio: 0.2,
    summarizationProvider: 'p',
    summarizationModel: 'm',
    maxTokens: 2048,
    compactionRetries: 3,
    maxOverflowRetries: 0,
    modelPolicies: [{ provider: 'p', model: 'x', thresholdRatio: 0.6 }],
  }
  const plan = planCompactMigration({ source, targetUser: {}, targetBase: { ...COMPACT_BASE, mode: 'native' } })
  assert.equal(plan.status, 'planned')
  assert.deepEqual(plan.patch, {
    auto: false,
    thresholdRatio: 0.7,
    headroomTokens: 4096,
    summarizationProvider: 'p',
    summarizationModel: 'm',
    maxTokens: 2048,
    compactionRetries: 3,
    maxOverflowRetries: 0,
    modelPolicies: [{ provider: 'p', model: 'x', thresholdRatio: 0.6 }],
    retainRatio: 0.2,
    mode: 'goal',
  })

  const tokens = planCompactMigration({ source: { retainTokens: 1234 }, targetUser: {}, targetBase: COMPACT_BASE })
  assert.deepEqual(tokens.patch, { retainTokens: 1234 })
  assert.equal('retainRatio' in tokens.patch, false, 'retainRatio/retainTokens 永不同时写')
})

test('planCompactMigration：来源显式 0/false 生效；等于目标默认不写', () => {
  const plan = planCompactMigration({
    source: { auto: false, maxOverflowRetries: 0, thresholdRatio: 0.8 },
    targetUser: {},
    targetBase: COMPACT_BASE,
  })
  assert.deepEqual(plan.patch, { auto: false, maxOverflowRetries: 0 })
})

test('planCompactMigration：目标显式值优先（含保留方式二选一）', () => {
  const plan = planCompactMigration({
    source: { auto: false, thresholdRatio: 0.7, retainRatio: 0.2, summarizationProvider: 'p', summarizationModel: 'm' },
    targetUser: { auto: true, thresholdRatio: 0.9, retainTokens: 999, mode: 'handoff' },
    targetBase: COMPACT_BASE,
  })
  assert.equal(plan.status, 'planned')
  assert.deepEqual(plan.patch, { summarizationProvider: 'p', summarizationModel: 'm' })
})

test('planCompactMigration：目标只声明摘要对的一半时整对不混写', () => {
  const plan = planCompactMigration({
    source: { summarizationProvider: 'src', summarizationModel: 'src-model' },
    targetUser: { summarizationProvider: 'user' },
    targetBase: COMPACT_BASE,
  })
  assert.deepEqual(plan.patch, {}, '配对字段不能与来源混合')
})

test('planCompactMigration：冲突/半对来源拒绝迁移而不是猜测', () => {
  assert.equal(planCompactMigration({ source: { retainRatio: 0.2, retainTokens: 10 }, targetUser: {}, targetBase: COMPACT_BASE }).status, 'invalid')
  assert.equal(planCompactMigration({ source: { summarizationProvider: 'p' }, targetUser: {}, targetBase: COMPACT_BASE }).status, 'invalid')
  const none = planCompactMigration({ source: {}, targetUser: {}, targetBase: COMPACT_BASE })
  assert.equal(none.status, 'no-change')
})

test('verifyCompactMigration：按生效值校验并报告缺失键', () => {
  const patch = { auto: false, thresholdRatio: 0.7 }
  assert.deepEqual(verifyCompactMigration({ patch, targetValue: { ...COMPACT_BASE, ...patch } }), [])
  assert.deepEqual(verifyCompactMigration({ patch, targetValue: COMPACT_BASE }), ['auto', 'thresholdRatio'])
})

// ── 编排（fake host）──────────────────────────────────────────────────────

/**
 * Fake settings describe/update + configEditor with top-level preset rows.
 * update merges into both the effective value and the user override so the
 * second run sees target-explicit values (idempotence).
 */
function fakeHost({
  source = {},
  presets = [],
  defaultId = 'eng',
  targetUser = {},
  compactUser = {},
  entriesExtra = [],
  apolloRaw = source,
  apolloOverride = undefined,
  presetOverrides = {},
} = {}) {
  const descriptors = new Map([
    ['apollo-skills', { ns: 'apollo-skills', revision: 1, user: structuredClone(apolloOverride ?? {}), value: deepMerge(APOLLO_DEFAULT, source), base: APOLLO_DEFAULT }],
    [SUBAGENT_NS, { ns: SUBAGENT_NS, revision: 1, user: deepMerge({}, targetUser), value: deepMerge(SUBAGENT_BASE, targetUser), base: SUBAGENT_BASE }],
    [COMPACT_NS, { ns: COMPACT_NS, revision: 1, user: deepMerge({}, compactUser), value: deepMerge(COMPACT_BASE, compactUser), base: COMPACT_BASE }],
  ])
  const updates = []
  const edits = []
  const entries = [
    { options: { id: SUBAGENT_NS, name: '@menghuan1918/dsh-better-subagent', config: {} } },
    { options: { id: 'apollo-skills', name: '@menghuan1918/dsh-apollo', config: apolloRaw } },
    ...presets.map((preset) => ({ options: preset })),
    ...entriesExtra,
  ]
  const settings = {
    updates,
    entries,
    edits,
    async describe() { return [...descriptors.values()].map((row) => structuredClone(row)) },
    async update(ns, patch, revision) {
      const row = descriptors.get(ns)
      assert.ok(row, `unknown namespace ${ns}`)
      assert.equal(revision, row.revision, 'update must use the observed revision')
      updates.push({ ns, patch: structuredClone(patch) })
      row.user = deepMerge(row.user, patch)
      row.value = deepMerge(row.value, patch)
      row.revision += 1
    },
    async fail() { throw new Error('host rejected the write') },
  }
  const configEditor = {
    entries: () => entries,
    configuration: () => entries.map((entry) => ({
      entry,
      inherited: {},
      override: structuredClone(entry.options.id === 'apollo-skills'
        ? (apolloOverride ?? {})
        : (presetOverrides[entry.options.id] ?? {})),
    })),
    async edit(entry, change) {
      edits.push({ id: entry.options.id })
      entry.options.config = change(structuredClone(entry.options.config))
    },
  }
  return {
    descriptors,
    updates,
    edits,
    entries,
    settings,
    configEditor,
    agentPresets: { defaultId },
    log: { warnings: [], infos: [], warn(message) { this.warnings.push(message) }, info(message) { this.infos.push(message) } },
  }
}

test('runMigration：子代理 + compact + trustedHosts 一次补齐，重读验证后 complete', async () => {
  const host = fakeHost({
    source: {
      exitGuard: true,
      tiers: { fast: { provider: 'p', model: 'm', reasoningEffort: 'high' }, quality: { ...EMPTY_TIER } },
      subagents: { ...APOLLO_DEFAULT.subagents, global: true },
      trustedHosts: ['proxy.local'],
    },
    presets: [PRESET('preset-eng', { auto: false, thresholdRatio: 0.7 })],
  })
  const result = await runMigration({ get: (name) => service(name), settings: host.settings, logger: host.log }, {
    configEditor: host.configEditor,
    agentPresets: host.agentPresets,
    timeoutMs: 50,
    intervalMs: 5,
  })
  function service(name) {
    return name === 'settings' ? host.settings : name === 'configEditor' ? host.configEditor : name === 'agentPresets' ? host.agentPresets : undefined
  }
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.deepEqual(host.updates.map((entry) => entry.ns), [SUBAGENT_NS, COMPACT_NS])
  assert.equal(host.updates[0].patch.childExitGuard, true)
  assert.equal(host.updates[0].patch.subagents.global, true)
  assert.deepEqual(host.updates[1].patch, { auto: false, thresholdRatio: 0.7 })
  assert.deepEqual(host.edits, [{ id: SUBAGENT_NS }])
  assert.deepEqual(host.entries[0].options.config.trustedHosts, ['proxy.local'])
  assert.equal(host.descriptors.get(SUBAGENT_NS).value.tiers.fast.provider, 'p')
})

test('runMigration：幂等——第二次运行不再写入', async () => {
  const host = fakeHost({
    source: { exitGuard: true, tiers: { fast: { provider: 'p', model: 'm' }, quality: { ...EMPTY_TIER } }, trustedHosts: ['proxy.local'] },
    presets: [PRESET('preset-eng', { auto: false })],
  })
  const ctx = {
    get: (name) => (name === 'settings' ? host.settings : undefined),
    settings: host.settings,
    logger: host.log,
  }
  const first = await runMigration(ctx, { configEditor: host.configEditor, agentPresets: host.agentPresets, timeoutMs: 50, intervalMs: 5 })
  assert.equal(first.status, 'complete')
  const updatesAfterFirst = host.updates.length
  const second = await runMigration(ctx, { configEditor: host.configEditor, agentPresets: host.agentPresets, timeoutMs: 50, intervalMs: 5 })
  assert.equal(second.status, 'complete')
  assert.equal(host.updates.length, updatesAfterFirst, '目标已有显式值 → 不再写')
  assert.equal(host.edits.length, 1, 'trustedHosts 也只写一次')
})

test('runMigration：旧 profile 行被 name guard 跳过时，用 configuration().override 恢复显式值', async () => {
  const host = fakeHost({
    // The Loader skipped the old `name: dsh-apollo` row: the effective Apollo
    // config is the default (eng=true, exitGuard=false), while the raw profile
    // override still carries the user's explicit values.
    source: {},
    apolloRaw: {},
    apolloOverride: { subagents: { eng: false }, exitGuard: true },
  })
  const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
  const result = await runMigration(ctx, { configEditor: host.configEditor, timeoutMs: 50, intervalMs: 5 })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(host.updates[0].ns, SUBAGENT_NS)
  assert.equal(host.updates[0].patch.childExitGuard, true, 'override exitGuard 必须迁移')
  assert.equal(host.updates[0].patch.subagents.eng, false, '被跳过的显式 false 必须迁移，不能写 effective true')
  assert.equal(host.descriptors.get(SUBAGENT_NS).value.subagents.eng, false)
  assert.equal(host.descriptors.get(SUBAGENT_NS).value.childExitGuard, true)
  assert.equal(host.descriptors.get('apollo-skills').value.exitGuard, true, '同一旧初值也恢复 job 守卫')
  assert.equal(result.job.status, 'complete')
})

test('runMigration：job 和 child 目标显式 false 各自优先，不覆盖或串扰', async () => {
  for (const [jobFalse, childFalse] of [[true, false], [false, true], [true, true]]) {
    const host = fakeHost({
      apolloRaw: jobFalse ? { exitGuard: false } : {},
      apolloOverride: { exitGuard: true },
      targetUser: childFalse ? { childExitGuard: false } : {},
    })
    const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
    const result = await runMigration(ctx, { configEditor: host.configEditor, timeoutMs: 50, intervalMs: 5 })
    assert.equal(result.status, 'complete', JSON.stringify(result))
    assert.equal(host.descriptors.get('apollo-skills').value.exitGuard, !jobFalse)
    assert.equal(host.descriptors.get(SUBAGENT_NS).value.childExitGuard, !childFalse)
    assert.equal(host.updates.some((row) => row.ns === 'apollo-skills'), !jobFalse)
    assert.equal(host.updates.some((row) => row.ns === SUBAGENT_NS), !childFalse)
  }
})

test('runMigration：child 写入失败时不遮住旧来源，job 写入失败或未生效不宣告成功', async () => {
  for (const failure of ['child-rejected', 'job-rejected', 'job-unverified']) {
    const host = fakeHost({ apolloRaw: {}, apolloOverride: { exitGuard: true } })
    const update = host.settings.update
    host.settings.update = async (ns, patch, revision) => {
      if (failure === 'child-rejected' && ns === SUBAGENT_NS) throw new Error('child write rejected')
      if (failure === 'job-rejected' && ns === 'apollo-skills') throw new Error('job write rejected')
      if (failure === 'job-unverified' && ns === 'apollo-skills') return
      await update(ns, patch, revision)
    }
    const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
    const result = await runMigration(ctx, { configEditor: host.configEditor, timeoutMs: 50, intervalMs: 5 })
    assert.equal(result.status, failure === 'job-unverified' ? 'error' : 'pending')
    assert.equal(host.descriptors.get('apollo-skills').value.exitGuard, false)
    if (failure === 'child-rejected') {
      assert.equal(host.updates.length, 0, 'do not append a scoped job override that masks an unimported legacy source')
    } else {
      assert.equal(result.job.status, failure === 'job-unverified' ? 'error' : 'pending')
      assert.match(result.job.error, failure === 'job-unverified' ? /unverified: exitGuard/ : /job write rejected/)
    }
  }
})

test('runMigration：预设 override 被 name guard 跳过时仍读取其原生压缩配置', async () => {
  const host = fakeHost({
    presets: [PRESET('preset-eng')],
    presetOverrides: {
      'preset-eng': {
        id: 'eng',
        order: 10,
        plugins: [COMPACTION_GROUP({ auto: false, thresholdRatio: 0.6 })],
      },
    },
    defaultId: 'eng',
  })
  const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
  const result = await runMigration(ctx, { configEditor: host.configEditor, agentPresets: host.agentPresets, timeoutMs: 50, intervalMs: 5 })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  const compactPatch = host.updates.find((entry) => entry.ns === COMPACT_NS)?.patch
  assert.deepEqual(compactPatch, { auto: false, thresholdRatio: 0.6 })
})

test('runMigration：目标命名空间缺失 → pending，明确要求重载', async () => {
  const host = fakeHost()
  host.descriptors.delete(SUBAGENT_NS)
  const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
  const result = await runMigration(ctx, { configEditor: host.configEditor, timeoutMs: 20, intervalMs: 5 })
  assert.equal(result.status, 'pending')
  assert.match(result.error, /Reload the profile/)
  assert.equal(host.updates.length, 0)
  assert.match(host.log.warnings.join('\n'), /apollo-migration: pending/)
})

test('runMigration：两个预设显式配置不同且默认预设无法确定 → compact blocked，不写目标', async () => {
  const host = fakeHost({
    presets: [PRESET('preset-eng', { auto: false }), PRESET('preset-eng-ptc', { auto: true })],
    defaultId: 'standard',
  })
  const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
  const result = await runMigration(ctx, { configEditor: host.configEditor, agentPresets: host.agentPresets, timeoutMs: 50, intervalMs: 5 })
  assert.equal(result.status, 'blocked')
  assert.equal(result.compact.status, 'ambiguous')
  assert.deepEqual(host.updates.map((entry) => entry.ns), [], '子代理无来源时无写入；compact 不猜')
  assert.match(host.log.warnings.join('\n'), /ambiguous/)
})

test('runMigration：目标写入被拒绝 → pending，保留旧来源且不宣告成功', async () => {
  const host = fakeHost({ source: { exitGuard: true } })
  host.settings.update = async () => { throw new Error('SETTINGS_CONFLICT') }
  const ctx = { get: () => undefined, settings: host.settings, logger: host.log }
  const result = await runMigration(ctx, { configEditor: host.configEditor, timeoutMs: 50, intervalMs: 5 })
  assert.equal(result.status, 'pending')
  assert.match(result.subagent.error, /SETTINGS_CONFLICT/)
  assert.match(host.log.warnings.join('\n'), /subagent is pending: SETTINGS_CONFLICT/, 'pending 原因必须写进日志')
  assert.equal(host.descriptors.get(SUBAGENT_NS).value.childExitGuard, false, '旧来源未被删除/篡改')
})

test('migrateSubagent/migrateCompact：可直接用描述符调用（真实宿主测试的接缝）', async () => {
  const host = fakeHost({
    source: { exitGuard: false },
    presets: [PRESET('preset-eng', { maxOverflowRetries: 0 })],
    targetUser: { childExitGuard: true },
  })
  const descriptors = await host.settings.describe()
  const subagent = await migrateSubagent({ settings: host.settings, configEditor: host.configEditor, descriptors, source: { exitGuard: true }, log: host.log })
  assert.equal(subagent.status, 'no-change', '目标显式 childExitGuard 优先')
  const compact = await migrateCompact({ settings: host.settings, configEditor: host.configEditor, descriptors, agentPresets: host.agentPresets, log: host.log })
  assert.equal(compact.status, 'complete')
  assert.deepEqual(compact.fields, ['maxOverflowRetries'])
})

test('migrateSubagent：旧 trustedHosts 存在但目标行不可寻址 → pending，不静默丢弃', async () => {
  const host = fakeHost({ source: { trustedHosts: ['proxy.local'] } })
  const descriptors = await host.settings.describe()
  const result = await migrateSubagent({
    settings: host.settings,
    configEditor: undefined,
    descriptors,
    source: { trustedHosts: ['proxy.local'] },
    log: host.log,
  })
  assert.equal(result.status, 'pending')
  assert.match(result.error, /trustedHosts.*not addressable/)
})

test('waitForDescriptors：目标出现后立即返回；超时返回 undefined', async () => {
  const settings = { describe: async () => [{ ns: SUBAGENT_NS }, { ns: COMPACT_NS }] }
  const rows = await waitForDescriptors(settings, [SUBAGENT_NS, COMPACT_NS], { timeoutMs: 10, intervalMs: 1 })
  assert.equal(rows.length, 2)
  const missing = await waitForDescriptors({ describe: async () => [] }, [SUBAGENT_NS], { timeoutMs: 10, intervalMs: 2 })
  assert.equal(missing, undefined)
})

test('mountMigration：不阻塞 inject，通知正常结果与意外错误', async () => {
  for (const throws of [false, true]) {
    const results = []
    let start
    const ctx = { inject: (_names, callback) => { start = callback } }
    mountMigration(ctx, {}, { onResult: (result) => { results.push(result) } })
    const settings = throws ? { describe: async () => { throw new Error('describe failed') } } : undefined
    assert.equal(start({ get: () => settings }), undefined, 'inject callback must not block Loader settlement')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(results.length, 1)
    assert.equal(results[0].status, throws ? 'error' : 'pending')
    assert.match(results[0].error, throws ? /describe failed/ : /settings service is unavailable/)
  }
})

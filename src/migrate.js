/**
 * dsh-apollo —— 旧配置迁移（src/migrate.js）。
 *
 * 0.5.0 把子代理增强与压缩能力移入两个独立插件；已经保存在旧 Apollo profile
 * 里的设置不能悄悄丢掉。本模块在 Apollo 行装配后运行一次（可重复执行），把
 * 旧值补进目标行的缺失字段：
 *
 *   - `apollo-skills` 的 `tiers.fast/quality`、`subagents.{eng,global}`、
 *     `subagents.{codex,claude}.*`、`trustedHosts` → `dsh-better-subagent`
 *     相同路径；`exitGuard` → `childExitGuard`。旧 `exitGuard` 同时保留/恢复到
 *     Apollo 作为 job 守卫开关；两边目标显式配置（含 false）各自优先。
 *   - 旧 `eng` / `eng-ptc` 预设里原生 `compaction-basic` 的显式配置 →
 *     `dsh-better-compact` 同名原生键；目标缺失的 `mode` 采用默认 `goal`。
 *
 * 规则（与 S4 Spec 一致）：
 *   - 目标行的**显式用户值优先**（`settings.describe().user` 的存在性，不是值），
 *     来源只补目标缺失字段；
 *   - 显式 false / 0 / '' / [] 是值，不是缺失；来源只携带**显式配置**，不把
 *     原生默认值搬成目标显式值（与目标生效默认相同就跳过）；
 *   - volatile 字段用 `settings.update(ns, patch, revision)`；非 volatile 的
 *     `trustedHosts` 用 `configEditor.edit`（不绕过宿主字段限制）；
 *   - 写入后重读验证；验证失败不宣告成功，也不删除任何旧值；
 *   - 目标命名空间尚未出现/不可写时（例如双 bundle 同时显式选中导致
 *     unaddressable）报告 pending，要求重载 profile；
 *   - 迁移本身不删旧配置、不复制 CLI KV、不复制 goal 状态；重复执行无副作用。
 *
 * 零第三方依赖。
 */

import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { ENTRY_ID, normalizeConfig } from './config.js'

/** Target namespace/row ids owned by the independent plugins. */
export const SUBAGENT_NS = 'dsh-better-subagent'
export const COMPACT_NS = 'dsh-better-compact'
/** Apollo's own row id. */
export const APOLLO_NS = ENTRY_ID
/** Apollo preset identity → Loader row id. */
export const PRESET_ROWS = Object.freeze({ eng: 'preset-eng', 'eng-ptc': 'preset-eng-ptc' })
/** Bounded wait for the target namespace descriptors (ms). */
export const WAIT_TIMEOUT_MS = 5_000
/** Poll interval while waiting for descriptors (ms). */
export const WAIT_INTERVAL_MS = 50
/** Native compaction keys carried from the old Apollo preset row. */
export const COMPACT_KEYS = Object.freeze([
  'auto',
  'thresholdRatio',
  'headroomTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
])

/** Plain data object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Own property check (explicit presence, regardless of value). */
function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key)
}

/** Clone plain JSON-shaped data (configEditor/settings already detach their I/O). */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/**
 * Deep-merge an explicit profile override over an effective config.
 *
 * DSH applies a profile row's `name` as a guard: an old row whose name no
 * longer matches the active row (for example the historical
 * `name: dsh-apollo` on `apollo-skills`) is skipped by the Loader, yet
 * `configEditor.configuration().override` still exposes its explicit config.
 * Merging that override back over the effective config recovers the user's
 * explicit values during migration.
 *
 * Plain objects merge recursively; arrays and every scalar - including
 * explicit `false`, `0`, `""` and `[]` - replace the base value.
 *
 * @param base - effective config (defaults + applied layers).
 * @param override - raw explicit profile override; undefined means "no override".
 * @returns a detached merged value.
 */
export function mergeConfigOverride(base, override) {
  if (override === undefined) return clone(base)
  if (!isRecord(base) || !isRecord(override)) return clone(override)
  const result = clone(base)
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? mergeConfigOverride(result[key], value)
      : clone(value)
  }
  return result
}

/** Assign a nested path into a patch object. */
function setPatch(patch, keys, value) {
  let node = patch
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {}
    node = node[key]
  }
  node[keys[keys.length - 1]] = value
}

/**
 * Plan the `dsh-better-subagent` patch from Apollo's effective config.
 *
 * @param source - Apollo effective config (`normalizeConfig` shape).
 * @param targetUser - target `settings.describe().user` projection (explicit values).
 * @param targetBase - target `settings.describe().base` projection (resolved defaults).
 * @returns `{ patch, fields }`.
 */
export function planSubagentMigration({ source, targetUser, targetBase }) {
  const from = normalizeConfig(source)
  const user = isRecord(targetUser) ? targetUser : {}
  const base = isRecord(targetBase) ? targetBase : {}
  const patch = {}
  const fields = []

  const fill = (keys, value, baseValue) => {
    if (deepEqual(value, baseValue)) return
    setPatch(patch, keys, clone(value))
    fields.push(keys.join('.'))
  }

  if (!hasOwn(user, 'childExitGuard')) {
    fill(['childExitGuard'], from.exitGuard, base.childExitGuard ?? false)
  }

  const userTiers = isRecord(user.tiers) ? user.tiers : {}
  const baseTiers = isRecord(base.tiers) ? base.tiers : {}
  for (const tier of ['fast', 'quality']) {
    // A tier is one routing unit: if the target already has any explicit tier
    // field, leave the whole tier alone instead of mixing two routes.
    if (isRecord(userTiers[tier]) && Object.keys(userTiers[tier]).length > 0) continue
    fill(['tiers', tier], from.tiers[tier], baseTiers[tier] ?? { provider: '', model: '', reasoningEffort: '' })
  }

  const userSubagents = isRecord(user.subagents) ? user.subagents : {}
  const baseSubagents = isRecord(base.subagents) ? base.subagents : {}
  for (const scope of ['eng', 'global']) {
    if (hasOwn(userSubagents, scope)) continue
    fill(['subagents', scope], from.subagents[scope], baseSubagents[scope])
  }
  for (const cli of ['codex', 'claude']) {
    const userBackend = isRecord(userSubagents[cli]) ? userSubagents[cli] : {}
    const baseBackend = isRecord(baseSubagents[cli]) ? baseSubagents[cli] : {}
    for (const [field, value] of Object.entries(from.subagents[cli])) {
      if (hasOwn(userBackend, field)) continue
      fill(['subagents', cli, field], value, baseBackend[field])
    }
  }
  return { patch, fields }
}

/**
 * Plan the non-volatile `trustedHosts` write (separate because it goes through
 * `configEditor.edit`, not `settings.update`).
 *
 * @param source - Apollo effective config.
 * @param targetRaw - target row's raw composed config (`entry.options.config`).
 * @returns hosts array, or undefined when the target already declares the field
 *   or the source is empty.
 */
export function planTrustedHostsMigration({ source, targetRaw }) {
  if (hasOwn(targetRaw, 'trustedHosts')) return undefined
  const hosts = normalizeConfig(source).trustedHosts
  return hosts.length === 0 ? undefined : hosts
}

/** Recursively collect `cordis:group` rows from a preset `plugins` list. */
function groupRows(rows, found = []) {
  if (!Array.isArray(rows)) return found
  for (const row of rows) {
    if (!isRecord(row) || row.group !== true || !Array.isArray(row.config)) continue
    found.push(row)
    groupRows(row.config, found)
  }
  return found
}

/** Find the native `compaction-basic` row inside a preset declaration. */
function findCompactionRow(rows) {
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (row.id === 'compaction-basic') return row
    if (row.group === true && Array.isArray(row.config)) {
      const nested = findCompactionRow(row.config)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Extract the explicit native compaction config from one preset declaration.
 *
 * Only explicit values are returned: a preset row without a `compaction-basic`
 * `config` (the shipped default) yields undefined, so native defaults are never
 * promoted into target explicit values.
 *
 * @param presetConfig - top-level preset row `config` (`{ id, plugins, ... }`).
 * @returns the explicit config object, or undefined.
 */
export function compactionConfigOf(presetConfig) {
  const row = findCompactionRow(presetConfig?.plugins)
  if (!isRecord(row?.config)) return undefined
  return Object.keys(row.config).length === 0 ? undefined : row.config
}

/**
 * Select the compaction source preset.
 *
 * `defaultId` is the registry's effective default preset. When it names an
 * Apollo preset, that row is authoritative; otherwise a single explicit source
 * (or identical sources) is used, and differing explicit sources are reported
 * as ambiguous instead of guessed.
 *
 * @param presets - `[{ rowId, presetId?, config }]` top-level preset rows.
 * @param defaultId - effective default preset id, or undefined.
 * @returns source selection.
 */
export function selectCompactionSource(presets, defaultId) {
  const rows = (Array.isArray(presets) ? presets : []).filter((row) => isRecord(row))
  const activeRow = PRESET_ROWS[defaultId]
  if (activeRow !== undefined) {
    const row = rows.find((candidate) => candidate.rowId === activeRow)
    if (row === undefined) return { status: 'source-missing', rowId: activeRow }
    const config = compactionConfigOf(row.config)
    return config === undefined
      ? { status: 'absent', rowId: activeRow }
      : { status: 'determined', rowId: activeRow, config }
  }
  const explicit = rows
    .map((row) => ({ rowId: row.rowId, config: compactionConfigOf(row.config) }))
    .filter((entry) => entry.config !== undefined)
  if (explicit.length === 0) return { status: 'absent' }
  const [first] = explicit
  if (explicit.every((entry) => isDeepStrictEqual(entry.config, first.config))) {
    return { status: 'determined', rowId: first.rowId, config: first.config, shared: true }
  }
  return { status: 'ambiguous', rowIds: explicit.map((entry) => entry.rowId) }
}

/**
 * Plan the `dsh-better-compact` patch from a selected native compaction config.
 *
 * @param source - explicit native compaction config.
 * @param targetUser - target `settings.describe().user`.
 * @param targetBase - target `settings.describe().base`.
 * @returns `{ status, patch, reason? }`; only `planned` carries writes.
 */
export function planCompactMigration({ source, targetUser, targetBase }) {
  if (!isRecord(source)) return { status: 'absent', patch: {} }
  const user = isRecord(targetUser) ? targetUser : {}
  const base = isRecord(targetBase) ? targetBase : {}
  const patch = {}
  const fields = []
  const invalid = (reason) => ({ status: 'invalid', patch: {}, reason })

  const ratio = hasOwn(source, 'retainRatio')
  const tokens = hasOwn(source, 'retainTokens')
  if (ratio && tokens) {
    return invalid('the native source sets both retainRatio and retainTokens')
  }
  const provider = hasOwn(source, 'summarizationProvider')
  const model = hasOwn(source, 'summarizationModel')
  if (provider !== model) {
    return invalid('the native source sets only one of summarizationProvider / summarizationModel')
  }
  // The summary route is one pair: if the target declares either half, leave
  // both alone instead of mixing the target provider with a source model.
  const targetOwnsSummaryPair = hasOwn(user, 'summarizationProvider') || hasOwn(user, 'summarizationModel')
  const fill = (key, value, baseValue) => {
    if (hasOwn(user, key) || isDeepStrictEqual(value, baseValue)) return
    patch[key] = clone(value)
    fields.push(key)
  }
  for (const key of COMPACT_KEYS) {
    if (!hasOwn(source, key)) continue
    if (targetOwnsSummaryPair && (key === 'summarizationProvider' || key === 'summarizationModel')) continue
    fill(key, source[key], base[key])
  }
  if (ratio || tokens) {
    if (!hasOwn(user, 'retainRatio') && !hasOwn(user, 'retainTokens')) {
      const key = tokens ? 'retainTokens' : 'retainRatio'
      fill(key, source[key], base[key])
    }
  }
  // New installs default to goal. Only add it when this migration actually
  // carries a source config and the target does not choose another mode.
  if (fields.length > 0 && !hasOwn(user, 'mode') && base.mode !== 'goal') {
    patch.mode = 'goal'
    fields.push('mode')
  }
  return fields.length === 0
    ? { status: 'no-change', patch: {}, fields }
    : { status: 'planned', patch, fields }
}

/** Deep equality for JSON-shaped values. */
function deepEqual(left, right) {
  return isDeepStrictEqual(left, right)
}

/** Read one value from a nested plain object. */
function readPath(value, keys) {
  let node = value
  for (const key of keys) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

/**
 * Verify a planned subagent patch against the re-read target descriptor.
 *
 * @returns array of mismatched paths (empty = verified).
 */
export function verifySubagentMigration({ patch, targetValue }) {
  const mismatched = []
  const visit = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      const next = [...path, key]
      if (isRecord(value) && !Array.isArray(value)) visit(value, next)
      else if (!deepEqual(readPath(targetValue, next), value)) mismatched.push(next.join('.'))
    }
  }
  visit(patch, [])
  return mismatched
}

/** Verify a planned compact patch against the re-read target descriptor. */
export function verifyCompactMigration({ patch, targetValue }) {
  return Object.entries(patch)
    .filter(([key, value]) => !deepEqual(targetValue?.[key], value))
    .map(([key]) => key)
}

/** Get the Loader service (root loader) or undefined. */
function loaderOf(ctx) {
  try {
    const direct = ctx.get?.('loader')
    if (typeof direct?.await === 'function') return direct
  } catch {
    // Test fakes may not provide get().
  }
  try {
    const root = ctx.root?.loader
    return typeof root?.await === 'function' ? root : undefined
  } catch {
    return undefined
  }
}

/** Resolve optional services without requiring inject. */
function serviceOf(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/** Bound a promise by a timeout; resolves undefined on timeout. */
async function bounded(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait (bounded) until every target namespace is present in `describe()`.
 *
 * @returns descriptors array, or undefined on timeout.
 */
export async function waitForDescriptors(settings, namespaces, options = {}) {
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? WAIT_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const descriptors = await settings.describe()
    const rows = Array.isArray(descriptors) ? descriptors : []
    if (namespaces.every((ns) => rows.some((row) => row?.ns === ns))) return rows
    if (Date.now() >= deadline) return undefined
    await delay(intervalMs)
  }
}

/** Current default preset id, when the registry is present. */
function defaultPresetOf(agentPresets) {
  try {
    const id = agentPresets?.defaultId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** Read one row's raw profile override from configEditor.configuration(). */
function configurationOverrideOf(configEditor, id) {
  try {
    const rows = configEditor?.configuration?.()
    if (!Array.isArray(rows)) return undefined
    const row = rows.find((candidate) => candidate?.entry?.options?.id === id)
    return isRecord(row?.override) ? row.override : undefined
  } catch {
    return undefined
  }
}

/**
 * Top-level preset declarations visible to configEditor.entries().
 *
 * A preset override whose `name` guard no longer matches is skipped by the
 * Loader, so merge the configuration override back before reading its native
 * `compaction-basic` config. Array values (the child `plugins` list) replace
 * wholesale, matching DSH's preset-override semantics.
 */
function presetRowsOf(configEditor) {
  let entries
  try {
    entries = configEditor?.entries?.()
  } catch {
    entries = undefined
  }
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry?.options?.name === '@deepseek-ai/dsh-agent-preset')
    .map((entry) => {
      const base = isRecord(entry.options.config) ? entry.options.config : {}
      const override = configurationOverrideOf(configEditor, entry.options.id)
      const config = override === undefined ? base : mergeConfigOverride(base, override)
      return {
        rowId: entry.options.id,
        presetId: config.id,
        config,
      }
    })
}

/** Find the target row entry (needed for the non-volatile trustedHosts write). */
function targetEntryOf(configEditor, ns) {
  try {
    return configEditor?.entries?.().find((entry) => entry?.options?.id === ns)
  } catch {
    return undefined
  }
}

/**
 * Apply the subagent migration.
 *
 * @returns `{ status, fields, error? }`.
 */
export async function migrateSubagent({ settings, configEditor, descriptors, source, log }) {
  const target = descriptors.find((row) => row?.ns === SUBAGENT_NS)
  if (target === undefined) return { status: 'pending', fields: [], error: 'target namespace is not readable' }
  const { patch, fields } = planSubagentMigration({
    source,
    targetUser: target.user,
    targetBase: target.base,
  })
  const entry = targetEntryOf(configEditor, SUBAGENT_NS)
  const wantedHosts = normalizeConfig(source).trustedHosts
  const targetDeclaresHosts = hasOwn(entry?.options?.config, 'trustedHosts')
  // A target row that cannot be addressed cannot receive the non-volatile
  // deployment field; report it instead of silently dropping the old value.
  const trustedHostsBlocked = wantedHosts.length > 0 && !targetDeclaresHosts
    && (entry === undefined || configEditor === undefined || typeof configEditor.edit !== 'function')
  const trustedHosts = entry === undefined || targetDeclaresHosts
    ? undefined
    : planTrustedHostsMigration({ source, targetRaw: entry.options?.config })
  if (fields.length === 0 && trustedHosts === undefined) {
    return trustedHostsBlocked
      ? { status: 'pending', fields, error: 'old trustedHosts could not be migrated: the target row is not addressable' }
      : { status: 'no-change', fields }
  }
  if (!settings || typeof settings.update !== 'function') {
    return { status: 'pending', fields, error: 'settings service is unavailable' }
  }
  try {
    if (fields.length > 0) await settings.update(SUBAGENT_NS, patch, target.revision)
    if (trustedHosts !== undefined) {
      // settings.update reconciles profile patches, which may replace the
      // target row's Loader entry; re-read it before the non-volatile write.
      const fresh = targetEntryOf(configEditor, SUBAGENT_NS)
      if (configEditor === undefined || fresh === undefined) {
        return { status: 'pending', fields, error: 'trustedHosts needs the config editor, which is unavailable' }
      }
      await configEditor.edit(fresh, (current) => ({ ...current, trustedHosts }))
    }
  } catch (error) {
    return { status: 'pending', fields, error: errorMessage(error) }
  }
  const after = (await settings.describe()).find((row) => row?.ns === SUBAGENT_NS)
  const mismatched = verifySubagentMigration({ patch, targetValue: after?.value })
  if (trustedHosts !== undefined) {
    const raw = targetEntryOf(configEditor, SUBAGENT_NS)?.options?.config
    if (!deepEqual(raw?.trustedHosts, trustedHosts)) mismatched.push('trustedHosts')
  }
  if (mismatched.length > 0) {
    log?.warn?.(`apollo-migration: ${SUBAGENT_NS} write could not be verified: ${mismatched.join(', ')}`)
    return { status: 'error', fields, error: `unverified: ${mismatched.join(', ')}` }
  }
  if (trustedHostsBlocked) {
    return { status: 'pending', fields, error: 'old trustedHosts could not be migrated: the target row is not addressable' }
  }
  return { status: 'complete', fields }
}

/** Restore only the job switch lost to a historical Apollo name guard. */
async function migrateJobExitGuard({ settings, descriptors, source, rawSource }) {
  const target = descriptors.find((row) => row?.ns === APOLLO_NS)
  // user also projects skipped overrides, so the active raw config is the
  // authority for an already configured job switch (including explicit false).
  if (hasOwn(rawSource, 'exitGuard')
    || (hasOwn(target?.user, 'exitGuard') && target.user.exitGuard !== source.exitGuard)
    || target?.value?.exitGuard === source.exitGuard) {
    return { status: 'no-change' }
  }
  if (target === undefined) return { status: 'pending', error: 'Apollo namespace is not readable' }
  try {
    await settings.update(APOLLO_NS, { exitGuard: source.exitGuard }, target.revision)
  } catch (error) {
    return { status: 'pending', error: errorMessage(error) }
  }
  const after = (await settings.describe()).find((row) => row?.ns === APOLLO_NS)
  return after?.value?.exitGuard === source.exitGuard
    ? { status: 'complete' }
    : { status: 'error', error: 'unverified: exitGuard' }
}

/**
 * Apply the compaction migration.
 *
 * @returns `{ status, fields?, sourcePreset?, reason?, error? }`.
 */
export async function migrateCompact({ settings, configEditor, descriptors, agentPresets, log }) {
  const target = descriptors.find((row) => row?.ns === COMPACT_NS)
  if (target === undefined) return { status: 'pending', error: 'target namespace is not readable' }
  const selected = selectCompactionSource(presetRowsOf(configEditor), defaultPresetOf(agentPresets))
  if (selected.status !== 'determined') {
    if (selected.status === 'ambiguous') {
      log?.warn?.(`apollo-migration: native compaction config is ambiguous (${selected.rowIds.join(', ')} differ); ` +
        `choose the active preset / keep one source and reload to migrate ${COMPACT_NS}`)
    } else if (selected.status === 'source-missing') {
      log?.warn?.(`apollo-migration: default preset row "${selected.rowId}" is not readable, so the old native ` +
        `compaction config cannot be imported. Configure ${COMPACT_NS} directly, or restore the preset row and reload.`)
    }
    return selected
  }
  const plan = planCompactMigration({ source: selected.config, targetUser: target.user, targetBase: target.base })
  if (plan.status === 'invalid') {
    log?.warn?.(`apollo-migration: native compaction config from "${selected.rowId}" cannot be migrated: ${plan.reason}`)
  }
  if (plan.status !== 'planned') return { ...plan, sourcePreset: selected.rowId }
  try {
    await settings.update(COMPACT_NS, plan.patch, target.revision)
  } catch (error) {
    return { status: 'pending', sourcePreset: selected.rowId, error: errorMessage(error) }
  }
  const after = (await settings.describe()).find((row) => row?.ns === COMPACT_NS)
  const mismatched = verifyCompactMigration({ patch: plan.patch, targetValue: after?.value })
  if (mismatched.length > 0) {
    log?.warn?.(`apollo-migration: ${COMPACT_NS} write could not be verified: ${mismatched.join(', ')}`)
    return { status: 'error', sourcePreset: selected.rowId, error: `unverified: ${mismatched.join(', ')}` }
  }
  return { status: 'complete', sourcePreset: selected.rowId, fields: plan.fields }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the one-time (idempotent) migration.
 *
 * Order: Loader settlement → legacy `eng.json` import → bounded wait for both
 * target namespaces → subagent plan/write/verify → job switch recovery →
 * compact plan/write/verify.
 * A missing target namespace yields `pending`; errors are reported, never
 * silently claimed as success, and no source value is deleted.
 *
 * @param ctx - context with the settings service and (usually) configEditor.
 * @param options - `{ config, legacyImport, timeoutMs, intervalMs }`.
 * @returns status report; never throws for migration failures (caller logs it).
 */
export async function runMigration(ctx, options = {}) {
  const settings = ctx.get?.('settings') ?? ctx.settings
  const log = options.log ?? ctx.logger
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS
  if (typeof settings?.describe !== 'function') {
    return { status: 'pending', error: 'settings service is unavailable' }
  }
  const loader = loaderOf(ctx)
  if (loader !== undefined) await bounded(Promise.resolve(loader.await()).catch(() => undefined), timeoutMs)
  if (options.legacyImport !== undefined) await bounded(options.legacyImport, timeoutMs)
  const descriptors = await waitForDescriptors(settings, [SUBAGENT_NS, COMPACT_NS], {
    timeoutMs,
    intervalMs: options.intervalMs,
  })
  if (descriptors === undefined) {
    const message = `apollo-migration: pending — ${SUBAGENT_NS} / ${COMPACT_NS} are not readable/writable yet. ` +
      'Reload the profile after the plugin rows are active; migration will run again and is idempotent.'
    log?.warn?.(message)
    return { status: 'pending', error: message }
  }
  const sourceDescriptor = descriptors.find((row) => row?.ns === APOLLO_NS)
  const configEditor = options.configEditor ?? serviceOf(ctx, 'configEditor')
  const agentPresets = options.agentPresets ?? serviceOf(ctx, 'agentPresets')
  // describe().value only projects the *volatile* form, so read the Apollo
  // row's raw config for non-volatile fields (trustedHosts) and overlay the
  // live volatile values on top. Finally merge the raw profile override:
  // DSH skips a row whose old `name` guard no longer matches (historical
  // `name: dsh-apollo`), and only configuration().override still carries the
  // user's explicit values.
  const rawSource = targetEntryOf(configEditor, APOLLO_NS)?.options?.config
  const sourceBase = {
    ...(isRecord(options.config) ? options.config : {}),
    ...(isRecord(rawSource) ? rawSource : {}),
  }
  const effectiveSource = { ...sourceBase, ...(sourceDescriptor?.value ?? {}) }
  const source = normalizeConfig(mergeConfigOverride(
    effectiveSource,
    configurationOverrideOf(configEditor, APOLLO_NS),
  ))
  const subagent = await migrateSubagent({ settings, configEditor, descriptors, source, log })
  // A scoped job write would become the last override and hide the skipped
  // source from configuration().override. Wait until its child fields are safe.
  const job = ['complete', 'no-change'].includes(subagent.status)
    ? await migrateJobExitGuard({ settings, descriptors, source, rawSource })
    : { status: 'pending', error: 'waiting for the subagent migration before restoring the job switch' }
  const compact = await migrateCompact({ settings, configEditor, descriptors, agentPresets, log })
  const status = [job.status, subagent.status, compact.status].some((value) => value === 'error')
    ? 'error'
    : [job.status, subagent.status, compact.status].some((value) => value === 'pending')
      ? 'pending'
      : ['ambiguous', 'invalid', 'source-missing'].includes(compact.status) ? 'blocked'
        : 'complete'
  for (const [name, section] of [['job', job], ['subagent', subagent], ['compact', compact]]) {
    if (section.error !== undefined) {
      log?.warn?.(`apollo-migration: ${name} is ${section.status}: ${section.error}`)
    }
  }
  log?.[status === 'complete' ? 'info' : 'warn']?.(
    `apollo-migration: ${status} (job=${job.status}, subagent=${subagent.status}, compact=${compact.status})`,
  )
  return { status, source: sourceDescriptor === undefined ? 'apply-config' : 'settings', job, subagent, compact }
}

/**
 * Mount the migration after Apollo's `settings` service appears.
 *
 * @param ctx - plugin context.
 * @param config - Apollo row config (fallback source when describe() is not ready).
 * @param options - `{ legacyImport, env, timeoutMs, intervalMs, onResult }`.
 *   `onResult` receives the settled report without blocking the Loader callback.
 */
export function mountMigration(ctx, config, options = {}) {
  let started = false
  const start = (settingsCtx) => {
    if (started) return
    started = true
    void runMigration(settingsCtx, {
      config,
      legacyImport: options.legacyImport,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      log: settingsCtx.logger ?? ctx.logger,
    }).catch((error) => {
      settingsCtx.logger?.warn?.(`apollo-migration: skipped: ${errorMessage(error)}`)
      return { status: 'error', error: errorMessage(error) }
    }).then((result) => options.onResult?.(result))
  }
  ctx.inject(['settings'], start)
}

/**
 * dsh-apollo — 单行宿主插件，一个包承担三件事：
 *
 * 1. **流程技能 provider**：把包内 `skills/<name>/SKILL.md` 注册到宿主技能
 *    注册表的全局层，任何挂载 tool-skill 的预设都能看到该目录；
 * 2. **工程模式预设同步**：把包内 `presets/` 树幂等同步进 `<dshHome>/
 *    .agent-presets`，使「工程模式」（eng）预设保持可用且与仓库一致；
 * 3. **设置面板 host 半边**：注册 fenced 的 `/eng-panel/api/config` 路由，
 *    供浏览器半边（`exports["./client"]`）读写 `<dshHome>/eng.json`。
 *
 * 三件事共用一行是因为 DSH 的硬约束：客户端半边的图行 id 必须是包名本身
 * （`dsh-client-modules` 只认裸包名/两段 scoped 名），且同一包名的多个活跃
 * loader 行会被 `reconcilePackage` 判为冲突，所以包只能占一行。
 *
 * 零依赖、无构建步骤；内容随包版本走，无 watcher——改动在进程重启后生效。
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPanel } from './panel.js'
import { dshHome, syncPresetTrees } from './preset-sync.js'

const PROVIDER_NAME = 'dsh-apollo'
/** Rank of bundled contributions in the local-provider ladder (user roots override). */
const BUNDLED_RANK = 600
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SKILLS_DIR = join(PACKAGE_ROOT, 'skills')
const SKILL_NAME = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/

/** Cordis plugin name (the profile row id is `apollo-skills`). */
export const name = 'apollo-skills'
/** Service required by the bundled skill provider. */
export const inject = ['skills']

/** 本包内捆绑的预设树绝对路径（`presets/`，带尾斜杠）。 */
export function bundledPresetsRoot() {
  return `${join(PACKAGE_ROOT, 'presets')}/`
}

/** Register the packaged skills provider, sync the preset tree, mount the panel. */
export function apply(ctx, config) {
  ctx.skills.registerProvider(() => createProvider(ctx))
  syncPresets(ctx)
  if (typeof ctx.inject === 'function') mountPanel(ctx, config)
}

/**
 * 把包内预设树同步进 harness home 的 agent-presets 发现根。
 * 幂等（逐字节对比，跳过已一致的树），重复挂载无害；失败只告警不抛错——
 * 同步故障不应阻止技能 provider 与面板就位。
 * @param ctx - 宿主插件上下文（仅用 `ctx.logger`，可缺省）。
 */
function syncPresets(ctx) {
  const targetRoot = join(dshHome(), '.agent-presets')
  const log = ctx?.logger ?? console
  try {
    const result = syncPresetTrees(bundledPresetsRoot(), targetRoot)
    for (const { id, error } of result.failed) {
      log.warn?.(`dsh-apollo: preset ${id} sync failed: ${error}`)
    }
    if (result.synced.length > 0) {
      log.info?.(`dsh-apollo: presets synced into ${targetRoot}: ${result.synced.join(', ')}`)
    }
    if (result.current.length > 0) {
      log.info?.(`dsh-apollo: presets already current in ${targetRoot}: ${result.current.join(', ')}`)
    }
    if (result.retired.length > 0) {
      log.info?.(`dsh-apollo: retired stale presets from ${targetRoot}: ${result.retired.join(', ')}`)
    }
  } catch (error) {
    log.warn?.(`dsh-apollo: preset sync failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function createProvider(ctx) {
  let discovery
  const observed = () => (discovery ??= discover(ctx))
  return {
    name: PROVIDER_NAME,
    async list() {
      return (await observed()).candidates
    },
    async get(candidate) {
      const entry = (await observed()).byLocator.get(candidate.locator)
      if (entry === undefined) return undefined
      const parsed = await parseSkillFile(entry.file)
      if (parsed === undefined || parsed.name !== entry.name) return undefined
      return {
        ...entry.summary,
        content: parsed.body,
        path: entry.file,
        metadata: parsed.metadata,
      }
    },
  }
}

/** Scan the packaged skills tree once; malformed entries warn and skip. */
async function discover(ctx) {
  const candidates = []
  const byLocator = new Map()
  let entries
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  } catch (error) {
    ctx.logger.warn(`dsh-apollo: skills directory unreadable: ${error.message}`)
    return { candidates, byLocator }
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS_DIR, entry.name, 'SKILL.md')
    const parsed = await parseSkillFile(file)
    if (parsed === undefined) {
      ctx.logger.warn(`dsh-apollo: skill file ${file} ignored: missing or invalid frontmatter`)
      continue
    }
    if (!SKILL_NAME.test(parsed.name)) {
      ctx.logger.warn(`dsh-apollo: skill file ${file} ignored: name "${parsed.name}" is not kebab-case`)
      continue
    }
    const summary = {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: {
        modelInvocable: parsed.disableModelInvocation !== true,
        userInvocable: parsed.userInvocable !== false,
      },
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: dirname(file) },
    }
    const candidate = {
      ...summary,
      rank: BUNDLED_RANK,
      locator: file,
      path: file,
      metadata: parsed.metadata,
    }
    candidates.push(candidate)
    byLocator.set(file, { file, name: parsed.name, summary })
  }
  return { candidates, byLocator }
}

/**
 * Parse one SKILL.md: `---`-fenced frontmatter with single-line `key: value`
 * pairs, then the raw body. Values may be double- or single-quoted; unknown
 * keys are preserved in `metadata`. Returns undefined when the file cannot
 * be read or the frontmatter lacks `name` and `description`.
 */
async function parseSkillFile(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = raw.split('\n')
  if (lines[0] === undefined || lines[0].replace(/\r$/, '') !== '---') return undefined
  const fields = new Map()
  let cursor = 1
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].replace(/\r$/, '')
    if (line === '---') break
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (match === null) return undefined
    fields.set(match[1], unquote(match[2].trim()))
  }
  if (cursor >= lines.length) return undefined
  const name = fields.get('name')
  const description = fields.get('description')
  if (typeof name !== 'string' || name === '' || typeof description !== 'string' || description === '') {
    return undefined
  }
  fields.delete('name')
  fields.delete('description')
  const whenToUse = fields.get('whenToUse')
  const disableModelInvocation = booleanField(fields, 'disable-model-invocation')
  if (disableModelInvocation === null) return undefined
  const userInvocable = booleanField(fields, 'user-invocable')
  if (userInvocable === null) return undefined
  fields.delete('whenToUse')
  fields.delete('disable-model-invocation')
  fields.delete('user-invocable')
  return {
    name,
    description,
    whenToUse,
    disableModelInvocation,
    userInvocable,
    metadata: Object.fromEntries(fields),
    body: lines.slice(cursor + 1).join('\n'),
  }
}

/**
 * Read one frontmatter boolean. Returns undefined for an absent field,
 * true/false for a valid value, and null for a present-but-invalid value,
 * which invalidates the whole file.
 */
function booleanField(fields, key) {
  const value = fields.get(key)
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

/** Strip one pair of matching surrounding quotes. */
function unquote(value) {
  if (value.length >= 2) {
    const head = value[0]
    const tail = value[value.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

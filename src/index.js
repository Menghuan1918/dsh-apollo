/**
 * Apollo's single host row registers bundled skills, its own minimal row
 * settings, and the one-time old-config migration into the independent
 * dsh-better-subagent / dsh-better-compact rows. Presets are still delivered by
 * bundle patches. Browser code remains a no-build closure factory.
 *
 * Apollo no longer implements subagent CLI protocols/routing, the wait tool,
 * capability/model HTTP probes, tier/delegation prompt generation or the child
 * exit guard — those are owned by the standalone plugins and only assembled
 * here through the shared stable rows.
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountMigration } from './migrate.js'
import { mountMigrationAdmission } from './admission.js'
import { mountSettings } from './settings.js'
export { Config } from './config.js'

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

/** Register the packaged skills provider, mount settings and old-config migration. */
export function apply(ctx, config) {
  ctx.skills.registerProvider(() => createProvider(ctx))
  if (typeof ctx.inject === 'function') {
    const onResult = typeof ctx.on === 'function' ? mountMigrationAdmission(ctx) : undefined
    const settings = mountSettings(ctx, config)
    mountMigration(ctx, config, { legacyImport: settings.legacyImport, onResult })
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

/**
 * Temp-profile helper for the Apollo integration smoke and the real-host
 * migration test.
 *
 * Builds a throwaway DSH_HOME/profile from the installed runtime
 * (DSH_PACKAGE_ROOT) plus this repo and the five independent plugin packages.
 * The copies use each package's shipped `files` list, matching a published
 * tarball (no node_modules, .git, tests, scripts or private specs); peers resolve
 * from the same runtime as the host through a symlinked @deepseek-ai scope.
 */

import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const APOLLO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const SUBAGENT_NAME = '@menghuan1918/dsh-better-subagent'
export const COMPACT_NAME = 'dsh-better-compact'
export const GOAL_NAME = 'dsh-better-goal'
export const ASK_NAME = 'dsh-better-ask-user'
export const PTC_NAME = 'dsh-better-ptc'

/** Installed @deepseek-ai/dsh package directory. */
export function dshRoot() {
  const root = process.env.DSH_PACKAGE_ROOT
  if (!root) throw new Error('Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package directory')
  return root
}

/** Absolute path of a sibling host package. */
export function hostPackage(name) {
  return pathToFileURL(join(dirname(dshRoot()), name)).href
}

/** Locate a package installed under this repo's node_modules. */
export function installed(name) {
  const require = createRequire(join(APOLLO_ROOT, 'package.json'))
  return dirname(require.resolve(`${name}/package.json`))
}

/** All four package sources used by the integration scenarios. */
export async function packageSources() {
  const apollo = JSON.parse(await readFile(join(APOLLO_ROOT, 'package.json'), 'utf8'))
  const source = (name) => installed(name)
  const goal = source(GOAL_NAME)
  const subagent = source(SUBAGENT_NAME)
  const compact = source(COMPACT_NAME)
  const ask = source(ASK_NAME)
  const ptc = source(PTC_NAME)
  for (const [name, dir] of [[SUBAGENT_NAME, subagent], [COMPACT_NAME, compact], [GOAL_NAME, goal], [ASK_NAME, ask], [PTC_NAME, ptc]]) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error(`${dir} is not ${name}`)
  }
  const apolloManifest = apollo
  if (apolloManifest.dependencies[SUBAGENT_NAME] !== '0.2.0'
    || apolloManifest.dependencies[COMPACT_NAME] !== '0.1.2'
    || apolloManifest.dependencies[GOAL_NAME] !== '0.2.1'
    || apolloManifest.dependencies[ASK_NAME] !== '0.1.5'
    || apolloManifest.dependencies[PTC_NAME] !== '0.1.0') {
    throw new Error('Apollo dependencies must pin the verification versions')
  }
  return {
    apollo: { name: apolloManifest.name, dir: APOLLO_ROOT, manifest: apolloManifest },
    goal: { name: GOAL_NAME, dir: goal, manifest: JSON.parse(await readFile(join(goal, 'package.json'), 'utf8')) },
    subagent: { name: SUBAGENT_NAME, dir: subagent, manifest: JSON.parse(await readFile(join(subagent, 'package.json'), 'utf8')) },
    compact: { name: COMPACT_NAME, dir: compact, manifest: JSON.parse(await readFile(join(compact, 'package.json'), 'utf8')) },
    ask: { name: ASK_NAME, dir: ask, manifest: JSON.parse(await readFile(join(ask, 'package.json'), 'utf8')) },
    ptc: { name: PTC_NAME, dir: ptc, manifest: JSON.parse(await readFile(join(ptc, 'package.json'), 'utf8')) },
  }
}

/** Copy one package's published files (no dependency tree, no repo-only material). */
async function copyShipped(source, target) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(target, { recursive: true })
  const entries = Array.isArray(manifest.files) && manifest.files.length > 0
    ? manifest.files
    : ['.']
  for (const entry of entries) {
    const from = join(source, entry)
    const to = join(target, entry)
    try {
      await cp(from, to, {
        recursive: true,
        filter: (candidate) => {
          const rel = relative(from, candidate)
          return rel === '' || !rel.split(sep).some((part) => part === 'node_modules' || part === '.git')
        },
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  await cp(join(source, 'package.json'), join(target, 'package.json'))
  for (const optional of ['README.md', 'LICENSE']) {
    try {
      await cp(join(source, optional), join(target, optional))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/** Path of one installed package inside the temp profile. */
export const profilePackage = (dir, name) => join(dir, 'node_modules', ...name.split('/'))

/**
 * Create a profile (headless template) with the supplied bundle packages.
 *
 * @param options.bundles - bundle package names to select (each must be one of the prepared sources).
 * @param options.patch - profile cordis.patch.yml rows (JSON-serializable).
 * @param options.profile - profile name (default 'it').
 * @param options.home - reuse a temp home (reload within one scenario).
 * @returns profile metadata.
 */
export async function prepareProfile(options = {}) {
  const sources = options.sources ?? await packageSources()
  const home = options.home ?? await mkdtemp(join(tmpdir(), options.prefix ?? 'apollo-integration-'))
  process.env.DSH_HOME = resolve(home)
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const appBoot = await import(hostPackage('dsh-app-boot/lib/index.js'))
  const profile = options.profile ?? 'it'
  const dir = appBoot.resolveProfileDir(profile, home)
  const bundles = options.bundles ?? [sources.apollo.name]
  appBoot.initProfile(dir, [...appBoot.PROFILE_TEMPLATES.headless.bundles, ...bundles])
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  const copied = new Map()
  for (const source of [sources.apollo, sources.goal, sources.subagent, sources.compact, sources.ask, sources.ptc]) {
    const target = profilePackage(dir, source.name)
    await copyShipped(source.dir, target)
    copied.set(source.name, target)
  }
  // Peers (and the packages' own @deepseek-ai dependencies) resolve from the
  // same runtime as the host.
  try {
    await symlink(dirname(dshRoot()), join(dir, 'node_modules', '@deepseek-ai'))
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [name, target] of copied) manifest.dependencies[name] = `file:${target}`
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(options.patch ?? [], null, 2))
  return {
    home: resolve(home),
    dir,
    profile,
    appBoot,
    sources,
    patchPath: join(dir, 'cordis.patch.yml'),
    profilePackage: (name) => profilePackage(dir, name),
  }
}

/** Boot the prepared profile and return its host context. */
export async function bootProfile(profileInfo) {
  const { runProfile } = await import(hostPackage('dsh/lib/profile-boot.js'))
  const booted = await runProfile({
    profile: profileInfo.profile,
    patchFiles: [],
    args: [],
    environment: profileInfo.appBoot.loadLayeredEnv('dsh'),
  })
  return booted.ctx
}

/** Exchange the process launch token for an authenticated Connection cookie. */
export async function authenticate(ctx) {
  const connection = ctx.get('connection')
  if (!connection) throw new Error('the profile must mount @deepseek-ai/dsh-client-connection')
  const url = new URL(connection.authenticatedUrl(ctx.get('webServer').getOrigin()))
  url.pathname = '/connect'
  url.searchParams.set('interactions', 'none')
  const response = await fetch(url, { redirect: 'manual' })
  if (response.status !== 302) throw new Error(`connect failed: ${response.status} ${await response.text()}`)
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  if (!setCookie) throw new Error('connect must set a session cookie')
  return setCookie.split(';')[0]
}

/** Count active Loader entries per top-level row id. */
export function rowCounts(ctx) {
  const counts = new Map()
  for (const entry of ctx.root.loader.entries()) {
    const id = entry.options?.id
    if (typeof id !== 'string') continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Wait until predicate() is truthy, or throw after the timeout. */
export async function waitUntil(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

/** Absolute-but-portable path helper for patch files. */
export const jsonPatch = (rows) => JSON.stringify(rows, null, 2)

/** True when a package path is inside the temp home (safety for cleanup/reuse checks). */
export function insideHome(home, path) {
  const rel = relative(home, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

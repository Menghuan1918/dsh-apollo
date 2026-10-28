// Render the system prompt a real DSH host assembles for the eng / eng-ptc
// presets into prompts/<preset>.md, for human review. Opt-in: needs an
// installed DSH (DSH_PACKAGE_ROOT) and the three independent plugin packages
// (installed under this package's node_modules, or next to this repo via the
// APOLLO_*_SOURCE env overrides). Uses a temporary home and a headless profile;
// no Web server is started. Run: `npm run prompts`.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dsh = process.env.DSH_PACKAGE_ROOT
if (!dsh) throw new Error('Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package directory')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const require = createRequire(join(root, 'package.json'))

/**
 * Resolve one shipped package from the verification install (tarball layout), or
 * fall back to the sibling source checkout. The prompt profile must contain the
 * real package files, not a hand-written copy of their prompt text.
 */
async function resolvePackage(name, envKey, sibling) {
  const override = process.env[envKey]
  if (override !== undefined) return resolve(override)
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    const fallback = resolve(join(root, '..', sibling))
    await readFile(join(fallback, 'package.json'), 'utf8')
    return fallback
  }
}

const goalSource = await resolvePackage('dsh-better-goal', 'APOLLO_GOAL_SOURCE', 'dsh-better-goal')
const subagentSource = await resolvePackage('@menghuan1918/dsh-better-subagent', 'APOLLO_SUBAGENT_SOURCE', 'dsh-better-subagent')
const compactSource = await resolvePackage('dsh-better-compact', 'APOLLO_COMPACT_SOURCE', 'dsh-better-compact')
const askSource = await resolvePackage('dsh-better-ask-user', 'APOLLO_ASK_SOURCE', 'dsh-better-ask-user')
const ptcSource = await resolvePackage('dsh-better-ptc', 'APOLLO_PTC_SOURCE', 'dsh-better-ptc')
const goalName = JSON.parse(await readFile(join(goalSource, 'package.json'), 'utf8')).name
const subagentName = JSON.parse(await readFile(join(subagentSource, 'package.json'), 'utf8')).name
const compactName = JSON.parse(await readFile(join(compactSource, 'package.json'), 'utf8')).name
const askName = JSON.parse(await readFile(join(askSource, 'package.json'), 'utf8')).name
const ptcName = JSON.parse(await readFile(join(ptcSource, 'package.json'), 'utf8')).name
assert.equal(subagentName, '@menghuan1918/dsh-better-subagent')
assert.equal(compactName, 'dsh-better-compact')
assert.equal(askName, 'dsh-better-ask-user')
assert.equal(ptcName, 'dsh-better-ptc')
assert.equal(manifest.dependencies[subagentName], '0.2.0')
assert.equal(manifest.dependencies[compactName], '0.1.2')
assert.equal(manifest.dependencies[goalName], '0.2.1')
assert.equal(manifest.dependencies[askName], '0.1.5')
assert.equal(manifest.dependencies[ptcName], '0.1.0')

/** Root row settings the rendered prompts use; tests re-render the Apollo section from the JSON block. */
const APOLLO_SETTINGS = { exitGuard: false }
// The subagent prompt sections are rendered from dsh-better-subagent's own row;
// placeholder routes keep the snapshot stable without depending on a real model.
const SUBAGENT_SETTINGS = {
  tiers: {
    fast: { provider: '<fast-provider>', model: '<fast-model>', reasoningEffort: '<fast-effort>' },
    quality: { provider: '<quality-provider>', model: '<quality-model>', reasoningEffort: '<quality-effort>' },
  },
}
const ASK_SETTINGS = { questionTimeoutSeconds: 120, timeoutBehavior: 'native', goalTimeoutBehavior: 'native' }
const SETTINGS = {
  'apollo-skills': APOLLO_SETTINGS,
  'dsh-better-subagent': SUBAGENT_SETTINGS,
  'dsh-better-ask-user': ASK_SETTINGS,
}
const PRESETS = ['eng', 'eng-ptc']
const MODEL = 'example-model'

const home = await mkdtemp(join(tmpdir(), 'apollo-prompts-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const { boot, initProfile, loadProfile, createRuntimeResolution, readProfilePatches, resolveProfileDir, PROFILE_TEMPLATES, PluginPackages } = await import(pathToFileURL(join(dirname(dsh), 'dsh-app-boot/lib/index.js')))
const { renderPrompt } = await import(pathToFileURL(join(dirname(dsh), 'dsh-system-prompt/lib/index.js')))
const version = JSON.parse(await readFile(join(dsh, 'package.json'), 'utf8')).version
const dir = resolveProfileDir('prompts', home)

/** Copy a package without dependency trees, matching what a published tarball installs. */
async function copyPackage(source, target) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    filter: (candidate) => !relative(source, candidate).split(sep).some((part) => part === 'node_modules' || part === '.git'),
  })
}

/** Real installed layout: `node_modules/<pkg name>` (scoped packages keep their scope dir). */
const profilePackage = (name) => join(dir, 'node_modules', ...name.split('/'))

initProfile(dir, [...PROFILE_TEMPLATES.headless.bundles, manifest.name])
const installed = profilePackage(manifest.name)
await copyPackage(root, installed)
for (const [name, source] of [
  [goalName, goalSource],
  [subagentName, subagentSource],
  [compactName, compactSource],
  [askName, askSource],
  [ptcName, ptcSource],
]) {
  await copyPackage(source, profilePackage(name))
}
const profileManifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
for (const name of [manifest.name, goalName, subagentName, compactName, askName, ptcName]) {
  profileManifest.dependencies[name] = `link:${profilePackage(name)}`
}
await writeFile(join(dir, 'package.json'), JSON.stringify(profileManifest, null, 2))
await writeFile(join(dir, 'cordis.yml'), '[]\n')
await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
  { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
  // Mirror the web host: base's global workflow rows are disabled so each preset decides.
  { id: 'workflow-ptc', disabled: true }, { id: 'tool-workflow', disabled: true },
  { id: 'apollo-skills', config: APOLLO_SETTINGS },
  { id: 'dsh-better-subagent', config: SUBAGENT_SETTINGS },
  { id: 'dsh-better-ask-user', config: ASK_SETTINGS },
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } },
    { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: Object.values(SUBAGENT_SETTINGS.tiers).map(({ provider, model }) => ({ provider, model })) } },
  ] },
]))

const cwd = join(home, 'workspace')
await mkdir(cwd, { recursive: true })
const installAnchor = join(dsh, 'package.json')
const profile = loadProfile('apollo-prompts', 'prompts', installAnchor, home)
assert.deepEqual(profile.skippedBundles, [], 'the Apollo bundle must load')
const overlays = [{ id: 'credentials', disabled: false, config: { watch: false } }, { insert: [
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
  { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
  { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
  { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
  { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
] }]
const profileContext = { name: 'prompts', dir, patchPath: profile.patchPath, installAnchor, cwd, home, startedBundles: profileManifest.dsh.profile.bundles, overlays, telemetryDisabledEnv: '1' }
const resolution = await createRuntimeResolution({ installAnchor, profile })
for (const name of [goalName, subagentName, compactName, askName, ptcName]) {
  assert.ok(resolution.entries.some((entry) => entry.name === name), `${name} must resolve through the runtime package table`)
}
const ctx = await boot('apollo-prompts', join(dir, 'cordis.yml'), readProfilePatches('apollo-prompts', profileContext, profile), async (host) => {
  host.provide('profileContext', profileContext)
  await host.plugin(PluginPackages, { resolution })
})

const info = { provider: 'example', id: MODEL, name: MODEL, inputModalities: ['text'] }
ctx.llm.registerAdapter(['example'], {
  providerInfo: (id) => ({ id, name: 'Example' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
  listModels: async () => [info], resolveModel: async () => info,
  async prepareCall() { return { model: info, stream: async function* () {} } },
})

try {
  await mkdir(join(root, 'prompts'), { recursive: true })
  for (const preset of PRESETS) {
    const session = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: preset }, agentOptions: { provider: 'example', model: MODEL }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) } })
    try {
      const assembly = await ctx.systemPrompt.assemble({ agent: session.agent, scope: session.agent })
      const prompt = renderPrompt({ ...assembly, contexts: [] }).replaceAll(cwd, '<cwd>').replaceAll(home, '<home>')
      const tools = [...ctx.tools.view(session.agent).visible.keys()].sort()
      await writeFile(join(root, 'prompts', `${preset}.md`), [
        `<!-- Generated by \`npm run prompts\` (scripts/render-prompts.mjs). Do not edit by hand. -->`,
        '',
        `# \`${preset}\` system prompt`,
        '',
        `Assembled by a headless DSH ${version} host for model \`${MODEL}\`. Per-request runtime context (time, working directory) and tool schemas are omitted; web-only sections of the Web GUI host are not included. Sections in order: ${assembly.sections.filter((section) => section.text !== '').map((section) => `\`${section.name}\``).join(', ')}.`,
        '',
        'Apollo / dsh-better-subagent / dsh-better-ask-user settings used:',
        '',
        '```json',
        JSON.stringify(SETTINGS, null, 2),
        '```',
        '',
        `Visible tools (${tools.length}): ${tools.map((name) => `\`${name}\``).join(', ')}`,
        '',
        '## Prompt',
        '',
        '`````text',
        prompt,
        '`````',
        '',
      ].join('\n'))
      console.log('RENDERED', preset, prompt.length)
    } finally { await session.dispose() }
  }
} finally {
  await ctx.dispose?.()
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
process.exit(0)

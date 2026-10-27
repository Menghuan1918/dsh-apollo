// Opt-in integration against an installed DSH. Uses a temporary profile, no Web server.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, realpath, writeFile, access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dsh = process.env.DSH_PACKAGE_ROOT
if (!dsh) throw new Error('Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package directory')
// Read the real package names instead of assuming a scope/directory layout.
const apolloManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packageName = apolloManifest.name
const goalSource = resolve(process.env.APOLLO_GOAL_SOURCE ?? join(root, '..', 'dsh-better-goal'))
const goalManifest = JSON.parse(await readFile(join(goalSource, 'package.json'), 'utf8'))
const goalName = goalManifest.name
assert.equal(typeof packageName, 'string', 'Apollo package.json must name the package')
assert.equal(typeof goalName, 'string', 'Goal package.json must name the package')
assert.equal(apolloManifest.dependencies?.[goalName], goalManifest.version, `Goal fixture ${goalName}@${goalManifest.version} must match Apollo's dependency`)
const selected = process.env.APOLLO_SMOKE_CLI ? [process.env.APOLLO_SMOKE_CLI] : ['codex', 'claude']
assert.ok(selected.every((cli) => ['codex', 'claude'].includes(cli)), 'APOLLO_SMOKE_CLI must be codex or claude')
const reuse = process.env.APOLLO_SMOKE_HOME
const models = { codex: process.env.APOLLO_CODEX_MODEL, claude: process.env.APOLLO_CLAUDE_MODEL }
if (!reuse) for (const cli of selected) assert.ok(models[cli], `Set APOLLO_${cli.toUpperCase()}_MODEL to an available model`)
const home = reuse ? resolve(reuse) : await mkdtemp(join(tmpdir(), 'apollo-runtime-'))
if (reuse && (!home.startsWith(resolve(tmpdir()) + '/') || !home.includes('/apollo-runtime-'))) {
  throw new Error('APOLLO_SMOKE_HOME must name a temporary home created by this script')
}
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const { boot, initProfile, loadProfile, createRuntimeResolution, readProfilePatches, resolveProfileDir, PROFILE_TEMPLATES, PluginPackages } = await import(pathToFileURL(join(dirname(dsh), 'dsh-app-boot/lib/index.js')))
const { normalizeConfig, currentConfig, liveConfigEntry } = await import('../src/config.js')
const { collectTierRoutes } = await import('../src/panel.js')
const version = JSON.parse(await readFile(join(dsh, 'package.json'), 'utf8')).version
const dir = resolveProfileDir('it', home)
const installedApollo = join(dir, 'node_modules', packageName)
const installedGoal = join(dir, 'node_modules', goalName)

/** Copy a package without dependency trees, matching what a published tarball installs. */
async function copyPackage(source, target) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    filter: (candidate) => {
      const rel = relative(source, candidate)
      return rel === '' || !rel.split(sep).some((part) => part === 'node_modules' || part === '.git')
    },
  })
}

if (!reuse) initProfile(dir, [...PROFILE_TEMPLATES.headless.bundles, packageName])
const manifestFile = join(dir, 'package.json')
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
if (!reuse) {
  // Simulate the installed layout: both packages are plain copies without
  // node_modules, so Goal's peers and dependencies resolve from the host.
  await copyPackage(root, installedApollo)
  await copyPackage(goalSource, installedGoal)
  await assert.rejects(access(join(installedGoal, 'node_modules')), { code: 'ENOENT' }, 'Goal fixture must not carry a nested dependency tree')
  manifest.dependencies[packageName] = `link:${installedApollo}`
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2))
}
const rootConfig = join(dir, 'cordis.yml')
if (!reuse) await writeFile(rootConfig, '[]\n')
const cwd = join(home, 'workspace')
await mkdir(join(cwd, 'current', 'delegated'), { recursive: true })
const config = normalizeConfig({ subagents: {
  eng: true, global: true,
  codex: { enabled: selected.includes('codex'), executable: process.env.APOLLO_CODEX_BIN ?? 'codex', profile: process.env.APOLLO_CODEX_PROFILE ?? '', permissionMode: 'read-only', defaultModel: models.codex, models: models.codex ? [{ id: models.codex, efforts: ['low'], defaultEffort: 'low' }] : [] },
  claude: { enabled: selected.includes('claude'), executable: process.env.APOLLO_CLAUDE_BIN ?? 'claude', permissionMode: 'plan', defaultModel: models.claude, models: models.claude ? [{ id: models.claude, efforts: ['low'], defaultEffort: 'low' }] : [] },
} })
await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
if (!reuse) await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
  { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
  // Mirror the web host: base's global workflow rows are disabled so each
  // preset alone decides whether its agent sees workflow.
  { id: 'workflow-ptc', disabled: true }, { id: 'tool-workflow', disabled: true },
  { id: 'apollo-skills', config },
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } },
    { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [{ provider: 'it-noop', model: 'noop' }] } },
  ] },
]))

let ctx
let parent
const results = []
const history = []
let parentId = randomUUID()
const children = new Map()
const storeName = `apollo_cli_${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`
if (reuse) {
  const previous = JSON.parse(await readFile(join(home, 'results.json'), 'utf8'))
  history.push(...previous.history ?? [], { version: previous.version ?? null, results: previous.results })
  for (const result of previous.children ?? previous.results) {
    if (['codex', 'claude'].includes(result.cli) && result.childId) children.set(result.cli, { id: result.childId, marker: result.marker })
  }
  assert.ok([...children.keys()].some((cli) => selected.includes(cli)), 'No saved children match APOLLO_SMOKE_CLI')
  for (const [cli, child] of children) {
    if (!selected.includes(cli)) continue
    const record = await stored(child.id)
    assert.ok(record?.remoteId, `Missing native CLI identity for ${child.id}`)
    parentId = record.parentId
  }
}

function noopAdapter() {
  const adapter = {
    providerInfo: (id) => ({ id, name: 'Integration scripted parent' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [{ provider: 'it-noop', id: 'noop', name: 'Noop', inputModalities: ['text'] }],
    resolveModel: async (provider, id) => ({ provider, id, name: id, inputModalities: ['text'] }),
    async prepareCall(provider, model) { return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) } },
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Received.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Received.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return adapter
}

async function launch(resume = false) {
  const installAnchor = join(dsh, 'package.json')
  const profile = loadProfile('apollo-it', 'it', installAnchor, home)
  assert.deepEqual(profile.skippedBundles, [], 'the scoped Apollo bundle must load')
  assert.ok(profile.layers.some((layer) => layer.packageName === packageName), 'the profile must select the scoped Apollo bundle')
  // The standard preset's schedule tools need these official host services.
  // Connection registers handlers without opening a server in this headless host.
  const overlays = [{ id: 'credentials', disabled: false, config: { watch: false } }, { insert: [
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
    { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
    { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
    { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
  ] }]
  const profileContext = { name: 'it', dir, patchPath: profile.patchPath, installAnchor, cwd, home, startedBundles: manifest.dsh.profile.bundles, overlays, telemetryDisabledEnv: '1' }
  const resolution = await createRuntimeResolution({ installAnchor, profile })
  const goalEntry = resolution.entries.find((entry) => entry.name === goalName)
  assert.ok(goalEntry, 'Goal must resolve through the runtime package table')
  assert.equal(goalEntry.scope, 'profile', 'Goal must resolve as a profile-scope package')
  assert.equal(await realpath(goalEntry.packageDir), await realpath(installedGoal), 'Goal must come from the copied profile layout, not Apollo node_modules')
  assert.ok(resolution.localPackageNames.includes(packageName), 'Apollo must be a direct profile package')
  console.log('SCOPED_PACKAGE_LAYOUT_OK', packageName, goalName)
  ctx = await boot('apollo-it', rootConfig, readProfilePatches('apollo-it', profileContext, profile), async (host) => {
    host.provide('profileContext', profileContext)
    await host.plugin(PluginPackages, { resolution })
  })
  ctx.llm.registerAdapter(['it-noop'], noopAdapter())
  const setup = async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'eng') }
  parent = resume ? await ctx.agents.resume({ resumeSessionId: parentId, agentOptions: { provider: 'it-noop', model: 'noop' }, setup })
    : await ctx.agents.create({ sessionId: parentId, meta: { cwd, agentPreset: 'eng' }, agentOptions: { provider: 'it-noop', model: 'noop' }, setup })
  console.log('RUNTIME_READY', version, resume ? 'resumed' : 'created', dir)
}

async function call(name, args, agent = parent.agent) {
  const result = await ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}

function nextTurn(id, action, expected = 'completed') {
  let dispose
  let timer
  let text = ''
  const promise = new Promise((resolveTurn, reject) => {
    timer = setTimeout(() => { dispose?.(); reject(new Error(`Timed out waiting for ${id}`)) }, 300_000)
    dispose = ctx.on('session/event', (session, event) => {
      if (session.id !== id) return
      if (event.type === 'assistant/message') text = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      if (event.type !== 'turn/end') return
      clearTimeout(timer)
      dispose?.()
      resolveTurn(event.data)
    })
  })
  return Promise.all([promise, Promise.resolve().then(action)]).then(async ([end]) => {
    await ctx.agents.get(id)?.whenIdle()
    assert.equal(end.reason.kind, expected, `turn failed: ${JSON.stringify(end)}; text=${text}`)
    return text
  }).finally(() => { clearTimeout(timer); dispose?.() })
}

async function startChild(args) {
  let off
  let timeout
  const turn = new Promise((resolveTurn, reject) => {
    timeout = setTimeout(() => { off(); reject(new Error(`Initial child timeout: ${args.description}`)) }, 300_000)
    off = ctx.on('session/event', (session, event) => {
      if (session.header.parentSession !== parentId || event.type !== 'turn/end') return
      clearTimeout(timeout); off(); resolveTurn({ id: session.id, end: event.data })
    })
  })
  try {
    const [value, first] = await Promise.all([call('subagent', args), turn])
    assert.equal(value.kind, 'activation')
    assert.equal(first.id, value.subagentId)
    await ctx.agents.get(value.subagentId)?.whenIdle()
    return { id: value.subagentId, end: first.end }
  } finally { clearTimeout(timeout); off?.() }
}

async function parentNotice(id, text) {
  const deadline = Date.now() + 10_000
  while (!parent.agent.session.snapshotEvents().some((event) => {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'subagent-settled') return false
    const content = event.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    return content.includes(id) && content.includes(text)
  })) {
    assert.ok(Date.now() < deadline, `No parent settlement notice with closing text for ${id}`)
    await delay(25)
  }
}

async function stored(id) {
  // Test-only observation of the JSON backend. Production uses the KV service.
  return JSON.parse(await readFile(join(home, 'storages', storeName, 'sessions', `${id}.json`), 'utf8')).record
}

async function checkpoint(result) {
  if (result) results.push(result)
  await writeFile(join(home, 'results.json'), JSON.stringify({ home, version, history, children: [...children].map(([cli, child]) => ({ cli, childId: child.id, marker: child.marker })), results }, null, 2))
}

async function settings(patch) {
  const descriptor = ctx.settings.describe().find((form) => form.ns === 'apollo-skills')
  assert.ok(descriptor, 'Apollo exposes a formal config form')
  await ctx.settings.update('apollo-skills', patch, descriptor.revision)
}

try {
  await launch(Boolean(reuse))
  const fiber = liveConfigEntry(ctx).fiber
  await settings({ exitGuard: true })
  assert.equal(currentConfig(ctx).exitGuard, true)
  await settings({ exitGuard: false })
  assert.equal(currentConfig(ctx).exitGuard, false)
  assert.equal(liveConfigEntry(ctx).fiber, fiber, 'Volatile settings must not remount Apollo')
  console.log('LIVE_CONFIG_OK')
  assert.ok(ctx.schedule && ctx.sessionController, 'The official schedule host services must activate')
  const scheduleTools = ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']
  for (const name of scheduleTools) assert.equal(ctx.tools.get(name, parent.agent), undefined, `eng intentionally omits ${name}`)
  const ptc = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: 'eng-ptc' }, agentOptions: { provider: 'it-noop', model: 'noop' }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'eng-ptc') } })
  try {
    for (const name of scheduleTools) assert.equal(ctx.tools.get(name, ptc.agent), undefined, `eng-ptc intentionally omits ${name}`)
    assert.equal(ctx.tools.get('workflow', ptc.agent), undefined, 'eng-ptc disables workflow like the upstream ptc preset')
    assert.ok(ctx.tools.get('workflow', parent.agent), 'eng keeps workflow')
    assert.ok(ctx.tools.get('run_code', ptc.agent), 'eng-ptc presents tools through run_code')
    assert.equal(ctx.tools.get('run_code', parent.agent), undefined, 'eng stays native')
    const modeText = async (agent) => (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections.find((section) => section.name === 'eng:mode-instructions')?.text ?? ''
    assert.match(await modeText(parent.agent), /## Delegation/, 'eng renders the mode-instructions section')
    assert.doesNotMatch(await modeText(parent.agent), /run_code/, 'eng omits the PTC fan-out rule')
    assert.match(await modeText(ptc.agent), /dispatch all subagents inside one run_code program/, 'eng-ptc renders the PTC mode-instructions section')
    await settings({ tiers: { fast: { provider: 'it-noop', model: 'noop', reasoningEffort: '' } } })
    assert.match(await modeText(parent.agent), /Fast tier[^\n]*provider: `it-noop` · model: `noop`/, 'tier settings render without remount')
    const tierRoutes = await collectTierRoutes(ctx)
    assert.equal(tierRoutes.enabled, true)
    assert.deepEqual(tierRoutes.routes.map(({ provider, model }) => `${provider}/${model}`), ['it-noop/noop'], 'tier routes come from the host allowlist')
  } finally { await ptc.dispose() }
  console.log('HOST_PRESETS_OK', 'eng', 'eng-ptc')
  const native = await startChild({ description: 'Verify native delegation', provider: 'it-noop', model: 'noop', prompt: 'Reply Received.' })
  assert.equal(native.end.reason.kind, 'completed', JSON.stringify(native.end))
  await parentNotice(native.id, 'Received.')
  await ctx.subagents.drainChildren(parent.agent, [native.id])
  console.log('NATIVE_ACTIVATION_AND_NOTICE_OK')
  await checkpoint({ phase: 'host-config-presets-native-activation', passed: true })
  const catalog = await call('list_subagent_models', {})
  for (const cli of selected) assert.match(catalog, new RegExp(cli))
  if (process.env.APOLLO_SMOKE_HOST_ONLY !== '1') {
    if (!reuse) {
      const current = await ctx.workingDirectory.set(parent.agent, join(cwd, 'current'))
      for (const cli of selected) {
        const marker = `APOLLO_${cli}_${randomUUID().replaceAll('-', '')}`
        const first = await startChild({ description: `Verify ${cli} memory`, provider: cli, cwd: 'delegated', prompt: `Remember this exact marker for later: ${marker}. Reply with only SAVED.` })
        const childId = first.id
        children.set(cli, { id: childId, marker })
        assert.equal(first.end.reason.kind, 'completed', JSON.stringify(first.end))
        assert.equal((await stored(childId)).cwd, resolve(current, 'delegated'), 'CLI cwd follows the current directory, not the immutable header')
        const followup = await nextTurn(childId, () => call('send_message', { agent_id: childId, message: 'Return only the exact marker I asked you to remember.' }))
        assert.ok(followup.includes(marker), `${cli} forgot its marker: ${followup}`)
        await parentNotice(childId, marker)
        console.log('REAL_CLI_TWO_TURNS_OK', cli, childId)
        await checkpoint({ cli, phase: 'two-turn-memory-and-cwd', passed: true, childId, marker })
      }
      await ctx.subagents.drainDescendants([parent.agent])
      await parent.dispose()
      await ctx.fiber.dispose()
      await launch(true)
    }
    for (const [cli, child] of children) {
      if (!selected.includes(cli)) continue
      const before = await stored(child.id)
      const reply = await nextTurn(child.id, () => call('send_message', { agent_id: child.id, message: child.marker ? 'After the host restart, return only the exact marker you remember.' : 'This is a host restart. Reply with only RESUMED.' }))
      assert.ok(reply.includes(child.marker ?? 'RESUMED'), `${cli} cold resume failed: ${reply}`)
      assert.equal((await stored(child.id)).remoteId, before.remoteId)
      console.log('HOST_RESTART_RESUME_OK', cli, child.id)
      await checkpoint({ cli, phase: 'host-restart-memory', passed: true, childId: child.id, marker: child.marker })
    }
    if (process.env.APOLLO_SMOKE_LIFECYCLE === '1') {
      for (const [cli, child] of children) {
        if (!selected.includes(cli)) continue
        const before = await stored(child.id)
        if (process.env.APOLLO_SMOKE_PHASE !== 'read-only') {
          await nextTurn(child.id, async () => {
            await call('send_message', { agent_id: child.id, message: 'Run a command that waits 30 seconds before replying WAIT_FINISHED. Do not finish early.' })
            const deadline = Date.now() + 15_000
            while ((await stored(child.id)).delivered.length === before.delivered.length) {
              assert.ok(Date.now() < deadline, `${cli} never dispatched its turn`)
              await delay(25)
            }
            await delay(500)
            await call('interrupt_agent', { agent_id: child.id })
          }, 'aborted')
          assert.equal((await stored(child.id)).remoteId, before.remoteId)
          const reply = await nextTurn(child.id, () => call('send_message', { agent_id: child.id, message: 'The wait was cancelled. Reply with only RESUMED.' }))
          assert.match(reply, /RESUMED/)
          assert.equal((await stored(child.id)).remoteId, before.remoteId)
          console.log('INTERRUPT_RESUME_OK', cli, child.id)
          await checkpoint({ cli, phase: 'interrupt-resume', passed: true, childId: child.id, marker: child.marker })
          const file = join(before.cwd, `${cli}-${randomUUID()}.txt`)
          await settings({ subagents: { [cli]: { permissionMode: cli === 'codex' ? 'workspace-write' : 'acceptEdits' } } })
          await nextTurn(child.id, () => call('send_message', { agent_id: child.id, message: `Write exactly APOLLO_WRITABLE into ${file}. Stop immediately if denied; do not retry or request permission. Report the actual outcome.` }))
          assert.equal((await readFile(file, 'utf8')).trim(), 'APOLLO_WRITABLE')
          await checkpoint({ cli, phase: 'writable-permission', passed: true, childId: child.id, marker: child.marker })
        }
        await settings({ subagents: { [cli]: { permissionMode: cli === 'codex' ? 'read-only' : 'plan' } } })
        const denied = join(before.cwd, `${cli}-denied-${randomUUID()}.txt`)
        await nextTurn(child.id, () => call('send_message', { agent_id: child.id, message: `Write exactly APOLLO_DENIED into ${denied}. Stop immediately if denied; do not retry or request permission. Report the actual outcome.` }))
        await assert.rejects(access(denied), { code: 'ENOENT' })
        assert.equal((await stored(child.id)).remoteId, before.remoteId)
        console.log('LIVE_PERMISSION_UPDATE_OK', cli, child.id)
        await checkpoint({ cli, phase: 'read-only-permission', passed: true, childId: child.id, marker: child.marker })
      }
    }
  }
  await checkpoint()
  console.log('APOLLO_RUNTIME_SMOKE_PASSED', JSON.stringify({ home, version, results }))
} catch (error) {
  await writeFile(join(home, 'results.json'), JSON.stringify({ home, version, history, children: [...children].map(([cli, child]) => ({ cli, childId: child.id, marker: child.marker })), results, error: error.message }, null, 2))
  throw error
} finally {
  if (ctx) {
    try {
      if (parent) {
        try { await ctx.subagents?.drainDescendants([parent.agent]) }
        finally { await parent.dispose() }
      }
    } finally { await ctx.fiber.dispose() }
  }
}

/**
 * Opt-in installed-runtime suite: DSH_PACKAGE_ROOT points to exact rc.1;
 * DSH_CLIENT_TEST_ROOT points to npm-installed shell seeds/DOM dependencies
 * (defaults to the isolated sibling client-test project). Plugin source root
 * follows APOLLO_PLUGIN_SOURCE_ROOT, defaulting to sibling checkouts.
 * No HTTP listener, browser GUI, or existing profile is used.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { prepareProfile, bootProfile, waitUntil } from '../scripts/lib/profile.mjs'
import { createRuntime, enabled, VERSION, importHost, json, hostRequire } from './fixtures/client-runtime.mjs'

const options = { skip: enabled ? false : 'Set DSH_PACKAGE_ROOT to the installed 0.2.2-rc.1 host', timeout: 60000 }
const APOLLO = '@menghuan1918/dsh-apollo'
const ROW = APOLLO + '#apollo-skills'

// This deliberately runs the published closure files through ClientModuleSystem,
// not the source-string fake require/ctx from client.test.mjs.
test('real next client: six manifests and every declared inject resolve through the production module table', options, async t => {
  const runtime = await createRuntime()
  t.after(() => runtime.dispose())
  assert.equal(runtime.modules.version, 'client')
  assert.equal(runtime.manifests.length, 6)
  for (const { manifest } of runtime.manifests) {
    if (!manifest.dsh?.client) {
      assert.equal(manifest.name, 'dsh-better-ptc', 'only PTC is intentionally Host-only')
      assert.equal(manifest.exports?.['./client'], undefined)
      continue
    }
    assert.equal(manifest.dsh.client.platform, 'web')
    for (const name of manifest.dsh.client.inject) {
      assert.equal(json(hostRequire.resolve(name + '/package.json')).version, VERSION)
      assert.ok(await runtime.modules.import(name), manifest.name + ' inject ' + name)
    }
    const client = await runtime.modules.import(manifest.name)
    assert.equal(typeof client.apply, 'function', manifest.name)
    assert.equal(await runtime.modules.import(manifest.name + '/client'), client)
  }
  await assert.rejects(runtime.modules.import('@deepseek-ai/dsh-client-locale-removed'), /cannot resolve/)
})

test('real next client: renderer row shape, Apollo ConfigForm and shared subscriptions/CAS/conflict/readonly', options, async t => {
  const r = await createRuntime()
  t.after(() => r.dispose())
  const Schema = (await importHost('@deepseek-ai/schemastery')).default
  let section = { ns: 'apollo-skills', autoGenerate: false,
    schema: Schema.object({ exitGuard: Schema.boolean().default(false), declareOwnsHost: Schema.boolean().default(false) }).toJSON(),
    value: { exitGuard: false, declareOwnsHost: false }, base: { exitGuard: false, declareOwnsHost: false }, user: {}, revision: 1, applies: 'live', secrets: [] }
  let writable = true
  let rejectNext = false
  const answer = () => ({ ok: true, value: { writable, hasDocument: true, namespaces: [structuredClone(section)] } })
  r.rpc.remote.settings.describe.mockImplementation(async () => answer())
  r.rpc.remote.settings.mutate.mockImplementation(async ({ ns, ops, expectedRevision: revision }) => {
    assert.equal(ns, 'apollo-skills')
    if (rejectNext || revision !== section.revision) {
      rejectNext = false
      return { ok: false, error: { code: 'settings/conflict', message: 'changed concurrently', details: {} } }
    }
    assert.equal(writable, true)
    const value = { ...section.value }
    for (const op of ops) { assert.equal(op.op, 'set'); assert.equal(op.path.length, 1); value[op.path[0]] = op.value }
    section = { ...section, value, user: { ...value }, revision: section.revision + 1 }
    return { ok: true, value: structuredClone(section) }
  })
  await r.mountModule('@deepseek-ai/dsh-client-ui-settings')
  await r.ctx.configForms.describe().ensure()
  await r.mountModule('@deepseek-ai/dsh-client-locale')
  await r.mountModule(APOLLO)
  const form = r.ctx.configForms.get('apollo-skills')
  assert.equal(form, r.ctx.configForms.get('apollo-skills'), 'shared controller identity')
  assert.equal(form.getSnapshot().status, 'ready')
  let notifications = 0
  const unsubscribe = form.subscribe(() => notifications++)
  t.after(unsubscribe)
  function Frame({ renderSlot }) {
    const state = r.React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
    // Exact official PluginManagerPage.formFor shape (not a controller).
    return r.React.createElement(r.React.Fragment, null,
      renderSlot('plugins.row.config', { view: 'page', form: { state, mutate: (ops, revision) => form.mutate(ops, revision) } }, { entryKey: ROW }),
      renderSlot('plugins.detail.actions', { subject: { kind: 'bundle', pkg: { name: APOLLO, installed: true, availability: 'available', official: false, enabled: true, rows: [] } } }))
  }
  await r.render(Frame)
  const entries = r.ctx.slots.entriesOfSlot('plugins.row.config')
  const entry = entries.find(entry => entry.options.key === ROW)
  assert.ok(entry, 'real keyed registry entry')
  assert.equal(typeof entry.component, 'function')
  assert.equal(entry.locale, 'apollo')
  assert.equal(entry.key, undefined, 'stored keys live under options, not on the entry')
  const toggle = () => r.container.querySelector('[role="switch"]')
  const save = () => [...r.container.querySelectorAll('button')].find(button => ['Save', '保存'].includes(button.textContent))
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  await r.React.act(async () => toggle().click())
  await r.React.act(async () => save().click())
  assert.equal(form.getSnapshot().value.exitGuard, true, 'accepted mutation updates the real shared controller')
  assert.equal(form.getSnapshot().revision, 2)
  assert.deepEqual(structuredClone(r.rpc.remote.settings.mutate.mock.calls[0]), [{ ns: 'apollo-skills', ops: [{ op: 'set', path: ['exitGuard'], value: true }], expectedRevision: 1 }])
  assert.ok(notifications > 0)
  // Another editor updates the shared controller; both row and hub must subscribe.
  await r.React.act(async () => r.container.querySelector('[data-apollo-hub="trigger"]').click())
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog, 'real primitives Modal opens')
  assert.equal(dialog.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true')
  await r.React.act(async () => { assert.equal(await form.set('exitGuard', false), true) })
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  assert.equal(dialog.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false')
  const reads = r.rpc.remote.settings.describe.mock.calls.length
  await r.React.act(async () => toggle().click())
  section = { ...section, revision: section.revision + 1 }
  rejectNext = true
  await r.React.act(async () => save().click())
  assert.ok(r.rpc.remote.settings.describe.mock.calls.length > reads, 'refused CAS performs real mirror recovery')
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  assert.match(r.container.textContent, /refused|拒绝/)
  writable = false
  await r.React.act(async () => { await r.ctx.configForms.describe().load() })
  assert.equal(form.getSnapshot().writable, false)
  assert.equal(toggle().disabled, true)
  assert.equal(save().disabled, true)
  assert.equal(dialog.querySelector('[role="switch"]').disabled, true)
  assert.match(r.container.textContent, /Read.only|只读/)
  // The real Remote boundary folds carrier exceptions into a typed result.
  r.rpc.remote.settings.describe.mockRejectedValueOnce(new Error('carrier disconnected'))
  const disconnected = await r.ctx.remote.settings.describe()
  assert.equal(disconnected.ok, false)
  assert.equal(disconnected.error.code, 'gateway/internal')
  assert.match(disconnected.error.message, /carrier disconnected/)
})

test('real next client: ConfigForms writes actual Host SettingsController/ConfigEditor with stale CAS refusal', options, async t => {
  const r = await createRuntime()
  const oldHome = process.env.DSH_HOME
  const oldTelemetry = process.env.DSH_TELEMETRY_DISABLED
  let host
  let info
  t.after(async () => {
    try { await r.dispose() } finally {
      try { await host?.fiber.dispose() } finally {
        if (info) await rm(info.home, { recursive: true, force: true })
        if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
        if (oldTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED; else process.env.DSH_TELEMETRY_DISABLED = oldTelemetry
      }
    }
  })
  const keys = ['apollo', 'goal', 'subagent', 'compact', 'ask', 'ptc']
  const sources = Object.fromEntries(r.manifests.map((source, index) => [keys[index], { ...source, name: source.manifest.name }]))
  info = await prepareProfile({ sources, prefix: 'apollo-client-runtime-', patch: [
    { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
    { id: 'workflow-ptc', disabled: true }, { id: 'tool-workflow', disabled: true },
    { id: 'credentials', config: { watch: false } },
    { id: 'apollo-skills', config: { exitGuard: false } },
    { insert: [
      { id: 'client-test-settings-controller', name: '@deepseek-ai/dsh-api-settings-controller' },
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'eng' } },
      { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    ] },
  ] })
  host = await bootProfile(info)
  await host.loader.await()
  await waitUntil(() => host.get('settingsController') && host.get('settings')?.describe().some(view => view.ns === 'apollo-skills'), 'actual Host Apollo settings')
  const controller = host.get('settingsController')
  // The carrier delegates to real Host domain services; it does not implement CAS.
  r.rpc.remote.settings.describe.mockImplementation(async () => ({ ok: true, value: structuredClone(controller.describe()) }))
  r.rpc.remote.settings.mutate.mockImplementation(async ({ ns, ops, expectedRevision }) => {
    try { return { ok: true, value: structuredClone(await controller.mutate(ns, ops, expectedRevision)) } }
    catch (error) { return { ok: false, error } }
  })
  await r.mountModule('@deepseek-ai/dsh-client-ui-settings')
  await r.ctx.configForms.describe().ensure()
  const form = r.ctx.configForms.get('apollo-skills')
  const before = form.getSnapshot()
  assert.equal(before.status, 'ready')
  assert.equal(before.writable, true)
  await r.mountModule('@deepseek-ai/dsh-client-locale')
  await r.mountModule(APOLLO)
  function HostBackedRow({ renderSlot }) {
    const state = r.React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
    return renderSlot('plugins.row.config', { view: 'page', form: { state, mutate: (ops, revision) => form.mutate(ops, revision) } }, { entryKey: ROW })
  }
  await r.render(HostBackedRow)
  await r.React.act(async () => r.container.querySelector('[role="switch"]').click())
  const save = [...r.container.querySelectorAll('button')].find(button => ['Save', '保存'].includes(button.textContent))
  await r.React.act(async () => {
    save.click()
    await waitUntil(() => form.getSnapshot().value.exitGuard === true, 'Apollo UI save persisted by actual Host')
  })
  assert.equal(form.getSnapshot().value.exitGuard, true)
  assert.equal(host.get('settings').describe().find(view => view.ns === 'apollo-skills').value.exitGuard, true)
  const persisted = hostRequire('yaml').parse(await readFile(info.patchPath, 'utf8'))
  assert.equal(persisted.find(row => row.id === 'apollo-skills').config.exitGuard, true)
  await r.React.act(async () => {
    assert.equal(await form.mutate([{ op: 'set', path: ['exitGuard'], value: false }], before.revision), false)
  })
  assert.equal(form.getSnapshot().value.exitGuard, true, 'actual Host refused stale revision; mirror recovered accepted value')
  const refused = r.rpc.log.calls('settings/mutate').at(-1)
  assert.equal(refused.result.error.code, 'settings/conflict')
})

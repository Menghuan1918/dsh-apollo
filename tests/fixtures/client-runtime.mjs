/** Real rc.1 client machinery. Only the RPC carrier and page owner are test-owned. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

export const VERSION = '0.2.2-rc.1'
export const root = fileURLToPath(new URL('../../', import.meta.url))
export const hostRoot = process.env.DSH_PACKAGE_ROOT
export const enabled = !!hostRoot
export const hostRequire = enabled ? createRequire(join(hostRoot, 'package.json')) : null
const supportAnchor = process.env.DSH_CLIENT_TEST_ROOT
  ? join(resolve(process.env.DSH_CLIENT_TEST_ROOT), 'package.json')
  : join(root, 'tests/fixtures/client-support/package.json')
export const supportRequire = createRequire(supportAnchor)
export const json = path => JSON.parse(readFileSync(path, 'utf8'))
export const importHost = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const importSupport = name => import(pathToFileURL(supportRequire.resolve(name)).href)
export const hostDir = name => dirname(hostRequire.resolve(name + '/package.json'))

export async function createRuntime() {
  assert.equal(json(join(hostRoot, 'package.json')).version, VERSION)
  const { JSDOM } = await importSupport('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><main id="test-root"></main></body></html>', { url: 'http://127.0.0.1/client-runtime-test' })
  const globals = new Map()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  // Node has no CSS-module loader. Preserve class names; do not replace any JS.
  const cssHook = registerHooks({ load(url, context, next) {
    if (!url.endsWith('.css')) return next(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const names = [...source.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1])
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(Object.fromEntries(names.map(name => [name, name]))) }
  } })
  const React = supportRequire('react')
  const ReactDOM = supportRequire('react-dom')
  const ReactDOMClient = supportRequire('react-dom/client')
  const Cordis = await importHost('@deepseek-ai/cordis')
  const slotsSeed = await importSupport('@deepseek-ai/dsh-client-ui-slots')
  const storeSeed = await importSupport('@deepseek-ai/dsh-client-store')
  const primitivesSeed = await importSupport('@deepseek-ai/dsh-client-ui-primitives')
  for (const name of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives']) {
    assert.equal(json(supportRequire.resolve(name + '/package.json')).version, VERSION)
  }
  const target = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) } }
  dom.window.__ModuleLoader__ = target
  const execute = file => vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
  const modulesId = '@deepseek-ai/dsh-client-modules'
  execute(join(hostDir(modulesId), 'lib/client.js'))
  const bootstrap = target.pendingQueue.pop()
  const moduleExports = bootstrap.factory(() => { throw new Error('bootstrap requires no seeds') })
  const sources = new Map()
  const rows = new Map()
  function addPackage(name, dir) {
    if (rows.has(name)) return
    dir ??= hostDir(name)
    const pkg = json(join(dir, 'package.json'))
    assert.equal(pkg.name, name)
    const decl = moduleExports.parseDshClient(name, pkg.dsh?.client)
    assert.ok(decl, name + ' must declare a browser half')
    const entry = pkg.exports?.['./client']
    const client = typeof entry === 'string' ? entry : entry.browser ?? entry.default
    sources.set(name, join(dir, client))
    rows.set(name, { id: name, url: name, rev: VERSION, ...decl })
    for (const dependency of decl.inject ?? []) addPackage(dependency)
  }
  for (const name of ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']) addPackage(name)
  const pluginRoot = process.env.APOLLO_PLUGIN_SOURCE_ROOT
  const pluginRequire = createRequire(join(root, 'package.json'))
  const manifests = ['dsh-apollo', 'dsh-better-goal', 'dsh-better-subagent', 'dsh-better-compact', 'dsh-better-ask-user', 'dsh-better-ptc'].map(folder => {
    const name = folder === 'dsh-better-subagent' ? '@menghuan1918/dsh-better-subagent' : folder
    const dir = folder === 'dsh-apollo' ? root : pluginRoot ? join(pluginRoot, folder) : dirname(pluginRequire.resolve(name + '/package.json'))
    const manifest = json(join(dir, 'package.json'))
    if (manifest.dsh?.client) addPackage(manifest.name, dir)
    return { dir, manifest }
  })
  const entries = [...rows.values()]
  const manifest = moduleExports.parseBootManifest({ rev: VERSION, release: { version: VERSION }, entries,
    batches: entries.map(entry => ({ phase: 'application', url: entry.url, rev: VERSION, entries: [entry.id] })) })
  const modules = new moduleExports.ClientModuleSystem({ manifest, registrationTarget: target,
    bootstrapModule: { id: modulesId, exports: moduleExports },
    staticModules: { react: React, 'react/jsx-runtime': supportRequire('react/jsx-runtime'), 'react-dom': ReactDOM,
      'react-dom/client': ReactDOMClient, zod: await importHost('zod'),
      '@tanstack/react-virtual': await importSupport('@tanstack/react-virtual'), '@deepseek-ai/cordis': Cordis,
      '@deepseek-ai/dsh-client-ui-slots': slotsSeed, '@deepseek-ai/dsh-client-store': storeSeed,
      '@deepseek-ai/dsh-client-ui-primitives': primitivesSeed },
    loadBundle: async url => { assert.ok(sources.has(url), 'Unexpected bundle ' + url); execute(sources.get(url)) } })
  const ctx = new Cordis.Context()
  const fibers = []
  async function mount(plugin) {
    const fiber = ctx.plugin(plugin)
    fibers.push(fiber)
    await fiber.await()
    return fiber
  }
  async function mountModule(id) { return mount(await modules.import(id)) }
  const { RemoteMock } = await importSupport('@deepseek-ai/dsh-remote-mock')
  const rpc = RemoteMock.create()
  const connection = await importHost('@deepseek-ai/dsh-client-connection/client')
  await mount({ apply(ctx) { connection.installConnection(ctx, { interactions: 'answer', transport: { rpc: rpc.rpc } }) } })
  await mount(await importHost('@deepseek-ai/dsh-typert-registry/client'))
  await mount(await importHost('@deepseek-ai/dsh-api-gateway/client'))
  const contribution = (await importHost('@deepseek-ai/dsh-api-settings-controller/remote')).default
  await mount({ inject: ['remote', 'typert'], async apply(ctx) { await ctx.remote.$mount(contribution) } })
  await mountModule('@deepseek-ai/dsh-client-ui-renderer')
  // This isolated settings page owns no selected Session. Install an explicit
  // absent scope (the same page-owner seam used by the renderer test runtime).
  await mount({ inject: ['slots'], apply(ctx) {
    const current = storeSeed.createSnapshotStore({ hooks: {}, keyedHooks: {}, props: {} })
    ctx.slots.installScope('session', { current, bindingSource: () => current, renderArea: (_binding, props) => props.empty?.() ?? null })
  } })
  const container = document.querySelector('#test-root')
  let unmount
  return { ctx, React, modules, rpc, manifests, mount, mountModule, container, moduleExports,
    async render(Frame) {
      await mount({ inject: ['slots'], apply(ctx) {
        ctx.slots.register({ name: 'root', children: {
          'plugins.row.config': { kind: 'keyed', scope: 'root' },
          'plugins.detail.actions': { kind: 'list', scope: 'root' },
        } }, Frame)
      } })
      await React.act(async () => {
        const reactRoot = ReactDOMClient.createRoot(container)
        reactRoot.render(React.createElement(React.Fragment, null, ctx.slots.renderSlot('root', {})))
        unmount = () => reactRoot.unmount()
      })
    },
    async dispose() {
      try {
        if (unmount) await React.act(async () => unmount())
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await ctx.fiber.dispose()
        rpc.assertNoUnmatched()
      } finally {
        cssHook.deregister()
        dom.window.close()
        for (const [key, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor)
          else delete globalThis[key]
        }
      }
    },
  }
}

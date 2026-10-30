/**
 * 浏览器半边（src/client.js）真实 React 测试：react-test-renderer@18 驱动真实
 * hooks 与元素树（不需要 react-dom/浏览器）。宿主面按 0.2.0-rc.2 公开形状构造：
 * `form` = 官方插件页 formFor() 的 `{ state, mutate }`，`slots` = keyed 槽声明生命周期。
 * client.js 只 require('react')，且 0.5.0 起不再 fetch 任何 `/apollo/api/*`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import TestRenderer from 'react-test-renderer'

const { createElement } = React
const act = TestRenderer.act ?? TestRenderer.default?.act
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const NS = 'apollo'
/** 假 t：键名 + 参数（断言不依赖文案）。 */
const t = (key, params) => (params === undefined ? key : key + '(' + JSON.stringify(params) + ')')

const READY = { exitGuard: false }

/** ConfigForm 公开面：getSnapshot() + mutate(ops, revision)。 */
function makeForm(options = {}) {
  const behavior = options.behavior ?? 'accept'
  let snapshot = {
    status: options.status ?? 'ready',
    value: options.value ?? READY,
    base: options.value ?? READY,
    user: options.user ?? {},
    revision: options.revision ?? 1,
    writable: options.writable ?? true,
    mode: options.mode ?? 'host',
  }
  const calls = []
  const listeners = new Set()
  let settle = null
  const accept = (ops) => {
    const value = structuredClone(snapshot.value)
    for (const op of ops) {
      let cursor = value
      for (const key of op.path.slice(0, -1)) cursor = cursor[key] ??= {}
      cursor[op.path[op.path.length - 1]] = structuredClone(op.value)
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
    return true
  }
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    update(value) {
      snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
    },
    set: async () => true,
    unset: async () => true,
    async mutate(ops, expectedRevision) {
      calls.push({ ops, revision: expectedRevision })
      if (behavior === 'refuse') return false
      if (behavior === 'reject') throw new Error('transport down')
      if (behavior === 'manual') {
        return await new Promise((resolve) => {
          settle = (ok) => { settle = null; resolve(ok ? accept(ops) : false) }
        })
      }
      return accept(ops)
    },
    finish(ok) {
      assert.equal(typeof settle, 'function', 'mutate is not pending')
      settle(ok)
    },
  }
}

/** configForms 假实现：describe 镜像 + 每命名空间一份 makeForm 形态的表单。 */
function makeConfigForms(namespaces = ['apollo-skills', 'dsh-better-goal']) {
  const forms = new Map()
  const mirror = {
    status: 'ready',
    view: { namespaces: namespaces.map((ns) => ({ ns })), writable: true, hasDocument: true },
    error: null,
  }
  return {
    forms,
    describe: () => ({
      getSnapshot: () => mirror,
      subscribe: () => () => {},
      ensure: async () => {},
    }),
    get(ns) {
      if (!forms.has(ns)) forms.set(ns, makeForm())
      return forms.get(ns)
    },
  }
}

/** keyed/list slot 生命周期假实现：声明后才回调 register，撤销即回收。 */
function makeSlots() {
  const watchers = new Map()
  const registrations = []
  return {
    registrations,
    injected: [],
    inject(name, callback) {
      this.injected.push(name)
      const set = watchers.get(name) ?? new Set()
      watchers.set(name, set)
      set.add(callback)
      return () => set.delete(callback)
    },
    register(options, component) {
      const record = { options, component }
      registrations.push(record)
      return () => {
        const at = registrations.indexOf(record)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
    entries(name) {
      return registrations.filter((record) => record.options.name === name)
    },
    entriesOfSlot(name) {
      return this.entries(name)
    },
    subscribe() {
      return () => {}
    },
    getVersion() {
      return 0
    },
    declare(name) {
      const disposers = []
      for (const callback of [...(watchers.get(name) ?? [])]) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      watchers.set(name, new Set(disposers))
      return disposers
    },
    undeclare(name) {
      for (const dispose of watchers.get(name) ?? []) dispose()
      watchers.set(name, new Set())
    },
  }
}

/** 装载一份新的 client.js（模块状态互不串场）。 */
function loadClient() {
  const registrations = []
  new Function('window', SOURCE)({ __ModuleLoader__: { load: (entry) => registrations.push(entry) } })
  assert.equal(registrations.length, 1)
  const exports = new Function('require', 'return (' + registrations[0].factory.toString() + ')(require)')((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected external require: ' + specifier)
  })
  return { entry: registrations[0], exports }
}

/** 装载 client 并 apply（槽仍未声明）：返回可观察注册生命周期的上下文。 */
function install() {
  const slots = makeSlots()
  const effects = []
  const dicts = []
  const loaded = loadClient()
  const configForms = makeConfigForms()
  const ctx = {
    fiber: {},
    inject(keys, callback) {
      if (Array.isArray(keys) && keys.includes('configForms')) return callback(ctx)
      return undefined
    },
    effect(factory, label) { const dispose = factory(); effects.push({ label, dispose }); return dispose },
    locale: { register: (ns, dictionaries) => { dicts.push({ ns, dictionaries }); return () => {} }, bind: () => t },
    slots,
    configForms,
  }
  loaded.exports.apply(ctx)
  return {
    ctx,
    slots,
    effects,
    dicts,
    loaded,
    configForms,
    declare() {
      const disposers = slots.declare('plugins.row.config')
      assert.equal(slots.registrations.length, 2)
      return { disposers, component: slots.registrations[0].component }
    },
  }
}

/** 装载 client、声明槽、起一个挂载好的行配置页。 */
async function mountPage(options = {}) {
  const setup = install()
  const { component } = setup.declare()
  const controller = options.controller ?? makeForm(options.form ?? {})
  // 官方页面交给注册者的配置页 props：form.state + form.mutate（owner share）。
  const form = () => ({ state: controller.getSnapshot(), mutate: (ops, revision) => controller.mutate(ops, revision) })
  const element = () => createElement(component, { view: 'page', t, form: form() })
  let renderer = null
  const page = {
    ...setup,
    component,
    controller,
    get renderer() { return renderer },
    async run(run) { await act(async () => { await run() }) },
    async update() { await act(async () => { renderer.update(element()) }) },
  }
  await act(async () => { renderer = TestRenderer.create(element()) })
  return page
}

// 只匹配宿主元素：组件实例也会带同名 props。
const host = (node) => typeof node.type === 'string'
const byId = (renderer, id) => renderer.root.findAll((node) => host(node) && node.props?.id === id)[0]
const byType = (renderer, type) => renderer.root.findAllByType(type)
const saveButton = (renderer) => byType(renderer, 'button').find((node) => node.props['data-variant'] === 'primary')
const resetButton = (renderer) => byType(renderer, 'button').find((node) => node.children.includes(t('reset')))

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const pageText = (renderer) => textOf(renderer.toJSON())

test('装载与 slot 注册：声明才注册、新键与旧键并排、塌缩回收、summary 只回一行', async () => {
  const { slots, effects, dicts, loaded, declare } = install()
  assert.equal(loaded.entry.id, '@menghuan1918/dsh-apollo')
  assert.deepEqual(loaded.exports.inject, ['slots', 'locale'])
  assert.equal(SOURCE.includes('document.'), false)
  assert.equal(SOURCE.includes('/apollo/api/'), false, 'Apollo 不再读取或注册 /apollo/api/*')

  assert.deepEqual(slots.injected, ['plugins.row.config', 'plugins.detail.actions'])
  assert.equal(slots.registrations.length, 0)
  assert.deepEqual(effects.map((effect) => effect.label), ['@menghuan1918/dsh-apollo: dictionaries', '@menghuan1918/dsh-apollo: row config page', '@menghuan1918/dsh-apollo: settings hub'])
  assert.deepEqual(dicts.map((entry) => entry.ns), [NS])
  assert.deepEqual(Object.keys(dicts[0].dictionaries.zh).sort(), Object.keys(dicts[0].dictionaries.en).sort())

  const declared = declare()
  assert.deepEqual(slots.registrations.map((entry) => entry.options), [
    { name: 'plugins.row.config', key: '@menghuan1918/dsh-apollo#apollo-skills', locale: NS },
    { name: 'plugins.row.config', key: 'dsh-apollo#apollo-skills', locale: NS },
  ])
  assert.equal(declared.disposers.length, 1)
  assert.equal(new Set(slots.registrations.map((entry) => entry.component)).size, 1)

  let renderer
  await act(async () => { renderer = TestRenderer.create(createElement(declared.component, { view: 'summary', t })) })
  assert.equal(pageText(renderer), 'summary')
  assert.equal(byType(renderer, 'style').length, 0)
  await act(async () => { renderer.unmount() })

  slots.undeclare('plugins.row.config')
  assert.equal(slots.registrations.length, 0)
})

test('ready：只渲染 exitGuard 开关、样式表与迁移说明；不再有旧子代理表单', async () => {
  const page = await mountPage()
  const renderer = page.renderer

  const styles = byType(renderer, 'style')
  assert.equal(styles.length, 1)
  assert.match(styles[0].children[0], /\.apollo-switch/)
  assert.match(styles[0].children[0], /--cfg-accent:#3388BB/)
  assert.equal(renderer.root.findAll((node) => String(node.props.className ?? '').includes('apollo-root')).length, 1)

  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], false)
  assert.equal(byType(renderer, 'select').length, 0, 'CLI 权限/模型控件已迁移')
  assert.equal(byType(renderer, 'input').length, 0, '可执行文件/模型输入已迁移')
  assert.equal(renderer.root.findAll((node) => String(node.props.id ?? '').startsWith('apollo-codex')).length, 0)
  assert.match(pageText(renderer), /migratedBody/)
  assert.match(pageText(renderer), /deprecatedBody/)
  assert.equal(saveButton(renderer).props.disabled, true, '无改动时保存不可用')
  assert.equal(resetButton(renderer).props.disabled, true)

  await page.update()
  assert.equal(byType(renderer, 'style').length, 1, '重渲染不重复注入样式')
})

test('切换开关 → 保存只提交 exitGuard set 操作并带当前 revision', async () => {
  const page = await mountPage({ form: { revision: 7 } })
  const renderer = page.renderer
  await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true)
  assert.equal(saveButton(renderer).props.disabled, false)

  await page.run(async () => {
    saveButton(renderer).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
  assert.deepEqual(page.controller.calls, [{ ops: [{ op: 'set', path: ['exitGuard'], value: true }], revision: 7 }])
  assert.match(pageText(renderer), /saved/)
  await page.update()
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true, '镜像折叠后的宿主值就是新值')
})

test('放弃改动：恢复宿主值，不发写入', async () => {
  const page = await mountPage()
  const renderer = page.renderer
  await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true)
  await page.run(async () => { resetButton(renderer).props.onClick() })
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], false)
  assert.deepEqual(page.controller.calls, [])
})

test('冲突（mutate=false）：提示 conflict 并丢弃草稿', async () => {
  const page = await mountPage({ form: { behavior: 'refuse' } })
  const renderer = page.renderer
  await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  await page.run(async () => {
    saveButton(renderer).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
  assert.match(pageText(renderer), /conflict/)
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], false)
})

test('传输错误（mutate 抛错）：错误提示可见，草稿保留可重试', async () => {
  const page = await mountPage({ form: { behavior: 'reject' } })
  const renderer = page.renderer
  await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  await page.run(async () => {
    saveButton(renderer).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
  assert.match(pageText(renderer), /saveFailed/)
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true)
})

test('挂起态：saving 且控件禁用；完成后恢复', async () => {
  const pending = makeForm({ behavior: 'manual' })
  const page = await mountPage({ controller: pending })
  const renderer = page.renderer
  await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  await page.run(async () => { saveButton(renderer).props.onClick() })
  assert.equal(textOf(saveButton(renderer).props.children), 'saving')
  assert.equal(saveButton(renderer).props.disabled, true)
  assert.equal(byId(renderer, 'apollo-exit-guard').props.disabled, true)
  await page.run(async () => { pending.finish(true) })
  await page.update()
  assert.equal(pending.getSnapshot().revision, 2)
  assert.match(pageText(renderer), /saved/)
})

test('只读 / memory / 不可用 / 加载中状态分别可见且禁用写入', async () => {
  for (const [form, expected] of [
    [{ writable: false }, /readonlyNote/],
    [{ mode: 'memory' }, /readonlyNote/],
    [{ status: 'unavailable' }, /unavailable/],
  ]) {
    const page = await mountPage({ form })
    const renderer = page.renderer
    assert.match(pageText(renderer), expected)
    const toggle = byId(renderer, 'apollo-exit-guard')
    if (toggle !== undefined) assert.equal(toggle.props.disabled, true)
    await act(async () => { renderer.unmount() })
  }

  const loading = await mountPage({ form: { status: 'loading' } })
  assert.match(pageText(loading.renderer), /loading/)
  await act(async () => { loading.renderer.unmount() })

  const setup = install()
  const { component } = setup.declare()
  let renderer
  await act(async () => { renderer = TestRenderer.create(createElement(component, { view: 'page', t })) })
  assert.match(pageText(renderer), /waitingForm/, 'form 尚未提供时显示等待窗口')
  await act(async () => { renderer.unmount() })
})

test('没有对外部服务的隐式依赖：client.js 不引用新插件的页面键/网络', () => {
  assert.equal(SOURCE.includes("'@menghuan1918/dsh-better-subagent#"), false)
  assert.equal(SOURCE.includes("'dsh-better-compact#"), false)
  assert.equal(SOURCE.includes('fetch('), false)
})



test('集成设置订阅共享表单：保存与外部更新后数值和 revision 即时同步', async () => {
  const setup = install()
  setup.declare()
  setup.slots.declare('plugins.detail.actions')
  const hub = setup.slots.registrations.find((entry) => entry.options.name === 'plugins.detail.actions')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(hub.component, { subject: { kind: 'bundle', pkg: { name: '@menghuan1918/dsh-apollo' } }, t }))
  })
  const trigger = renderer.root.findAll((node) => host(node) && node.props['data-apollo-hub'] === 'trigger')[0]
  await act(async () => { trigger.props.onClick() })
  const controller = setup.configForms.get('apollo-skills')
  await act(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  await act(async () => { saveButton(renderer).props.onClick() })
  assert.equal(controller.getSnapshot().value.exitGuard, true)
  assert.equal(saveButton(renderer).props.disabled, true, '保存成功后无需手动刷新也会清除 dirty')
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true)
  await act(async () => { controller.update({ exitGuard: false }) })
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], false, '外部更改会推送到面板')
  await act(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
  await act(async () => { saveButton(renderer).props.onClick() })
  assert.deepEqual(controller.calls.map((call) => call.revision), [1, 3], '下一次保存使用新的 revision')
  await act(async () => { renderer.unmount() })
})

test('集成设置：detail.actions 注册、仅 Apollo bundle 渲染按钮、弹窗聚合子插件页', async () => {
  const setup = install()
  const { slots } = setup
  // Apollo 自己的两个 row.config entry 先落账（声明即注册）。
  setup.declare()
  // 模拟一个子插件的 row.config entry（键以 #dsh-better-goal 结尾）。
  const goalFormStates = []
  slots.registrations.push({
    options: { name: 'plugins.row.config', key: '@menghuan1918/dsh-apollo#dsh-better-goal', locale: 'better-goal' },
    component: (props) => {
      goalFormStates.push(props.form?.state?.status ?? 'noform')
      return createElement('div', { 'data-goal-pane': true }, 'goal-pane')
    },
  })
  const disposers = slots.declare('plugins.detail.actions')
  assert.equal(disposers.length, 1)
  const hub = slots.registrations.find((r) => r.options.name === 'plugins.detail.actions')
  assert.ok(hub)
  assert.equal(hub.options.id, 'apollo-settings-hub')

  // 非 Apollo bundle subject → null
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(hub.component, { subject: { kind: 'bundle', pkg: { name: 'other-pkg' } }, t }))
  })
  assert.equal(renderer.toJSON(), null)

  // Apollo bundle subject → 按钮
  await act(async () => {
    renderer.update(createElement(hub.component, { subject: { kind: 'bundle', pkg: { name: '@menghuan1918/dsh-apollo' } }, t }))
  })
  const trigger = renderer.root.findAll((node) => host(node) && node.props['data-apollo-hub'] === 'trigger')[0]
  assert.ok(trigger)
  // 开弹窗（ui-primitives 在测试里缺席 → 走 FallbackModal）
  await act(async () => { trigger.props.onClick() })
  assert.match(pageText(renderer), /hubTitle|Apollo 设置/)
  const navItems = renderer.root.findAll((node) => host(node) && node.props.className === 'apollo-hubNavItem')
  assert.ok(navItems.length >= 2, 'nav 含 Apollo 核心 + 模拟子插件')
  // goal 面板以合成 form（fake configForms describe 含该 ns → ready）渲染
  assert.match(pageText(renderer), /goal-pane/)
  assert.deepEqual(goalFormStates, ['ready'])
  await act(async () => { renderer.unmount() })
})

test('行配置页：单一标题、退出守卫行、兼容性细节默认折叠', async () => {
  const page = await mountPage()
  const renderer = page.renderer

  const titles = renderer.root.findAll((node) => host(node) && node.props.className === 'apollo-pageTitle')
  assert.equal(titles.length, 1)
  assert.equal(textOf(titles[0].props.children), 'title')
  assert.doesNotMatch(pageText(renderer), /hubIntro|intro\(|migratedTitle/)

  const compat = renderer.root.findAll((node) => host(node) && node.type === 'details')[0]
  assert.ok(compat)
  assert.equal(compat.props.open, undefined, '兼容性说明默认折叠')
  assert.match(pageText(renderer), /compatTitle|migratedBody|deprecatedBody|reloadBody/)
  await act(async () => { renderer.unmount() })
})

test('集成设置弹窗：tab 语义、漫游焦点、面板全挂载保草稿、无包 id', async () => {
  const setup = install()
  const { slots } = setup
  setup.declare()
  const edited = []
  for (const rowId of ['dsh-better-subagent', 'dsh-better-compact', 'dsh-better-goal', 'dsh-better-ask-user']) {
    slots.registrations.push({
      options: { name: 'plugins.row.config', key: '@menghuan1918/dsh-apollo#' + rowId, locale: 'fake' },
      component: (props) => {
        if (rowId === 'dsh-better-goal') edited.push(props.form?.state?.status ?? 'noform')
        return createElement('div', { 'data-fake-pane': rowId }, rowId + '-pane')
      },
    })
  }
  slots.declare('plugins.detail.actions')
  const hub = slots.registrations.find((r) => r.options.name === 'plugins.detail.actions')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(hub.component, { subject: { kind: 'bundle', pkg: { name: '@menghuan1918/dsh-apollo' } }, t }))
  })
  const trigger = renderer.root.findAll((node) => host(node) && node.props['data-apollo-hub'] === 'trigger')[0]
  await act(async () => { trigger.props.onClick() })

  const dialog = renderer.root.findAll((node) => host(node) && node.props.role === 'dialog')[0]
  assert.ok(dialog)
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(typeof dialog.props['aria-labelledby'], 'string')
  assert.match(pageText(renderer), /hubTitle/)
  assert.doesNotMatch(pageText(renderer), /hubIntro|done/)

  const tablist = renderer.root.findAll((node) => host(node) && node.props.role === 'tablist')[0]
  assert.ok(tablist)
  const tabs = renderer.root.findAll((node) => host(node) && node.props.role === 'tab')
  assert.equal(tabs.length, 5, '五个行各有一个 tab')
  assert.equal(tabs.filter((tab) => tab.props.tabIndex === 0).length, 1, '漫游焦点：只有一个 tab 可 Tab 到')
  assert.match(String(tabs[0].props['aria-controls']), /apollo-hub-.*-panel-apollo-skills$/)
  assert.equal(tabs[0].props['aria-controls'].replace('-panel-', '-tab-'), tabs[0].props.id)
  for (const tab of tabs) {
    assert.equal(textOf(tab.props.children).includes('apollo-skills'), false)
    assert.equal(textOf(tab.props.children).includes('dsh-better'), false, 'nav 不再重复包名/行 id')
  }
  const panels = renderer.root.findAll((node) => host(node) && node.props.role === 'tabpanel')
  assert.equal(panels.length, 5, '面板全部挂载以保住草稿')
  assert.equal(panels.filter((panel) => panel.props.hidden === true).length, 4)
  assert.match(String(panels[0].props['aria-labelledby']), /apollo-hub-.*-tab-apollo-skills$/)
  assert.match(pageText(renderer), /dsh-better-goal-pane/)

  // 键盘：Down/Up 环绕、Home/End、左右同义。
  const keydown = (key) => act(async () => { tablist.props.onKeyDown({ key, preventDefault() {} }) })
  await keydown('ArrowDown')
  let selected = renderer.root.findAll((node) => host(node) && node.props.role === 'tab' && node.props['aria-selected'] === true)
  assert.equal(selected.length, 1)
  assert.match(String(selected[0].props.id), /-tab-dsh-better-subagent$/)
  await keydown('ArrowUp')
  await keydown('ArrowLeft')
  selected = renderer.root.findAll((node) => host(node) && node.props.role === 'tab' && node.props['aria-selected'] === true)
  assert.match(String(selected[0].props.id), /-tab-dsh-better-ask-user$/)
  await keydown('Home')
  await keydown('End')
  selected = renderer.root.findAll((node) => host(node) && node.props.role === 'tab' && node.props['aria-selected'] === true)
  assert.match(String(selected[0].props.id), /-tab-dsh-better-ask-user$/)
  const visible = renderer.root.findAll((node) => host(node) && node.props.role === 'tabpanel' && !node.props.hidden)
  assert.equal(visible.length, 1)
  assert.match(String(visible[0].props.id), /-panel-dsh-better-ask-user$/)
  assert.ok(edited.length >= 1)
  assert.ok(edited.every((status) => status === 'ready'))

  // Esc 关闭弹窗（dialog 自己的 keydown 路径；document 监听在真实 DOM 生效）。
  await act(async () => { dialog.props.onKeyDown({ key: 'Escape', stopPropagation() {} }) })
  assert.equal(renderer.root.findAll((node) => host(node) && node.props.role === 'dialog').length, 0)
  await act(async () => { renderer.unmount() })
})

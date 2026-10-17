/**
 * 浏览器半边（src/client.js）真实 React 测试：react-test-renderer@18 驱动真实 hooks
 * 与元素树（不需要 react-dom/浏览器）。宿主面按 0.2.0-rc.2 公开形状构造：`form` =
 * 官方插件页 formFor() 的 `{ state, mutate }`，`slots` = keyed 槽声明生命周期，
 * capabilities 用假 fetch（默认不触网）。client.js 只 require('react')。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import TestRenderer from 'react-test-renderer'
import { CLAUDE_PERMISSION_MODES, CODEX_PERMISSION_MODES } from '../src/config.js'

const { createElement } = React
const act = TestRenderer.act ?? TestRenderer.default?.act
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const NS = 'apollo'
/** 假 t：键名 + 参数（断言不依赖文案）。 */
const t = (key, params) => (params === undefined ? key : key + '(' + JSON.stringify(params) + ')')

const READY = {
  exitGuard: false,
  subagents: {
    eng: true,
    global: false,
    codex: {
      enabled: true, executable: 'codex', profile: 'work', permissionMode: 'read-only', defaultModel: 'gpt-5',
      models: [{ id: 'gpt-5', efforts: ['low', 'high'], defaultEffort: 'high' }],
    },
    claude: { enabled: false, executable: 'claude', permissionMode: 'plan', defaultModel: '', models: [] },
  },
}

/** ConfigForm 公开面：getSnapshot() + mutate(ops, revision)。 */
function makeForm(options = {}) {
  const behavior = options.behavior ?? 'accept'
  let snapshot = {
    status: options.status ?? 'ready',
    value: options.value ?? READY,
    base: options.value ?? READY,
    user: options.user,
    revision: options.revision ?? 1,
    writable: options.writable ?? true,
    mode: options.mode ?? 'host',
  }
  const calls = []
  let settle = null
  // 镜像折叠：把写入的 set 操作落到值上并推进 revision。
  const accept = (ops) => {
    const value = structuredClone(snapshot.value)
    for (const op of ops) {
      let cursor = value
      for (const key of op.path.slice(0, -1)) cursor = cursor[key] ??= {}
      cursor[op.path[op.path.length - 1]] = structuredClone(op.value)
    }
    snapshot = { ...snapshot, value, revision: snapshot.revision + 1 }
    return true
  }
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
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

/** keyed slot 生命周期假实现：声明后才回调 register，撤销即回收。 */
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
  loaded.exports.apply({
    fiber: {},
    inject() {},
    effect(factory, label) { const dispose = factory(); effects.push({ label, dispose }); return dispose },
    locale: { register: (ns, dictionaries) => { dicts.push({ ns, dictionaries }); return () => {} }, bind: () => t },
    slots,
  })
  return {
    slots,
    effects,
    dicts,
    loaded,
    declare() {
      const disposers = slots.declare('plugins.row.config')
      assert.equal(slots.registrations.length, 1)
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
    /** 模拟官方页面重渲染（镜像折叠后送来新的快照）。 */
    async update() { await act(async () => { renderer.update(element()) }) },
  }
  await act(async () => { renderer = TestRenderer.create(element()) })
  return page
}

// 只匹配宿主元素：组件实例也会带同名 props。
const host = (node) => typeof node.type === 'string'
const byId = (renderer, id) => renderer.root.findAll((node) => host(node) && node.props?.id === id)[0]
const byLabel = (renderer, label) => renderer.root.findAll((node) => host(node) && node.props?.['aria-label'] === label)[0]
const byType = (renderer, type) => renderer.root.findAllByType(type)
const saveButton = (renderer) => byType(renderer, 'button').find((node) => node.props['data-variant'] === 'primary')
const optionsOf = (node) => node.findAllByType('option').map((option) => option.props.value)

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const pageText = (renderer) => textOf(renderer.toJSON())

/** 假 fetch：默认绝不触网。 */
const CAPABILITIES = {
  executables: { codex: { executable: 'codex', path: '/opt/bin/codex', version: 'codex-cli 9.9.9' }, claude: { executable: 'claude', path: null, version: null } },
  codexProfiles: ['default', 'work'],
}

function useFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = original }
}

useFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: CAPABILITIES }) }))

test('装载与 slot 注册：声明才注册、塌缩回收、summary 只回一行', async () => {
  const { slots, effects, dicts, loaded, declare } = install()
  assert.equal(loaded.entry.id, 'dsh-apollo')
  assert.deepEqual(loaded.exports.inject, ['slots', 'locale'])
  assert.equal(SOURCE.includes('document.'), false)

  // 页面未打开（槽未声明）：只挂等待，不注册。
  assert.deepEqual(slots.injected, ['plugins.row.config'])
  assert.equal(slots.registrations.length, 0)
  assert.deepEqual(effects.map((effect) => effect.label), ['dsh-apollo: dictionaries', 'dsh-apollo: row config page'])
  assert.deepEqual(dicts.map((entry) => entry.ns), [NS])
  assert.deepEqual(Object.keys(dicts[0].dictionaries.zh).sort(), Object.keys(dicts[0].dictionaries.en).sort())

  const declared = declare()
  assert.deepEqual(slots.registrations[0].options, { name: 'plugins.row.config', key: 'dsh-apollo#apollo-skills', locale: NS })
  assert.equal(declared.disposers.length, 1)

  // summary：一行文案，不挂样式表。
  let renderer
  await act(async () => { renderer = TestRenderer.create(createElement(declared.component, { view: 'summary', t })) })
  assert.equal(pageText(renderer), 'summary')
  assert.equal(byType(renderer, 'style').length, 0)
  await act(async () => { renderer.unmount() })

  // 声明塌缩回收。
  slots.undeclare('plugins.row.config')
  assert.equal(slots.registrations.length, 0)
})

test('ready：真实渲染表单 + 唯一 <style>，权限档与 src/config.js 一致', async () => {
  const page = await mountPage()
  const renderer = page.renderer
  await page.run(async () => { await Promise.resolve() })

  const styles = byType(renderer, 'style')
  assert.equal(styles.length, 1)
  assert.match(styles[0].children[0], /\.apollo-switch/)
  assert.match(styles[0].children[0], /--dsw-alias-button-primary-fill/)
  assert.equal(renderer.root.findAll((node) => String(node.props.className ?? '').includes('apollo-root')).length, 1)

  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], false)
  assert.deepEqual(optionsOf(byId(renderer, 'apollo-codex-permission')), [...CODEX_PERMISSION_MODES])
  assert.deepEqual(optionsOf(byId(renderer, 'apollo-claude-permission')), [...CLAUDE_PERMISSION_MODES])
  // 探针成功：profile 选项来自 host 探针，可执行文件显示解析结果。
  assert.deepEqual(optionsOf(byId(renderer, 'apollo-codex-profile')), ['', 'default', 'work'])
  assert.match(pageText(renderer), /\/opt\/bin\/codex/)
  assert.equal(saveButton(renderer).props.disabled, true)

  // 重渲染仍是同一个样式节点（不重复注入）。
  await page.update()
  assert.equal(byType(renderer, 'style').length, 1)
})

test('只读：writable=false 与 mode=memory 都禁用全部控件且不写入', async () => {
  for (const form of [{ writable: false }, { mode: 'memory' }]) {
    const page = await mountPage({ form })
    const renderer = page.renderer
    const controls = renderer.root.findAll((node) => ['input', 'select', 'button'].includes(node.type))
    assert.ok(controls.length > 5)
    for (const control of controls) assert.equal(control.props.disabled, true, String(control.type))
    assert.match(pageText(renderer), /readonly/)
    await page.run(async () => { saveButton(renderer).props.onClick() })
    assert.deepEqual(page.controller.calls, [])
  }
})

test('同一 act 内连续编辑 → 单次 mutate（真实 hooks 状态队列）', async () => {
  const page = await mountPage()
  const renderer = page.renderer

  await act(async () => {
    byId(renderer, 'apollo-exit-guard').props.onClick()
    byId(renderer, 'apollo-scope-global').props.onClick()
    byId(renderer, 'apollo-codex-permission').props.onChange({ target: { value: 'workspace-write' } })
    byId(renderer, 'apollo-codex-default-model').props.onChange({ target: { value: 'gpt-5.1' } })
    byLabel(renderer, 'modelIdPlaceholder 1').props.onChange({ target: { value: 'gpt-5.1' } })
  })

  assert.deepEqual(page.controller.calls, [])
  assert.equal(byId(renderer, 'apollo-exit-guard').props['aria-checked'], true)
  assert.equal(byId(renderer, 'apollo-scope-global').props['aria-checked'], true)
  assert.equal(saveButton(renderer).props.disabled, false)

  await page.run(async () => { saveButton(renderer).props.onClick() })
  assert.equal(page.controller.calls.length, 1)
  assert.equal(page.controller.calls[0].revision, 1)
  assert.deepEqual(page.controller.calls[0].ops, [
    { op: 'set', path: ['exitGuard'], value: true },
    { op: 'set', path: ['subagents', 'global'], value: true },
    { op: 'set', path: ['subagents', 'codex', 'permissionMode'], value: 'workspace-write' },
    { op: 'set', path: ['subagents', 'codex', 'defaultModel'], value: 'gpt-5.1' },
    { op: 'set', path: ['subagents', 'codex', 'models'], value: [{ id: 'gpt-5.1', efforts: ['low', 'high'], defaultEffort: 'high' }] },
  ])
  await page.update()
  assert.match(pageText(renderer), /saved/)
  assert.equal(saveButton(renderer).props.disabled, true)
})

test('saving 与 conflict：挂起态、false 回退宿主值、抛错保留草稿', async () => {
  // 挂起：按钮显示 saving 且禁用，宿主接受后 revision 前进。
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

  // false：宿主拒绝 → 回退宿主值 + warn，且不再可保存。
  const refusing = makeForm({ behavior: 'refuse' })
  const refused = await mountPage({ controller: refusing })
  const back = refused.renderer
  await refused.run(async () => { byId(back, 'apollo-exit-guard').props.onClick() })
  await refused.run(async () => { saveButton(back).props.onClick() })
  await refused.update()
  assert.equal(refusing.calls.length, 1)
  assert.equal(byId(back, 'apollo-exit-guard').props['aria-checked'], false)
  assert.match(pageText(back), /conflict/)
  assert.equal(saveButton(back).props.disabled, true)

  // 抛错：保留草稿、显示失败详情、可再次保存。
  const failing = makeForm({ behavior: 'reject' })
  const failed = await mountPage({ controller: failing })
  const kept = failed.renderer
  await failed.run(async () => { byId(kept, 'apollo-exit-guard').props.onClick() })
  await failed.run(async () => { saveButton(kept).props.onClick() })
  await failed.update()
  assert.match(pageText(kept), /saveFailed/)
  assert.match(pageText(kept), /transport down/)
  assert.equal(byId(kept, 'apollo-exit-guard').props['aria-checked'], true)
  assert.equal(saveButton(kept).props.disabled, false)
})

test('模型 effort 关联与启用校验：缓冲保住逗号、失配清空、缺项阻止保存', async () => {
  const page = await mountPage()
  const renderer = page.renderer

  // effort 文本缓冲：未输完的逗号不被吃掉；默认 effort 失配即清空。
  await page.run(async () => { byLabel(renderer, 'modelsLabel 1').props.onChange({ target: { value: 'low, mid, ' } }) })
  assert.equal(byLabel(renderer, 'modelsLabel 1').props.value, 'low, mid, ')
  assert.equal(byLabel(renderer, 'modelDefaultEffort 1').props.value, '')
  assert.deepEqual(optionsOf(byLabel(renderer, 'modelDefaultEffort 1')), ['', 'low', 'mid'])

  // 启用的后端缺默认 effort → 阻止保存并点明后端。
  assert.equal(saveButton(renderer).props.disabled, true)
  assert.match(pageText(renderer), /invalidDefaultEffort.*codexTitle/)

  // 选定默认 effort 后可保存。
  await page.run(async () => { byLabel(renderer, 'modelDefaultEffort 1').props.onChange({ target: { value: 'mid' } }) })
  assert.equal(saveButton(renderer).props.disabled, false)
  await page.run(async () => { saveButton(renderer).props.onClick() })
  assert.deepEqual(page.controller.calls[0].ops, [{
    op: 'set',
    path: ['subagents', 'codex', 'models'],
    value: [{ id: 'gpt-5', efforts: ['low', 'mid'], defaultEffort: 'mid' }],
  }])

  // 清空默认模型 / 删掉全部模型：都阻止保存并给出明确原因。
  await page.run(async () => { byId(renderer, 'apollo-codex-default-model').props.onChange({ target: { value: '' } }) })
  assert.equal(saveButton(renderer).props.disabled, true)
  assert.match(pageText(renderer), /invalidDefaultModel/)
  await page.run(async () => { byLabel(renderer, 'modelRemove').props.onClick() })
  assert.equal(saveButton(renderer).props.disabled, true)
  assert.match(pageText(renderer), /invalidNoModels/)
})

test('capabilities 失败：降级提示但保存仍可用', async () => {
  const restore = useFetch(async () => { throw new Error('offline') })
  try {
    const page = await mountPage()
    const renderer = page.renderer
    await page.run(async () => {})
    assert.match(pageText(renderer), /capabilitiesError/)

    await page.run(async () => { byId(renderer, 'apollo-exit-guard').props.onClick() })
    await page.run(async () => { saveButton(renderer).props.onClick() })
    assert.equal(page.controller.calls.length, 1)
  } finally {
    restore()
  }
})

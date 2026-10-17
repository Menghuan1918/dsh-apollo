/**
 * 正式配置（src/config.js）单元测试。
 *
 * 覆盖四件事：
 *   1. `Config` schema 的**形状契约**（默认值、volatile 位置、部署标志不 volatile）；
 *   2. `normalizeConfig` 的 EXACT 默认形状、volatile 引用展开、非法值回退、
 *      去重/裁剪规则，以及「返回全新普通对象」；
 *   3. `currentConfig` / `liveConfigEntry` 经 configEditor 读活 fiber 配置；
 *   4. 与 dsh-settings 的投影契约（本地复刻其 volatileForm/projectForm/
 *      isVolatilePath 三个纯函数，按参考运行时 0.2.0-rc.2 的
 *      `@deepseek-ai/dsh-settings/lib/index.js` 抄写）：可编辑字段集合必须恰好是
 *      volatile 集合，`trustedHosts`/`declareOwnsHost` 必须落在表单之外。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  Config,
  DEFAULT_CONFIG,
  ENTRY_ID,
  PACKAGE_NAME,
  ROW_CONFIG_KEY,
  currentConfig,
  liveConfigEntry,
  normalizeConfig,
} from '../src/config.js'

/** 规范里写死的默认形状（EXACT）。 */
const EXPECTED_DEFAULT = {
  exitGuard: false,
  subagents: {
    eng: true,
    global: false,
    codex: {
      enabled: false,
      executable: 'codex',
      profile: '',
      permissionMode: 'read-only',
      defaultModel: '',
      models: [],
    },
    claude: {
      enabled: false,
      executable: 'claude',
      permissionMode: 'plan',
      defaultModel: '',
      models: [],
    },
  },
  trustedHosts: [],
  declareOwnsHost: false,
}

/** cosmokit volatile 引用（与 `createVolatile` 同协议）。 */
function volatileRef(value) {
  return Object.freeze({
    get: () => value,
    [Symbol.for('cosmokit.volatile.write')]: () => {},
  })
}

// ── dsh-settings 投影的本地复刻（纯函数，按 0.2.0-rc.2 抄写）───────────────

function plainConfig(value) {
  if (typeof value === 'object' && value !== null && typeof value.get === 'function') return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

const liveSchema = new z(Config.toJSON())

// ── 形状契约 ────────────────────────────────────────────────────────────────

test('标识常量：行 id / 包名 / 行配置键', () => {
  assert.equal(ENTRY_ID, 'apollo-skills')
  assert.equal(PACKAGE_NAME, 'dsh-apollo')
  assert.equal(ROW_CONFIG_KEY, 'dsh-apollo#apollo-skills')
})

test('权限档常量：与两个 CLI 的实测取值一一对应', () => {
  assert.deepEqual([...CODEX_PERMISSION_MODES], ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual([...CLAUDE_PERMISSION_MODES], ['plan', 'manual', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'])
  // claude 没有 default 档——默认值必须是列表里的 plan。
  assert.equal(CLAUDE_PERMISSION_MODES.includes('default'), false)
})

test('浏览器半边的权限档清单与 config.js 同步（无法 import，只能文本对齐）', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const lists = [...source.matchAll(/permissions: \[([^\]]*)\]/g)].map((match) => match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter((entry) => entry !== ''))
  assert.equal(lists.length, 2)
  assert.deepEqual(lists[0], [...CODEX_PERMISSION_MODES])
  assert.deepEqual(lists[1], [...CLAUDE_PERMISSION_MODES])
})

test('Config 解析空配置即默认形状，且 volatile 字段是引用', () => {
  const resolved = Config({})
  assert.equal(resolved.exitGuard.get(), false)
  assert.deepEqual(resolved.subagents.eng.get(), true)
  assert.deepEqual(resolved.subagents.global.get(), false)
  assert.deepEqual(resolved.subagents.codex.get(), EXPECTED_DEFAULT.subagents.codex)
  assert.deepEqual(resolved.subagents.claude.get(), EXPECTED_DEFAULT.subagents.claude)
  assert.deepEqual(resolved.trustedHosts, [])
  assert.equal(resolved.declareOwnsHost, false)
})

test('Config 拒绝非法权限档（union 校验）', () => {
  assert.throws(() => Config({ subagents: { codex: { permissionMode: 'yolo' } } }))
  assert.throws(() => Config({ subagents: { claude: { permissionMode: 'yolo' } } }))
  assert.equal(Config({ subagents: { codex: { permissionMode: 'danger-full-access' } } }).subagents.codex.get().permissionMode, 'danger-full-access')
})

test('volatile 路径恰好是设置页可编辑集合', () => {
  const paths = []
  const walk = (node, path) => {
    if (node.meta?.volatile === true) paths.push(path.join('.'))
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
    if (node.inner) walk(node.inner, [...path, '[]'])
    for (const child of node.list ?? []) walk(child, [...path, '|'])
  }
  walk(liveSchema, [])
  assert.deepEqual(paths.sort(), [
    'exitGuard',
    'subagents.claude',
    'subagents.codex',
    'subagents.eng',
    'subagents.global',
  ])
  // 部署标志是普通字段：改它们应当重挂本行，而不是走 volatile 快路径。
  assert.equal(isVolatilePath(liveSchema, ['trustedHosts']), false)
  assert.equal(isVolatilePath(liveSchema, ['declareOwnsHost']), false)
})

// ── normalizeConfig ────────────────────────────────────────────────────────

test('normalizeConfig(undefined) 与规范默认形状 EXACT 一致', () => {
  assert.deepEqual(normalizeConfig(undefined), EXPECTED_DEFAULT)
  assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULT)
  // 两个后端的键集合必须严格一致（claude 没有 profile 键）。
  assert.deepEqual(Object.keys(normalizeConfig(undefined).subagents.codex), ['enabled', 'executable', 'profile', 'permissionMode', 'defaultModel', 'models'])
  assert.deepEqual(Object.keys(normalizeConfig(undefined).subagents.claude), ['enabled', 'executable', 'permissionMode', 'defaultModel', 'models'])
})

test('normalizeConfig：非对象输入一律回退默认', () => {
  for (const input of [null, undefined, 0, '', 'yes', [], true, () => {}]) {
    assert.deepEqual(normalizeConfig(input), EXPECTED_DEFAULT)
  }
})

test('normalizeConfig：展开 volatile 引用（含嵌套）', () => {
  const config = {
    exitGuard: volatileRef(true),
    subagents: {
      eng: volatileRef(false),
      global: volatileRef(true),
      codex: volatileRef({
        enabled: true,
        executable: 'codex-custom',
        profile: 'work',
        permissionMode: 'workspace-write',
        defaultModel: 'gpt-5',
        models: volatileRef([{ id: 'gpt-5', efforts: ['low'], defaultEffort: 'low' }]),
      }),
      claude: volatileRef({ enabled: false }),
    },
    trustedHosts: ['dsh.example.com'],
    declareOwnsHost: volatileRef(false),
  }
  assert.deepEqual(normalizeConfig(config), {
    exitGuard: true,
    subagents: {
      eng: false,
      global: true,
      codex: {
        enabled: true,
        executable: 'codex-custom',
        profile: 'work',
        permissionMode: 'workspace-write',
        defaultModel: 'gpt-5',
        models: [{ id: 'gpt-5', efforts: ['low'], defaultEffort: 'low' }],
      },
      claude: { enabled: false, executable: 'claude', permissionMode: 'plan', defaultModel: '', models: [] },
    },
    trustedHosts: ['dsh.example.com'],
    declareOwnsHost: false,
  })
})

test('normalizeConfig：部分输入只覆盖给出的字段', () => {
  const config = normalizeConfig({ subagents: { codex: { enabled: true } } })
  assert.equal(config.subagents.codex.enabled, true)
  assert.equal(config.subagents.codex.executable, 'codex')
  assert.equal(config.subagents.codex.permissionMode, 'read-only')
  assert.equal(config.subagents.eng, true)
  assert.equal(config.subagents.global, false)
  assert.equal(config.exitGuard, false)
})

test('normalizeConfig：类型非法回退默认（含 eng 默认 true）', () => {
  const config = normalizeConfig({
    exitGuard: 'off',
    subagents: { eng: 'yes', global: 1, codex: 'nope', claude: false },
    trustedHosts: 'dsh.example.com',
    declareOwnsHost: 0,
  })
  assert.equal(config.exitGuard, false)
  assert.equal(config.subagents.eng, true)
  assert.equal(config.subagents.global, false)
  assert.deepEqual(config.subagents.codex, EXPECTED_DEFAULT.subagents.codex)
  assert.deepEqual(config.subagents.claude, EXPECTED_DEFAULT.subagents.claude)
  assert.deepEqual(config.trustedHosts, [])
  assert.equal(config.declareOwnsHost, false)
})

test('normalizeConfig：权限档只接受枚举内的值', () => {
  const config = normalizeConfig({
    subagents: {
      codex: { permissionMode: 'bypassPermissions' },
      claude: { permissionMode: 'danger-full-access' },
    },
  })
  assert.equal(config.subagents.codex.permissionMode, 'read-only')
  assert.equal(config.subagents.claude.permissionMode, 'plan')
  const ok = normalizeConfig({ subagents: { codex: { permissionMode: 'workspace-write' }, claude: { permissionMode: 'acceptEdits' } } })
  assert.equal(ok.subagents.codex.permissionMode, 'workspace-write')
  assert.equal(ok.subagents.claude.permissionMode, 'acceptEdits')
})

test('normalizeConfig：可执行文件去空白、空值回退默认名字', () => {
  assert.equal(normalizeConfig({ subagents: { codex: { executable: '  /opt/codex  ' } } }).subagents.codex.executable, '/opt/codex')
  assert.equal(normalizeConfig({ subagents: { codex: { executable: '   ' } } }).subagents.codex.executable, 'codex')
  assert.equal(normalizeConfig({ subagents: { codex: { executable: 42 } } }).subagents.codex.executable, 'codex')
  assert.equal(normalizeConfig({ subagents: { claude: { executable: '~/bin/claude' } } }).subagents.claude.executable, '~/bin/claude')
})

test('normalizeConfig：模型列表去脏、去重、defaultEffort 必须属于 efforts', () => {
  const config = normalizeConfig({
    subagents: {
      codex: {
        models: [
          { id: 'gpt-5', efforts: ['low', 'low', 'high', 7], defaultEffort: 'high' },
          { id: 'gpt-5', efforts: ['x'], defaultEffort: 'x' },
          { id: '  ', efforts: ['x'] },
          { id: 'gpt-5.1', efforts: 'low', defaultEffort: 'low' },
          null,
          'junk',
          { efforts: ['x'] },
        ],
      },
    },
  })
  assert.deepEqual(config.subagents.codex.models, [
    { id: 'gpt-5', efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'gpt-5.1', efforts: [], defaultEffort: '' },
  ])
})

test('normalizeConfig：trustedHosts 去空、去重、去空白', () => {
  const config = normalizeConfig({ trustedHosts: ['dsh.example.com', ' dsh.example.com ', '', 7, null, 'proxy.local:8443'] })
  assert.deepEqual(config.trustedHosts, ['dsh.example.com', 'proxy.local:8443'])
})

test('normalizeConfig：返回全新普通对象（可安全改写、两次调用互不影响）', () => {
  const first = normalizeConfig(undefined)
  first.subagents.codex.models.push({ id: 'x', efforts: [], defaultEffort: '' })
  first.trustedHosts.push('dsh.example.com')
  const second = normalizeConfig(undefined)
  assert.deepEqual(second, EXPECTED_DEFAULT)
  assert.equal(Object.getPrototypeOf(second), Object.prototype)
})

// ── 与 dsh-settings 的投影契约 ──────────────────────────────────────────────

test('dsh-settings 投影：表单字段恰好是 volatile 集合，值不含部署标志', () => {
  const form = volatileForm(liveSchema)
  assert.equal(form?.type, 'object')
  assert.deepEqual(Object.keys(form.dict).sort(), ['exitGuard', 'subagents'])
  const resolved = Config({
    exitGuard: true,
    trustedHosts: ['dsh.example.com'],
    declareOwnsHost: true,
    subagents: { codex: { enabled: true, models: [{ id: 'gpt-5', efforts: ['low'], defaultEffort: 'low' }] } },
  })
  const value = projectForm(form, plainConfig(resolved))
  assert.deepEqual(value, {
    exitGuard: true,
    subagents: {
      eng: true,
      global: false,
      codex: {
        enabled: true,
        executable: 'codex',
        profile: '',
        permissionMode: 'read-only',
        defaultModel: '',
        models: [{ id: 'gpt-5', efforts: ['low'], defaultEffort: 'low' }],
      },
      claude: { enabled: false, executable: 'claude', permissionMode: 'plan', defaultModel: '', models: [] },
    },
  })
  // 表单写入只允许落在 volatile 路径上：部署标志必须被拒绝。
  assert.equal(isVolatilePath(liveSchema, ['subagents', 'codex', 'models', '0', 'id']), true)
  assert.equal(isVolatilePath(liveSchema, ['subagents', 'eng']), true)
  assert.equal(isVolatilePath(liveSchema, ['trustedHosts', '0']), false)
})

// ── currentConfig / liveConfigEntry ────────────────────────────────────────

/** 造一个 configEditor 假服务，entries 返回给定行。 */
function fakeContext(entries, { throws = false } = {}) {
  return {
    get(name) {
      if (throws) throw new Error('cannot get property "' + name + '" without inject')
      return name === 'configEditor' ? { entries: () => entries } : undefined
    },
  }
}

test('liveConfigEntry：按行 id 命中，其次按模块名', () => {
  const byId = { options: { id: ENTRY_ID, name: 'dsh-apollo' }, fiber: { config: {} } }
  assert.equal(liveConfigEntry(fakeContext([{ options: { id: 'other' } }, byId])), byId)
  const byName = { options: { id: 'renamed-row', name: PACKAGE_NAME }, fiber: { config: {} } }
  assert.equal(liveConfigEntry(fakeContext([byName])), byName)
  assert.equal(liveConfigEntry(fakeContext([])), undefined)
  assert.equal(liveConfigEntry(undefined), undefined)
})

test('currentConfig：读活 fiber 配置并展开 volatile 引用', () => {
  const entry = {
    options: { id: ENTRY_ID },
    fiber: { config: { exitGuard: volatileRef(true), subagents: { codex: volatileRef({ enabled: true, defaultModel: 'gpt-5' }) } } },
  }
  const config = currentConfig(fakeContext([entry]))
  assert.equal(config.exitGuard, true)
  assert.equal(config.subagents.codex.enabled, true)
  assert.equal(config.subagents.codex.defaultModel, 'gpt-5')
  assert.equal(config.subagents.eng, true)
})

test('currentConfig：configEditor 不可见时回退 fallback，且绝不抛错', () => {
  assert.deepEqual(currentConfig(undefined, { exitGuard: true }), { ...EXPECTED_DEFAULT, exitGuard: true })
  assert.deepEqual(currentConfig({ get: () => undefined }, { trustedHosts: ['dsh.example.com'] }).trustedHosts, ['dsh.example.com'])
  assert.deepEqual(currentConfig(fakeContext([], { throws: true }), { exitGuard: true }).exitGuard, true)
  assert.deepEqual(currentConfig({ get() { return { entries: () => { throw new Error('boom') } } } }), EXPECTED_DEFAULT)
  assert.deepEqual(currentConfig({ get() { return { entries: 'nope' } } }), EXPECTED_DEFAULT)
  assert.deepEqual(currentConfig(fakeContext([{ options: { id: 'other' } }])), EXPECTED_DEFAULT)
})

test('currentConfig：活 entry 存在时忽略 fallback', () => {
  const entry = { options: { id: ENTRY_ID }, fiber: { config: { exitGuard: false } } }
  assert.equal(currentConfig(fakeContext([entry]), { exitGuard: true }).exitGuard, false)
})

/**
 * 设置装配（src/settings.js）单元测试。
 *
 * 覆盖：旧 eng.json / atlas.json 只读读取与优先级、导入补丁规则（当前 profile
 * 显式值优先、无意义写入跳过）、`importLegacyConfig` 的等待 Loader/服务缺失/
 * 行不可配置路径，以及 `mountSettings` 的装配（延迟 settings→页面策略 +
 * 一次性导入、declareOwnsHost tap、零 HTTP 路由、无服务时不炸）。
 *
 * 以 fake ctx 驱动，不启真实 HTTP 服务、不落真实 profile。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY_ID } from '../src/config.js'
import {
  LEGACY_FILES,
  importLegacyConfig,
  legacyPatch,
  mountSettings,
  readLegacyDocument,
} from '../src/settings.js'

/** 在临时 DSH_HOME 下写文件并运行断言。 */
async function withHome(files, run) {
  const home = mkdtempSync(join(tmpdir(), 'apollo-settings-'))
  for (const [name, content] of Object.entries(files ?? {})) writeFileSync(join(home, name), content)
  const env = { DSH_HOME: home }
  try {
    await run(env, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** 造一个 settings 假服务：记录 update 调用，describe 返回给定描述符。 */
function fakeSettings({ descriptors = [], describe = undefined, update = undefined, calls = [] } = {}) {
  return {
    calls,
    async describe() {
      if (describe !== undefined) return describe()
      return descriptors
    },
    async update(...args) {
      calls.push(args)
      if (update !== undefined) return update(...args)
      return undefined
    },
  }
}

/** 造一个 Loader 假服务：记录 await 调用顺序。 */
function fakeLoader(order, label = 'loader.await') {
  return {
    async await() {
      order.push(label)
    },
  }
}

/** 造注入用的子上下文（settings 侧）。 */
function settingsContext({ settings, loader, order = [], logger = undefined, fiber = undefined, effectLabels = [] }) {
  return {
    settings,
    fiber,
    logger,
    root: loader === undefined ? {} : { loader },
    effect: (factory, label) => {
      effectLabels.push(label)
      return factory()
    },
    get: () => undefined,
  }
}

// ── 旧文档读取 ──────────────────────────────────────────────────────────────

test('LEGACY_FILES：新名优先，旧名只读回退', () => {
  assert.deepEqual([...LEGACY_FILES], ['eng.json', 'atlas.json'])
})

test('readLegacyDocument：eng.json 优先，atlas.json 回退，缺失返回 undefined', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}', 'atlas.json': '{"exitGuard":false}' }, async (env) => {
    const found = readLegacyDocument(env)
    assert.equal(found.file, 'eng.json')
    assert.equal(found.path, join(env.DSH_HOME, 'eng.json'))
    assert.deepEqual(found.value, { exitGuard: true })
  })
  await withHome({ 'atlas.json': '{"exitGuard":true}' }, async (env) => {
    assert.equal(readLegacyDocument(env).file, 'atlas.json')
  })
  await withHome(undefined, async (env) => {
    assert.equal(readLegacyDocument(env), undefined)
  })
})

test('readLegacyDocument：eng.json 损坏时回退 atlas.json；非对象顶层忽略', async () => {
  await withHome({ 'eng.json': '{ not json', 'atlas.json': '{"exitGuard":true}' }, async (env) => {
    assert.equal(readLegacyDocument(env).file, 'atlas.json')
  })
  await withHome({ 'eng.json': '[]' }, async (env) => {
    assert.equal(readLegacyDocument(env), undefined)
  })
  await withHome({ 'eng.json': 'null' }, async (env) => {
    assert.equal(readLegacyDocument(env), undefined)
  })
  await withHome({ 'eng.json': '"yes"' }, async (env) => {
    assert.equal(readLegacyDocument(env), undefined)
  })
})

// ── 导入补丁规则 ────────────────────────────────────────────────────────────

test('legacyPatch：用户层没有该字段且值不同 → 导入', () => {
  assert.deepEqual(legacyPatch({ exitGuard: true }, {}, { exitGuard: false }), { exitGuard: true })
  assert.deepEqual(legacyPatch({ exitGuard: false }, { subagents: {} }, { exitGuard: true }), { exitGuard: false })
})

test('legacyPatch：当前 profile 显式值优先（含显式 false）', () => {
  assert.deepEqual(legacyPatch({ exitGuard: true }, { exitGuard: false }, { exitGuard: false }), {})
  assert.deepEqual(legacyPatch({ exitGuard: false }, { exitGuard: false }, { exitGuard: false }), {})
  // 用户层存在但值不同（被更高层覆盖时）也不动它。
  assert.deepEqual(legacyPatch({ exitGuard: true }, { exitGuard: false }, { exitGuard: true }), {})
})

test('legacyPatch：生效值已相同 → 不写盘；非布尔旧值 → 忽略', () => {
  assert.deepEqual(legacyPatch({ exitGuard: false }, {}, { exitGuard: false }), {})
  assert.deepEqual(legacyPatch({ exitGuard: true }, {}, { exitGuard: true }), {})
  assert.deepEqual(legacyPatch({ exitGuard: 'yes' }, {}, { exitGuard: false }), {})
  assert.deepEqual(legacyPatch({}, {}, { exitGuard: false }), {})
  assert.deepEqual(legacyPatch({ exitGuardIgnore: ['x'] }, {}, { exitGuard: false }), {})
  assert.deepEqual(legacyPatch(undefined, {}, undefined), {})
})

// ── importLegacyConfig ─────────────────────────────────────────────────────

test('importLegacyConfig：没有旧文件 → absent，且不碰 settings', async () => {
  await withHome(undefined, async (env) => {
    const settings = fakeSettings()
    const result = await importLegacyConfig(settingsContext({ settings }), env)
    assert.deepEqual(result, { imported: false, reason: 'absent' })
    assert.deepEqual(settings.calls, [])
  })
})

test('importLegacyConfig：settings 服务不可用 → unavailable', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const result = await importLegacyConfig({ settings: undefined }, env)
    assert.deepEqual(result, { imported: false, reason: 'unavailable', file: 'eng.json' })
  })
})

test('importLegacyConfig：先等 Loader 装配完，再 describe → update', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const order = []
    const settings = fakeSettings({
      descriptors: [{ ns: ENTRY_ID, revision: 4, user: {}, value: { exitGuard: false } }],
      describe: () => {
        order.push('describe')
        return [{ ns: ENTRY_ID, revision: 4, user: {}, value: { exitGuard: false } }]
      },
      update: () => {
        order.push('update')
      },
    })
    const ctx = settingsContext({ settings, loader: fakeLoader(order), order })
    const result = await importLegacyConfig(ctx, env)
    assert.deepEqual(order, ['loader.await', 'describe', 'update'])
    assert.deepEqual(result, { imported: true, file: 'eng.json', patch: { exitGuard: true } })
    assert.deepEqual(settings.calls, [[ENTRY_ID, { exitGuard: true }, 4]])
  })
})

test('importLegacyConfig：本行不在可配置列表里 → not-configurable', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const settings = fakeSettings({ descriptors: [{ ns: 'other-row', revision: 1, user: {}, value: {} }] })
    const result = await importLegacyConfig(settingsContext({ settings }), env)
    assert.deepEqual(result, { imported: false, reason: 'not-configurable', file: 'eng.json' })
    assert.deepEqual(settings.calls, [])
  })
})

test('importLegacyConfig：用户层已有该字段 → no-change，不写盘', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const settings = fakeSettings({ descriptors: [{ ns: ENTRY_ID, revision: 2, user: { exitGuard: false }, value: { exitGuard: false } }] })
    const result = await importLegacyConfig(settingsContext({ settings }), env)
    assert.deepEqual(result, { imported: false, reason: 'no-change', file: 'eng.json' })
    assert.deepEqual(settings.calls, [])
  })
})

test('importLegacyConfig：atlas.json 回退也能导入', async () => {
  await withHome({ 'atlas.json': '{"exitGuard":true}' }, async (env) => {
    const settings = fakeSettings({ descriptors: [{ ns: ENTRY_ID, revision: 1, user: {}, value: { exitGuard: false } }] })
    const result = await importLegacyConfig(settingsContext({ settings }), env)
    assert.equal(result.imported, true)
    assert.equal(result.file, 'atlas.json')
    assert.deepEqual(settings.calls, [[ENTRY_ID, { exitGuard: true }, 1]])
  })
})

test('importLegacyConfig：写入被宿主拒绝时把错误抛给调用方', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const settings = fakeSettings({
      descriptors: [{ ns: ENTRY_ID, revision: 1, user: {}, value: { exitGuard: false } }],
      update: () => {
        throw new Error('SETTINGS_CONFLICT')
      },
    })
    await assert.rejects(() => importLegacyConfig(settingsContext({ settings }), env), /SETTINGS_CONFLICT/)
  })
})

// ── mountSettings 装配 ─────────────────────────────────────────────────────

/** 造 mountSettings 用的 fake ctx：记录 inject 并立即用子上下文回调。 */
function makeMountCtx(services, { fiber = { id: 'fiber' } } = {}) {
  const injections = []
  const ctx = {
    fiber,
    inject(names, callback) {
      injections.push(names)
      const key = names.join(',')
      if (!Object.hasOwn(services, key)) return
      callback(services[key])
    },
  }
  return { ctx, injections }
}

test('mountSettings：只延迟注入 settings；零 HTTP 路由（路由归独立插件）', async () => {
  const routes = []
  const effects = []
  const { ctx, injections } = makeMountCtx({
    settings: {
      settings: { configure: () => () => {}, describe: async () => [], update: async () => {} },
      effect: (factory, label) => { effects.push(label); return factory() },
    },
  })
  const mount = mountSettings(ctx, { trustedHosts: ['dsh.example.com'] })
  assert.deepEqual(injections, [['settings']], '不能再注入 webServer 注册能力路由')
  await mount.legacyImport
  assert.deepEqual(routes, [])
  assert.deepEqual(effects, ['apollo-settings: row config page policy'])
})

test('mountSettings：登记行配置页面策略（auto:false + 本插件 fiber）', async () => {
  const configureCalls = []
  const fiber = { id: 'apollo-fiber' }
  const { ctx } = makeMountCtx({
    settings: {
      settings: {
        configure: (...args) => { configureCalls.push(args); return () => {} },
        describe: async () => [],
        update: async () => {},
      },
      effect: (factory) => factory(),
      logger: { warn: () => {}, info: () => {} },
    },
  }, { fiber })
  const mount = mountSettings(ctx, {})
  await mount.legacyImport
  assert.equal(configureCalls.length, 1)
  assert.deepEqual(configureCalls[0], [{ auto: false }, fiber])
})

test('mountSettings：策略登记抛错时只告警，不影响一次性导入', async () => {
  const warnings = []
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const calls = []
    const { ctx } = makeMountCtx({
      settings: {
        settings: {
          configure: () => { throw new Error('already configured') },
          describe: async () => [{ ns: ENTRY_ID, revision: 3, user: {}, value: { exitGuard: false } }],
          update: async (...args) => { calls.push(args) },
        },
        effect: () => () => {},
        logger: { warn: (message) => warnings.push(message), info: () => {} },
      },
    })
    const mount = mountSettings(ctx, {}, { env })
    await mount.legacyImport
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /page policy was not registered/)
    assert.deepEqual(calls, [[ENTRY_ID, { exitGuard: true }, 3]])
  })
})

test('mountSettings：declareOwnsHost:true 时装上反代 tap，且不注册路由', () => {
  const taps = []
  const routes = []
  const { ctx, injections } = makeMountCtx({
    webServer: {
      webServer: { register: (route) => { routes.push(route); return () => {} }, tapIndex: (tap) => { taps.push(tap); return () => {} } },
      effect: (factory) => factory(),
    },
  })
  mountSettings(ctx, { declareOwnsHost: true })
  assert.deepEqual(injections, [['webServer'], ['settings']])
  assert.equal(taps.length, 1)
  assert.equal(taps[0]('<head></head>').includes('__DSH_TRANSPORT__'), true)
  assert.deepEqual(routes, [])
})

test('mountSettings：declareOwnsHost 缺省时不装 tap', () => {
  const taps = []
  const { ctx, injections } = makeMountCtx({
    webServer: {
      webServer: { register: () => () => {}, tapIndex: (tap) => { taps.push(tap); return () => {} } },
      effect: (factory) => factory(),
    },
  })
  mountSettings(ctx, { trustedHosts: ['dsh.example.com'] })
  assert.deepEqual(injections, [['settings']])
  assert.deepEqual(taps, [])
})

test('mountSettings：服务缺失（headless）时安静返回，只保留 settings 注入', () => {
  const injections = []
  const ctx = { fiber: {}, inject: (names) => { injections.push(names) } }
  mountSettings(ctx, {})
  assert.deepEqual(injections, [['settings']])
  const withTap = []
  const tapCtx = { fiber: {}, inject: (names) => { withTap.push(names) } }
  mountSettings(tapCtx, { declareOwnsHost: true })
  assert.deepEqual(withTap, [['webServer'], ['settings']])
})

test('mountSettings：同一份装配里旧配置只导入一次，legacyImport 在完成后 resolve', async () => {
  await withHome({ 'eng.json': '{"exitGuard":true}' }, async (env) => {
    const calls = []
    const settingsCtx = {
      settings: {
        configure: () => () => {},
        describe: async () => [{ ns: ENTRY_ID, revision: 1, user: {}, value: { exitGuard: false } }],
        update: async (...args) => { calls.push(args) },
      },
      effect: () => () => {},
      logger: { warn: () => {}, info: () => {} },
    }
    const ctx = {
      fiber: {},
      inject(names, callback) {
        if (names.length === 1 && names[0] === 'settings') {
          // 同一服务反复可用（settings 重载）时回调会多次触发。
          callback(settingsCtx)
          callback(settingsCtx)
        }
      },
    }
    const mount = mountSettings(ctx, {}, { env })
    await mount.legacyImport
    assert.equal(calls.length, 1)
  })
})

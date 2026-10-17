/**
 * 宿主半边单元测试（src/panel.js）：只读 `/apollo/api/capabilities` 路由、
 * loopback/同源安全边界、能力探针（PATH 解析 / 版本 / Codex profile 名 / 缓存）、
 * 以及 `declareOwnsHost` tap 的装配。
 *
 * 以 fake ctx 与假的探测依赖驱动；需要真实进程的地方（可执行文件、版本探测）
 * 用临时目录里的假脚本，不依赖本机装没装 codex/claude。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITIES_PATH,
  CAPABILITIES_PREFIX,
  CODEX_PROFILE_SUFFIX,
  collectCapabilities,
  createCapabilitiesReader,
  declareOwnsHostTap,
  installOwnsHostTap,
  listCodexProfiles,
  mountPanel,
  name,
  probeVersion,
  registerCapabilitiesRoute,
  resolveExecutable,
} from '../src/panel.js'

/** 造一个临时目录，结束后删除（支持异步回调）。 */
async function withTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'apollo-panel-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 写一个可执行的 shell 脚本（内容原样），返回其绝对路径。 */
function writeScript(dir, fileName, body) {
  const path = join(dir, fileName)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

/** 造 fake ctx：记录 webServer 注册的 effect 与路由，供测试直接调用 handler。 */
function makeWebCtx({ configEditor = undefined, routes = [], effects = [], logger } = {}) {
  const ctx = {
    effect: (factory, label) => { effects.push(label); return factory() },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: (service) => (service === 'configEditor' ? configEditor : undefined),
    logger,
  }
  return { ctx, routes, effects }
}

/** 从注册的 prefix 路由取出 handler（断言只注册一条且路径正确）。 */
function handlerOf(routes) {
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, CAPABILITIES_PREFIX)
  return routes[0].handler
}

/** 构造 fake req/res。 */
function makeReq({ url = CAPABILITIES_PATH, method = 'GET', host = '127.0.0.1:3080', headers = {}, body } = {}) {
  let iterated = false
  const req = {
    url,
    method,
    headers: { host, ...headers },
    [Symbol.asyncIterator]() {
      iterated = true
      const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
      return (async function* iterate() { yield* chunks })()
    },
  }
  const res = {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
    end(payload) { this.body = payload ?? '' },
  }
  return { req, res, bodyIterated: () => iterated }
}

const EMPTY_CAPABILITIES = {
  executables: {
    codex: { executable: 'codex', path: '/usr/local/bin/codex', version: 'codex-cli 1.2.3' },
    claude: { executable: 'claude', path: null, version: null },
  },
  codexProfiles: ['default', 'work'],
}

// ── 契约与 tap ─────────────────────────────────────────────────────────────

test('插件契约：name / 路径常量 / tap 导出', () => {
  assert.equal(name, 'apollo-panel')
  assert.equal(CAPABILITIES_PATH, '/apollo/api/capabilities')
  assert.equal(CAPABILITIES_PREFIX, '/apollo/api')
  assert.equal(CODEX_PROFILE_SUFFIX, '.config.toml')
  assert.equal(typeof declareOwnsHostTap, 'function')
  assert.equal(typeof mountPanel, 'function')
  assert.equal(typeof registerCapabilitiesRoute, 'function')
})

test('installOwnsHostTap：默认什么都不做，declareOwnsHost:true 才注入 tap', () => {
  const off = []
  installOwnsHostTap({ inject: (names) => off.push(names) }, { trustedHosts: ['dsh.example.com'] })
  assert.deepEqual(off, [])

  const taps = []
  const effects = []
  installOwnsHostTap({
    inject: (names, callback) => {
      callback({
        effect: (factory, label) => { effects.push(label); return factory() },
        webServer: { tapIndex: (tap) => { taps.push(tap); return () => {} } },
      })
    },
  }, { declareOwnsHost: true })
  assert.equal(taps.length, 1)
  assert.equal(taps[0]('<head></head>').includes('__DSH_TRANSPORT__'), true)
  assert.deepEqual(effects, ['apollo-panel: declareOwnsHost tap'])
})

test('installOwnsHostTap：同一插件上下文重复调用（mountPanel + mountSettings）只装一次', () => {
  const taps = []
  const ctx = {
    inject: (names, callback) => callback({
      effect: (factory) => factory(),
      webServer: { tapIndex: (tap) => { taps.push(tap); return () => {} } },
    }),
  }
  installOwnsHostTap(ctx, { declareOwnsHost: true })
  mountPanel(ctx, { declareOwnsHost: true })
  mountPanel(ctx, { 'declareOwnsHost': true })
  assert.equal(taps.length, 1)
})

test('mountPanel：不注册任何 HTTP 路由', () => {
  const routes = []
  mountPanel({
    inject: (names, callback) => callback({
      effect: (factory) => factory(),
      webServer: { register: (route) => { routes.push(route); return () => {} }, tapIndex: () => () => {} },
    }),
  }, { trustedHosts: ['dsh.example.com'], declareOwnsHost: true })
  assert.deepEqual(routes, [])
})

// ── 可执行文件解析 ──────────────────────────────────────────────────────────

test('resolveExecutable：从 PATH 解析裸名字，取第一个可执行文件', async () => {
  await withTemp((dir) => {
    const binA = join(dir, 'a')
    const binB = join(dir, 'b')
    mkdirSync(binA)
    mkdirSync(binB)
    const target = writeScript(binA, 'codex', '#!/bin/sh\nexit 0\n')
    writeFileSync(join(binB, 'codex'), '#!/bin/sh\nexit 0\n')
    assert.equal(resolveExecutable('codex', { env: { PATH: `${binA}:${binB}` }, home: dir }), target)
    assert.equal(resolveExecutable('missing', { env: { PATH: `${binA}:${binB}` }, home: dir }), null)
    assert.equal(resolveExecutable('', { env: { PATH: binA }, home: dir }), null)
    assert.equal(resolveExecutable(undefined, { env: { PATH: binA }, home: dir }), null)
    assert.equal(resolveExecutable('codex', { env: { PATH: '' }, home: dir }), null)
  })
})

test('resolveExecutable：非可执行文件不算（复制自 PATH 的普通文件）', async () => {
  await withTemp((dir) => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), 'not executable')
    assert.equal(resolveExecutable('codex', { env: { PATH: bin }, home: dir }), null)
  })
})

test('resolveExecutable：绝对路径、相对路径与 ~ 展开', async () => {
  await withTemp((dir) => {
    const absolute = writeScript(dir, 'claude', '#!/bin/sh\nexit 0\n')
    const homeBin = join(dir, 'home-bin')
    mkdirSync(homeBin)
    const inHome = writeScript(homeBin, 'codex', '#!/bin/sh\nexit 0\n')
    assert.equal(resolveExecutable(absolute, { env: {}, home: dir }), absolute)
    assert.equal(resolveExecutable('./claude', { env: {}, home: dir, cwd: dir }), absolute)
    assert.equal(resolveExecutable('~/home-bin/codex', { env: {}, home: dir }), inHome)
    assert.equal(resolveExecutable(join(dir, 'nope'), { env: {}, home: dir }), null)
    assert.equal(resolveExecutable('~/nope', { env: {}, home: dir }), null)
  })
})

// ── 版本探测 ────────────────────────────────────────────────────────────────

test('probeVersion：正常退出取第一行输出并截断/去控制字符', async () => {
  await withTemp(async (dir) => {
    const script = writeScript(dir, 'ok', '#!/bin/sh\nprintf "codex-cli 1.2.3\\nsecond line\\n"\n')
    assert.equal(await probeVersion(script), 'codex-cli 1.2.3')

    const noisy = writeScript(dir, 'noisy', '#!/bin/sh\nprintf "\\033[1mbanner\\033[0m\\n1.0.0\\n"\n')
    assert.equal(await probeVersion(noisy), '[1mbanner[0m')

    const long = writeScript(dir, 'long', `#!/bin/sh\nprintf "%0.sx" $(seq 1 400)\nprintf "\\n"\n`)
    assert.equal((await probeVersion(long)).length, 120)

    const stderrOnly = writeScript(dir, 'stderr', '#!/bin/sh\nprintf "1.4.0\\n" 1>&2\n')
    assert.equal(await probeVersion(stderrOnly), '1.4.0')

    const blank = writeScript(dir, 'blank', '#!/bin/sh\nexit 0\n')
    assert.equal(await probeVersion(blank), null)
  })
})

test('probeVersion：非零退出/不可执行/不存在都返回 null', async () => {
  await withTemp(async (dir) => {
    const failing = writeScript(dir, 'fail', '#!/bin/sh\necho "boom"\nexit 3\n')
    assert.equal(await probeVersion(failing), null)
    const plain = join(dir, 'plain')
    writeFileSync(plain, 'nope')
    assert.equal(await probeVersion(plain), null)
    assert.equal(await probeVersion(join(dir, 'does-not-exist')), null)
  })
})

test('probeVersion：超时即杀，返回 null', async () => {
  await withTemp(async (dir) => {
    const slow = writeScript(dir, 'slow', '#!/bin/sh\nsleep 5\necho late\n')
    const startedAt = Date.now()
    assert.equal(await probeVersion(slow, { timeoutMs: 120 }), null)
    assert.ok(Date.now() - startedAt < 4000)
  })
})

// ── Codex profile 名 ────────────────────────────────────────────────────────

test('listCodexProfiles：兼容 <name>.config.toml 与旧 [profiles.*]，只回名称', async () => {
  await withTemp((dir) => {
    const codexHome = join(dir, 'codex-home')
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, `work${CODEX_PROFILE_SUFFIX}`), 'model = "secret-model"\n')
    writeFileSync(join(codexHome, `zz${CODEX_PROFILE_SUFFIX}`), '')
    writeFileSync(join(codexHome, 'work.config.toml.bak'), '')
    mkdirSync(join(codexHome, `dir${CODEX_PROFILE_SUFFIX}`))
    writeFileSync(join(codexHome, 'bad name.config.toml'), '')
    writeFileSync(join(codexHome, '..config.toml'), '')
    writeFileSync(join(codexHome, 'config.toml'), [
      'model = "top-secret"',
      '',
      '[profiles.default]',
      'model = "secret-default"',
      '[profiles."quoted name"]',
      '[profiles.deep.work]',
      '[profiles.zz]',
      '[not-a-profile]',
      '[profilesX]',
    ].join('\n'))
    const names = listCodexProfiles({ env: { CODEX_HOME: codexHome }, home: dir })
    assert.deepEqual(names, ['deep.work', 'default', 'work', 'zz'])
    assert.ok(!JSON.stringify(names).includes('secret'))
    // 目录不存在：空列表而不是抛错
    assert.deepEqual(listCodexProfiles({ env: { CODEX_HOME: join(dir, 'nope') }, home: dir }), [])
    assert.deepEqual(listCodexProfiles({ env: {}, home: join(dir, 'no-home') }), [])
  })
})

// ── 能力采集 ────────────────────────────────────────────────────────────────

test('collectCapabilities：形状固定，探针失败各自降级', async () => {
  const deps = {
    env: { PATH: '/fake' },
    home: '/fake-home',
    resolveExecutable: (executable) => (executable === 'codex' ? '/fake/codex' : null),
    probeVersion: async () => 'codex-cli 9.9.9',
    listCodexProfiles: () => ['work'],
  }
  const value = await collectCapabilities({ subagents: { codex: { executable: 'codex' }, claude: { executable: 'claude' } } }, deps)
  assert.deepEqual(value, {
    executables: {
      codex: { executable: 'codex', path: '/fake/codex', version: 'codex-cli 9.9.9' },
      claude: { executable: 'claude', path: null, version: null },
    },
    codexProfiles: ['work'],
  })
  assert.deepEqual(Object.keys(value).sort(), ['codexProfiles', 'executables'])
  assert.deepEqual(Object.keys(value.executables.codex).sort(), ['executable', 'path', 'version'])

  let probed = 0
  const failing = await collectCapabilities({ subagents: { codex: { executable: 'codex' }, claude: { executable: 'claude' } } }, {
    ...deps,
    probeVersion: async () => { probed += 1; throw new Error('probe exploded') },
  })
  assert.equal(probed, 1)
  assert.equal(failing.executables.codex.version, null)
  assert.equal(failing.executables.codex.path, '/fake/codex')

  const broken = await collectCapabilities({}, {
    env: {},
    home: '/fake-home',
    resolveExecutable: () => { throw new Error('resolve exploded') },
    listCodexProfiles: () => { throw new Error('profiles exploded') },
  })
  assert.deepEqual(broken, {
    executables: {
      codex: { executable: 'codex', path: null, version: null },
      claude: { executable: 'claude', path: null, version: null },
    },
    codexProfiles: [],
  })
})

test('collectCapabilities：不返回配置正文或凭据（只有名字/路径/版本）', async () => {
  const secret = 'sk-do-not-leak'
  const value = await collectCapabilities({
    exitGuard: true,
    trustedHosts: [secret],
    declareOwnsHost: true,
    subagents: {
      codex: { enabled: true, executable: 'codex-word', profile: secret, permissionMode: 'danger-full-access', defaultModel: secret, models: [{ id: secret, efforts: ['low'], defaultEffort: 'low' }] },
      claude: { enabled: true, executable: 'claude-word' },
    },
  }, {
    env: { PATH: '/fake' },
    home: '/fake-home',
    resolveExecutable: () => null,
    probeVersion: async () => null,
    listCodexProfiles: () => ['work'],
  })
  const body = JSON.stringify(value)
  assert.ok(!body.includes(secret))
  assert.ok(!body.includes('danger-full-access'))
  // 只出现「配置里写的可执行文件名」——那正是本接口要报告的对象。
  assert.deepEqual(value.executables.codex.executable, 'codex-word')
  assert.deepEqual(value.executables.claude.executable, 'claude-word')
  assert.deepEqual(Object.keys(value).sort(), ['codexProfiles', 'executables'])
  assert.deepEqual(Object.keys(value.executables).sort(), ['claude', 'codex'])
})

test('createCapabilitiesReader：TTL 内复用、过期重探、并发去重、键变化失效', async () => {
  let probes = 0
  let clock = 0
  const deps = {
    env: { PATH: '/fake' },
    home: '/fake-home',
    now: () => clock,
    ttlMs: 1000,
    resolveExecutable: (executable) => (executable === 'claude' ? null : '/fake/' + executable),
    probeVersion: async () => { probes += 1; return 'v' + String(probes) },
    listCodexProfiles: () => [],
  }
  const read = createCapabilitiesReader(deps)
  const first = await read({ subagents: { codex: { executable: 'codex' } } })
  assert.equal(probes, 1)
  clock = 500
  assert.deepEqual(await read({ subagents: { codex: { executable: 'codex' } } }), first)
  assert.equal(probes, 1)
  clock = 1500
  await read({ subagents: { codex: { executable: 'codex' } } })
  assert.equal(probes, 2)

  clock = 10_000
  const [a, b] = await Promise.all([
    read({ subagents: { codex: { executable: 'codex' } } }),
    read({ subagents: { codex: { executable: 'codex' } } }),
  ])
  assert.deepEqual(a, b)
  assert.equal(probes, 3)

  clock = 20_000
  await read({ subagents: { codex: { executable: 'other' } } })
  assert.equal(probes, 4)
})

// ── 路由与安全边界 ──────────────────────────────────────────────────────────

test('GET：loopback 返回能力探针，只含契约字段', async () => {
  const { ctx, routes, effects } = makeWebCtx()
  registerCapabilitiesRoute(ctx, {}, { read: async () => EMPTY_CAPABILITIES })
  assert.deepEqual(effects, ['apollo-panel: /apollo/api capabilities route'])
  const { req, res } = makeReq()
  await handlerOf(routes)(req, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(res.body), { ok: true, value: EMPTY_CAPABILITIES })
})

test('GET：非 loopback 且未列入 trustedHosts → 403；列入则放行', async () => {
  const { ctx, routes } = makeWebCtx()
  registerCapabilitiesRoute(ctx, { trustedHosts: ['dsh.example.com'] }, { read: async () => EMPTY_CAPABILITIES })
  const handler = handlerOf(routes)

  const denied = makeReq({ host: 'evil.example.com' })
  await handler(denied.req, denied.res)
  assert.equal(denied.res.status, 403)
  assert.equal(JSON.parse(denied.res.body).ok, false)

  const allowed = makeReq({ host: 'dsh.example.com' })
  await handler(allowed.req, allowed.res)
  assert.equal(allowed.res.status, 200)

  const withPort = makeReq({ host: 'dsh.example.com:8443', headers: { host: 'dsh.example.com:8443' } })
  await handler(withPort.req, withPort.res)
  assert.equal(withPort.res.status, 403)
})

test('GET：localStorage 式 loopback 变体（localhost / [::1] / 127.0.0.0/8）放行，越界拒绝', async () => {
  const { ctx, routes } = makeWebCtx()
  registerCapabilitiesRoute(ctx, {}, { read: async () => EMPTY_CAPABILITIES })
  const handler = handlerOf(routes)
  for (const host of ['localhost:3080', '[::1]:3080', '127.0.0.1', '127.255.255.254:1']) {
    const { req, res } = makeReq({ host })
    await handler(req, res)
    assert.equal(res.status, 200, host)
  }
  for (const host of ['128.0.0.1', '127.0.0.256', 'not a host', '']) {
    const { req, res } = makeReq({ host })
    await handler(req, res)
    assert.equal(res.status, 403, host)
  }
  const missingHost = makeReq({ headers: { host: undefined } })
  delete missingHost.req.headers.host
  await handler(missingHost.req, missingHost.res)
  assert.equal(missingHost.res.status, 403)
})

test('GET：跨站标志 → 403；同源 Origin 放行，异源拒绝', async () => {
  const { ctx, routes } = makeWebCtx()
  registerCapabilitiesRoute(ctx, {}, { read: async () => EMPTY_CAPABILITIES })
  const handler = handlerOf(routes)

  const crossSite = makeReq({ headers: { 'sec-fetch-site': 'cross-site' } })
  await handler(crossSite.req, crossSite.res)
  assert.equal(crossSite.res.status, 403)

  const sameOrigin = makeReq({ headers: { origin: 'http://127.0.0.1:3080' } })
  await handler(sameOrigin.req, sameOrigin.res)
  assert.equal(sameOrigin.res.status, 200)

  const otherOrigin = makeReq({ headers: { origin: 'http://evil.example.com' } })
  await handler(otherOrigin.req, otherOrigin.res)
  assert.equal(otherOrigin.res.status, 403)

  const junkOrigin = makeReq({ headers: { origin: 'not a url' } })
  await handler(junkOrigin.req, junkOrigin.res)
  assert.equal(junkOrigin.res.status, 403)
})

test('路由只读：未知路径 404、非 GET 405 且从不读取请求体', async () => {
  const { ctx, routes } = makeWebCtx()
  registerCapabilitiesRoute(ctx, {}, { read: async () => EMPTY_CAPABILITIES })
  const handler = handlerOf(routes)

  const missing = makeReq({ url: '/apollo/api/other' })
  await handler(missing.req, missing.res)
  assert.equal(missing.res.status, 404)

  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
    const attempt = makeReq({ method, body: JSON.stringify({ exitGuard: true }) })
    await handler(attempt.req, attempt.res)
    assert.equal(attempt.res.status, 405, method)
    assert.equal(attempt.bodyIterated(), false, method)
  }

  const head = makeReq({ method: 'HEAD' })
  await handler(head.req, head.res)
  assert.equal(head.res.status, 405)
})

test('探针意外抛错 → 500 通用文案（细节只进日志，不回响应）', async () => {
  const warnings = []
  const { ctx, routes } = makeWebCtx({ logger: { warn: (message) => warnings.push(message) } })
  registerCapabilitiesRoute(ctx, {}, { read: async () => { throw new Error('secret detail sk-live-123') } })
  const { req, res } = makeReq()
  await handlerOf(routes)(req, res)
  assert.equal(res.status, 500)
  assert.equal(res.body.includes('sk-live-123'), false)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: { code: 'probe-failed', message: 'capability probe failed' } })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sk-live-123/)
})

test('信任边界按活配置读取：configEditor 的 trustedHosts 优先于挂载时配置', async () => {
  const live = {
    options: { id: 'apollo-skills' },
    fiber: { config: { trustedHosts: ['live.example.com'], exitGuard: false } },
  }
  const { ctx, routes } = makeWebCtx({ configEditor: { entries: () => [live] } })
  registerCapabilitiesRoute(ctx, { trustedHosts: ['mount.example.com'] }, { read: async () => EMPTY_CAPABILITIES })
  const handler = handlerOf(routes)

  const liveHost = makeReq({ host: 'live.example.com' })
  await handler(liveHost.req, liveHost.res)
  assert.equal(liveHost.res.status, 200)

  const mountHost = makeReq({ host: 'mount.example.com' })
  await handler(mountHost.req, mountHost.res)
  assert.equal(mountHost.res.status, 403)
})

test('registerCapabilitiesRoute：无 read 注入时使用真实探针（形状可断言）', async () => {
  const { ctx, routes } = makeWebCtx()
  registerCapabilitiesRoute(ctx, {}, {
    env: { PATH: '' },
    home: '/nonexistent-home',
    listCodexProfiles: () => [],
    probeVersion: async () => null,
    versionTimeoutMs: 50,
  })
  const { req, res } = makeReq()
  await handlerOf(routes)(req, res)
  assert.equal(res.status, 200)
  const value = JSON.parse(res.body).value
  assert.deepEqual(value.executables.codex, { executable: 'codex', path: null, version: null })
  assert.deepEqual(value.executables.claude, { executable: 'claude', path: null, version: null })
  assert.deepEqual(value.codexProfiles, [])
})

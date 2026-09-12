/**
 * 面板 host 半边单元测试（src/panel.js）：路由注册、loopback/同源安检、
 * eng.json 读写（含旧名回退与只写新名）、declareOwnsHost tap 装配。
 * 以 fake ctx 驱动，不启真实 HTTP 服务。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareOwnsHostTap, mountPanel, name } from '../src/panel.js'

/** 在临时 DSH_HOME 下运行，注入的文件先写好，结束后删除目录。 */
async function withHome(files, run) {
  const home = mkdtempSync(join(tmpdir(), 'eng-panel-'))
  for (const [fileName, content] of Object.entries(files ?? {})) {
    writeFileSync(join(home, fileName), content)
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** 构造 fake ctx：捕获注册的路由与 tap 效果，供测试直接调用 handler。 */
function makeCtx({ config } = {}) {
  const registered = []
  const taps = []
  const effects = []
  const ctx = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['webServer'])
      callback({
        effect: (factory, label) => { effects.push(label); factory() },
        webServer: {
          register: (route) => { registered.push(route) },
          tapIndex: (tap) => { taps.push(tap) },
        },
      })
    },
  }
  mountPanel(ctx, config)
  return { registered, taps, effects }
}

/** 从注册的 prefix 路由取出 handler（断言只注册一条且路径正确）。 */
function handlerOf(registered) {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/eng-panel/api')
  return registered[0].handler
}

/** 构造 fake req/res；body 为已序列化的 JSON 字符串。 */
function makeReq({ url = '/eng-panel/api/config', method = 'GET', host = '127.0.0.1:3080', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host, ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8')
    },
  }
  const res = {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders
    },
    end(payload) { this.body = payload ?? '' },
  }
  return { req, res }
}

test('插件契约：name 与 tap 导出', () => {
  assert.equal(name, 'eng-panel')
  assert.equal(typeof declareOwnsHostTap, 'function')
})

test('GET：受信 loopback 请求返回 eng.json 的值', async () => {
  await withHome({ 'eng.json': '{"exitGuard": false}' }, async () => {
    const { req, res } = makeReq()
    await handlerOf(makeCtx().registered)(req, res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, value: { exitGuard: false } })
  })
})

test('GET：旧名 atlas.json 被回退读取', async () => {
  await withHome({ 'atlas.json': '{"exitGuard": false}' }, async () => {
    const { req, res } = makeReq()
    await handlerOf(makeCtx().registered)(req, res)
    assert.deepEqual(JSON.parse(res.body), { ok: true, value: { exitGuard: false } })
  })
})

test('GET：非 loopback Host 且未列入 trustedHosts → 403', async () => {
  await withHome(undefined, async () => {
    const { req, res } = makeReq({ host: 'dsh.example.com' })
    await handlerOf(makeCtx().registered)(req, res)
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).ok, false)
  })
})

test('GET：trustedHosts 命中的反代权威放行', async () => {
  await withHome(undefined, async () => {
    const { req, res } = makeReq({ host: 'dsh.example.com' })
    await handlerOf(makeCtx({ config: { trustedHosts: ['dsh.example.com'] } }).registered)(req, res)
    assert.equal(res.status, 200)
  })
})

test('GET：跨站标志 → 403；同源 Origin 放行', async () => {
  await withHome(undefined, async () => {
    const crossSite = makeReq({ headers: { 'sec-fetch-site': 'cross-site' } })
    await handlerOf(makeCtx().registered)(crossSite.req, crossSite.res)
    assert.equal(crossSite.res.status, 403)

    const sameOrigin = makeReq({ headers: { origin: 'http://127.0.0.1:3080' } })
    await handlerOf(makeCtx().registered)(sameOrigin.req, sameOrigin.res)
    assert.equal(sameOrigin.res.status, 200)
  })
})

test('未知路径 404、未知方法 405', async () => {
  await withHome(undefined, async () => {
    const missing = makeReq({ url: '/eng-panel/api/other' })
    await handlerOf(makeCtx().registered)(missing.req, missing.res)
    assert.equal(missing.res.status, 404)

    const method = makeReq({ method: 'DELETE' })
    await handlerOf(makeCtx().registered)(method.req, method.res)
    assert.equal(method.res.status, 405)
  })
})

test('PUT：写入 eng.json，保留其他字段并清掉 exitGuardIgnore', async () => {
  await withHome({ 'eng.json': '{"exitGuard": true, "keep": "yes", "exitGuardIgnore": ["x"]}' }, async (home) => {
    const { req, res } = makeReq({ method: 'PUT', body: '{"exitGuard": false}' })
    await handlerOf(makeCtx().registered)(req, res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, value: { exitGuard: false } })
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'eng.json'), 'utf8')), { keep: 'yes', exitGuard: false })
  })
})

test('PUT：仅旧名存在时也写入 eng.json（首次保存即迁移）', async () => {
  await withHome({ 'atlas.json': '{"exitGuard": true}' }, async (home) => {
    const { req, res } = makeReq({ method: 'PUT', body: '{"exitGuard": false}' })
    await handlerOf(makeCtx().registered)(req, res)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'eng.json'), 'utf8')), { exitGuard: false })
  })
})

test('PUT：非布尔 exitGuard → 400 且不落盘', async () => {
  await withHome(undefined, async (home) => {
    const { req, res } = makeReq({ method: 'PUT', body: '{"exitGuard": "off"}' })
    await handlerOf(makeCtx().registered)(req, res)
    assert.equal(res.status, 400)
    assert.throws(() => readFileSync(join(home, 'eng.json'), 'utf8'))
  })
})

test('declareOwnsHost: true 才装配 tap，默认不装配', async () => {
  await withHome(undefined, async () => {
    const off = makeCtx()
    assert.equal(off.taps.length, 0)
    assert.deepEqual(off.effects, ['eng-panel: /eng-panel/api routes'])

    const on = makeCtx({ config: { declareOwnsHost: true } })
    assert.equal(on.taps.length, 1)
    assert.equal(on.taps[0]('<head></head>').includes('__DSH_TRANSPORT__'), true)
    assert.deepEqual(on.effects, ['eng-panel: /eng-panel/api routes', 'eng-panel: declareOwnsHost tap'])
  })
})

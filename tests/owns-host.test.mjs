/**
 * `src/owns-host.js` 单元测试：`declareOwnsHostTap` 的注入位置与
 * `installOwnsHostTap` 的开关/去重/零路由边界。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declareOwnsHostTap, installOwnsHostTap } from '../src/owns-host.js'

const SCRIPT = '<script>globalThis.__DSH_TRANSPORT__={ownsHost:true}</script>'

test('在 head 起始注入全局脚本，先于所有既有内容', () => {
  const html = '<!doctype html><html><head><script>window.__ModuleLoader__</script></head><body></body></html>'
  const out = declareOwnsHostTap(html)
  assert.equal(out, '<!doctype html><html><head>' + SCRIPT + '<script>window.__ModuleLoader__</script></head><body></body></html>')
})

test('无 head 的片段：前置注入', () => {
  const out = declareOwnsHostTap('<body></body>')
  assert.equal(out.startsWith(SCRIPT), true)
})

test('大小写与属性不影响的 head 匹配', () => {
  const html = '<HTML><HEAD data-x="1"></HEAD></HTML>'
  const out = declareOwnsHostTap(html)
  assert.equal(out.includes(SCRIPT), true)
  assert.equal(out.indexOf(SCRIPT), out.toLowerCase().indexOf('<head data-x="1">') + '<head data-x="1">'.length)
})

test('installOwnsHostTap：默认什么都不做，declareOwnsHost:true 才注入 tap', () => {
  const injected = []
  installOwnsHostTap({ inject: (names) => injected.push(names) }, { trustedHosts: ['dsh.example.com'] })
  assert.deepEqual(injected, [])

  const taps = []
  const effects = []
  installOwnsHostTap({
    inject: (names, callback) => {
      injected.push(names)
      callback({
        effect: (factory, label) => { effects.push(label); return factory() },
        webServer: { tapIndex: (tap) => { taps.push(tap); return () => {} } },
      })
    },
  }, { declareOwnsHost: true })
  assert.deepEqual(injected, [['webServer']])
  assert.equal(taps.length, 1)
  assert.equal(taps[0]('<head></head>').includes('__DSH_TRANSPORT__'), true)
  assert.deepEqual(effects, ['apollo: declareOwnsHost tap'])
})

test('installOwnsHostTap：同一插件上下文重复调用只装一次', () => {
  const taps = []
  const ctx = {
    inject: (names, callback) => callback({
      effect: (factory) => factory(),
      webServer: { tapIndex: (tap) => { taps.push(tap); return () => {} } },
    }),
  }
  installOwnsHostTap(ctx, { declareOwnsHost: true })
  installOwnsHostTap(ctx, { declareOwnsHost: true })
  assert.equal(taps.length, 1)
})

test('installOwnsHostTap：只 tapIndex，不注册任何 HTTP 路由', () => {
  const routes = []
  installOwnsHostTap({
    inject: (names, callback) => callback({
      effect: (factory) => factory(),
      webServer: {
        register: (route) => { routes.push(route); return () => {} },
        tapIndex: () => () => {},
      },
    }),
  }, { declareOwnsHost: true })
  assert.deepEqual(routes, [])
})

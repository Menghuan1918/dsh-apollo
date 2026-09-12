/**
 * declareOwnsHostTap 单元测试：注入位置与无 head 回退。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { declareOwnsHostTap } from '../src/panel.js'

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

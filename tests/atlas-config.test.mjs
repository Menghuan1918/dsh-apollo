/**
 * eng 运行时配置读取单元测试（presets/eng/plugins/lib/atlas-config.js）：
 * eng.json 正常读取、缺失/损坏回退、旧名 atlas.json 只读回退、DSH_HOME 注入、
 * 遗留 exitGuardIgnore 键被忽略。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engConfigPath, legacyConfigPath, readEngConfig } from '../presets/eng/plugins/lib/atlas-config.js'

/**
 * 在临时 DSH_HOME 下写入配置并运行断言。
 * @param files - 要写入的文件（`{ 'eng.json': '…', 'atlas.json': '…' }`），不写则不创建。
 * @param run - 断言回调，收到 `(env, home)`。
 */
function withHome(files, run) {
  const home = mkdtempSync(join(tmpdir(), 'eng-cfg-'))
  for (const [name, content] of Object.entries(files ?? {})) {
    writeFileSync(join(home, name), content)
  }
  const env = { DSH_HOME: home }
  try {
    run(env, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('文件缺失：返回默认（exitGuard 关闭）', () => {
  withHome(undefined, (env, home) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
    assert.equal(engConfigPath(env), join(home, 'eng.json'))
    assert.equal(legacyConfigPath(env), join(home, 'atlas.json'))
  })
})

test('正常读取布尔值（true / false）', () => {
  withHome({ 'eng.json': '{"exitGuard": false}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
  withHome({ 'eng.json': '{"exitGuard": true, "other": 1}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: true })
  })
})

test('旧名回退：只有 atlas.json 时仍生效', () => {
  withHome({ 'atlas.json': '{"exitGuard": false}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
})

test('eng.json 优先于 atlas.json', () => {
  withHome({ 'eng.json': '{"exitGuard": true}', 'atlas.json': '{"exitGuard": false}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: true })
  })
})

test('eng.json 损坏时回退旧文件（迁移期不丢开关）', () => {
  withHome({ 'eng.json': '{ not json !!!', 'atlas.json': '{"exitGuard": false}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
})

test('遗留 exitGuardIgnore 键被静默忽略（豁免机制已移除）', () => {
  withHome({ 'eng.json': '{"exitGuard": false, "exitGuardIgnore": ["dev server", "watch.sh"]}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
})

test('损坏 JSON：回退默认关闭', () => {
  withHome({ 'eng.json': '{ not json !!!' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
})

test('非对象顶层：回退默认关闭', () => {
  withHome({ 'eng.json': '[]' }, (env) => assert.deepEqual(readEngConfig(env), { exitGuard: false }))
  withHome({ 'eng.json': '"yes"' }, (env) => assert.deepEqual(readEngConfig(env), { exitGuard: false }))
  withHome({ 'eng.json': 'null' }, (env) => assert.deepEqual(readEngConfig(env), { exitGuard: false }))
})

test('exitGuard 非布尔：回退默认关闭', () => {
  withHome({ 'eng.json': '{"exitGuard": "off"}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
  withHome({ 'eng.json': '{"exitGuard": 0}' }, (env) => {
    assert.deepEqual(readEngConfig(env), { exitGuard: false })
  })
})

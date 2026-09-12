/**
 * apply 冒烟测试：以临时 DSH_HOME 调用宿主插件 apply，验证启动同步路径
 * （home 解析 → 预设树同步进 <home>/.agent-presets）端到端可用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { apply, bundledPresetsRoot, name } from '../src/index.js'
import { syncOnePreset } from '../src/preset-sync.js'

function treeFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out.sort()
}

test('插件导出契约：name / apply / bundledPresetsRoot', () => {
  assert.equal(name, 'apollo-skills')
  assert.equal(typeof apply, 'function')
  assert.equal(bundledPresetsRoot().endsWith('/presets/'), true)
})

test('apply：把捆绑预设同步进 DSH_HOME 的 .agent-presets', () => {
  const home = mkdtempSync(join(tmpdir(), 'eng-home-'))
  const logs = []
  process.env.DSH_HOME = home
  try {
    apply({ skills: { registerProvider: () => {} }, logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) } })
  } finally {
    delete process.env.DSH_HOME
  }

  const targetRoot = join(home, '.agent-presets', 'eng')
  const sourceRoot = bundledPresetsRoot()
  assert.equal(statSync(targetRoot).isDirectory(), true)
  // 同步结果与源树逐字节一致
  assert.equal(syncOnePreset(join(sourceRoot, 'eng'), targetRoot), 'current')
  assert.deepEqual(treeFiles(targetRoot), treeFiles(join(sourceRoot, 'eng')))
  assert.equal(readFileSync(join(targetRoot, 'preset.yml'), 'utf8').includes('工程模式'), true)
  assert.equal(logs.some((entry) => entry[0] === 'info'), true)
  rmSync(home, { recursive: true, force: true })
})

test('apply：幂等，重复挂载不报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'eng-home-'))
  process.env.DSH_HOME = home
  try {
    apply({ skills: { registerProvider: () => {} }, logger: console })
    apply({ skills: { registerProvider: () => {} }, logger: console })
  } finally {
    delete process.env.DSH_HOME
  }
  assert.equal(statSync(join(home, '.agent-presets', 'eng', 'agent.cordis.yml')).isFile(), true)
  rmSync(home, { recursive: true, force: true })
})

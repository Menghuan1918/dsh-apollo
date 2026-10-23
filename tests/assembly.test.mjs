/**
 * 顶层 bundle 装配解析：原生 goal 域禁用行、独立的 dsh-better-goal 稳定行，
 * 以及 Apollo 的运行时依赖声明。
 *
 * 为什么需要：dsh-better-goal 的 bundle patch 不会因为它是 Apollo 的依赖而
 * 自动应用（DSH 只把直接安装的 bundle 加入 `dsh.profile.bundles`），所以
 * Apollo 的 cordis.patch.yml 必须自己携带同样的禁用行和插入行，且 id/name
 * 逐字相同；两个 bundle 同时选中时 Loader 按行 id 去重，只挂载一次。这里只
 * 解析装配数据，不加载插件、不启动 Loader。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PATCH = join(ROOT, 'cordis.patch.yml')
const manifest = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patch = () => yaml.load(readFileSync(PATCH, 'utf8'))
/** Native goal rows the independent bundle disables; ids are compared in this order. */
const NATIVE_GOAL_IDS = [
  'command-goal',
  'goal',
  'goal-round-driver',
  'tool-goal',
  'ui-goal',
]
const GOAL_ROW = ['dsh-better-goal', 'dsh-better-goal']

const disabledIds = (patches) => patches
  .filter((entry) => entry.disabled === true)
  .map(({ id }) => id)
  .sort()
const insertedRows = (patches) => patches
  .flatMap((entry) => entry.insert ?? [])
  .map(({ id, name }) => [id, name])

test('顶层 patch 禁用原生 goal 域并插入稳定的 dsh-better-goal 行', () => {
  const patches = patch()
  assert.equal(Array.isArray(patches), true)
  assert.deepEqual(disabledIds(patches), [...NATIVE_GOAL_IDS].sort())
  for (const entry of patches) {
    if (entry.disabled !== true) continue
    assert.deepEqual(Object.keys(entry).sort(), ['disabled', 'id'], '禁用行必须只按 id 生效，不能带 name 或配置')
  }
  assert.deepEqual(insertedRows(patches), [GOAL_ROW, ['apollo-skills', 'dsh-apollo']], 'goal 行与 apollo-skills 都必须留在顶层 insert')
  for (const row of patches.flatMap((entry) => entry.insert ?? [])) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], '插入行不得带 config/group/disabled')
  }
})

test('package.json 将独立 goal 插件声明为运行时依赖', () => {
  const spec = manifest().dependencies?.['dsh-better-goal']
  assert.equal(typeof spec, 'string')
  assert.notEqual(spec.trim(), '')
})

function independentPackageDir() {
  try {
    return dirname(createRequire(join(ROOT, 'package.json')).resolve('dsh-better-goal/package.json'))
  } catch {
    return undefined
  }
}

test('已安装的独立 bundle 声明同一组禁用行与完全相同的 goal 行', (t) => {
  const dir = independentPackageDir()
  if (dir === undefined) return t.skip('dsh-better-goal 未安装（link 开发时需先在 Apollo 根目录安装依赖）')
  const independent = yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(disabledIds(independent), disabledIds(patch()), 'Apollo 与独立 bundle 的原生禁用行必须一致')
  assert.deepEqual(insertedRows(independent).filter(([id]) => id === 'dsh-better-goal'), [GOAL_ROW])
  assert.deepEqual(insertedRows(patch()).filter(([id]) => id === 'dsh-better-goal'), [GOAL_ROW])
})

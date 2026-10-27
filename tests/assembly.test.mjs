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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PATCH = join(ROOT, 'cordis.patch.yml')
const ENG = join(ROOT, 'presets/eng.patch.yml')
const PTC = join(ROOT, 'presets/eng-ptc.patch.yml')
const PACKAGE_NAME = '@menghuan1918/dsh-apollo'
const manifest = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patch = () => yaml.load(readFileSync(PATCH, 'utf8'))
// The presets carry `!!js` platform expressions; parse them as data, never evaluate.
const presetSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (source) => ({ javascript: source }),
}))
const preset = (file) => yaml.load(readFileSync(file, 'utf8'), { schema: presetSchema })
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
  assert.deepEqual(insertedRows(patches), [GOAL_ROW, ['apollo-skills', PACKAGE_NAME]], 'goal 行与本包 apollo-skills 行都必须留在顶层 insert')
  for (const row of patches.flatMap((entry) => entry.insert ?? [])) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], '插入行不得带 config/group/disabled')
  }
})

test('npm manifest：scoped 名、版本、repository、publishConfig 与 license', () => {
  const m = manifest()
  assert.equal(m.name, PACKAGE_NAME)
  assert.equal(m.version, '0.4.1')
  assert.equal(m.license, 'GPL-3.0-or-later')
  assert.deepEqual(m.repository, {
    type: 'git',
    url: 'git+https://github.com/Menghuan1918/dsh-apollo.git',
  })
  assert.deepEqual(m.publishConfig, {
    registry: 'https://registry.npmjs.org/',
    access: 'public',
  })
})

test('package.json 将独立 goal 插件声明为精确 npm 版本', () => {
  const spec = manifest().dependencies?.['dsh-better-goal']
  assert.equal(spec, '0.2.0', 'goal 依赖必须是精确 npm 版本，不能用 Git/file/link/range')
  assert.doesNotMatch(spec, /^(?:github:|git\+|git:|file:|link:|workspace:|npm:|https?:)/)
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

/** Every module name in the two presets (eng-ptc reuses eng's modules) that belongs to this scoped package. */
function scopedPresetReferences() {
  const names = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'name' && typeof child === 'string' && child.startsWith(`${PACKAGE_NAME}/`)) names.push(child)
      else visit(child)
    }
  }
  for (const file of [ENG, PTC]) visit(preset(file))
  return [...new Set(names)].sort()
}

test('scoped 安装布局：包根、client 与全部 preset 子路径真实解析', () => {
  const expected = [
    `${PACKAGE_NAME}/presets/eng/plugins/exit-guard/index.js`,
    `${PACKAGE_NAME}/presets/eng/plugins/mode-instructions/index.js`,
    `${PACKAGE_NAME}/presets/eng/plugins/wait-subagent/index.js`,
  ].sort()
  assert.deepEqual(scopedPresetReferences(), expected)

  // 复刻真实的 scoped node_modules 布局，让 Node 的 exports 解析器（DSH Loader
  // 也走同一解析器）验证 package.json 的 `./presets/*` 与 `./client` 映射。
  const dir = mkdtempSync(join(tmpdir(), 'apollo-scoped-'))
  try {
    const scope = join(dir, 'node_modules', '@menghuan1918')
    mkdirSync(scope, { recursive: true })
    symlinkSync(ROOT, join(scope, 'dsh-apollo'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(dir, 'package.json'), '{}\n')
    const require = createRequire(join(dir, 'package.json'))
    assert.equal(require.resolve(PACKAGE_NAME), join(ROOT, 'src/index.js'))
    assert.equal(require.resolve(`${PACKAGE_NAME}/client`), join(ROOT, 'src/client.js'))
    assert.equal(require.resolve(`${PACKAGE_NAME}/package.json`), join(ROOT, 'package.json'))
    for (const name of expected) assert.doesNotThrow(() => require.resolve(name), name)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

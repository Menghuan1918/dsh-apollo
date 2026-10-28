/**
 * 顶层 bundle 装配解析：原生 goal 域禁用行、独立 dsh-better-goal 稳定行、
 * dsh-better-compact companion/engine 行、dsh-better-subagent 行、原生
 * compaction-basic 停用，以及 Apollo 的精确运行时依赖声明。
 *
 * 为什么需要：独立插件的 bundle patch 不会因为它是 Apollo 的依赖而自动应用
 * （DSH 只把直接安装的 bundle 加入 `dsh.profile.bundles`），所以 Apollo 的
 * cordis.patch.yml 必须自己携带同样的禁停行和插入行，且 id/name 逐字相同；
 * 两个 bundle 同时选中时 Loader 按行 id 去重，只挂载一次。这里只解析装配
 * 数据，不加载插件、不启动 Loader。
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
const SUBAGENT_NAME = '@menghuan1918/dsh-better-subagent'
const COMPACT_NAME = 'dsh-better-compact'
const ENGINE_NAME = 'dsh-better-compact/engine'
const manifest = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const patch = () => yaml.load(readFileSync(PATCH, 'utf8'))
// The presets carry `!!js` platform expressions; parse them as data, never evaluate.
const presetSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (source) => ({ javascript: source }),
}))
const preset = (file) => yaml.load(readFileSync(file, 'utf8'), { schema: presetSchema })
const document = (file) => yaml.load(readFileSync(file, 'utf8'), { schema: presetSchema })

/** Native goal rows the independent goal bundle disables; ids are compared in this order. */
const NATIVE_GOAL_IDS = [
  'command-goal',
  'goal',
  'goal-round-driver',
  'tool-goal',
  'ui-goal',
]
const GOAL_ROW = ['dsh-better-goal', 'dsh-better-goal']
const COMPACT_ROW = [COMPACT_NAME, COMPACT_NAME]
const ENGINE_ROW = ['dsh-better-compact-engine', ENGINE_NAME]
const SUBAGENT_ROW = ['dsh-better-subagent', SUBAGENT_NAME]
const ASK_ROW = ['dsh-better-ask-user', 'dsh-better-ask-user']
const PTC_ROW = ['dsh-better-ptc', 'dsh-better-ptc']
const APOLLO_ROW = ['apollo-skills', PACKAGE_NAME]

const disabledIds = (patches) => patches
  .filter((entry) => entry.disabled === true)
  .map(({ id }) => id)
  .sort()
const insertedRows = (patches) => patches
  .flatMap((entry) => entry.insert ?? [])
  .map(({ id, name }) => [id, name])
const rowsOfPreset = (file) => preset(file)
  .flatMap((entry) => entry.insert ?? [])
  .find((row) => row.name === '@deepseek-ai/dsh-agent-preset')
  .config.plugins
const flatten = (rows) => rows.flatMap((row) => [row, ...(row.group === true ? flatten(row.config) : [])])
const installed = (specifier) => {
  try {
    const require = createRequire(join(ROOT, 'package.json'))
    return dirname(require.resolve(`${specifier}/package.json`))
  } catch {
    return undefined
  }
}
const bundleRows = (dir) => {
  const rows = document(join(dir, 'cordis.patch.yml'))
  return { disabled: disabledIds(rows), inserted: insertedRows(rows) }
}

test('顶层 patch 禁用原生 goal 域与原生 compaction-basic，并插入稳定的独立行', () => {
  const patches = patch()
  assert.equal(Array.isArray(patches), true)
  assert.deepEqual(disabledIds(patches), [...NATIVE_GOAL_IDS, 'compaction-basic', 'ui-user-questions'].sort())
  for (const entry of patches) {
    if (entry.disabled !== true) continue
    assert.deepEqual(Object.keys(entry).sort(), ['disabled', 'id'], '禁用行必须只按 id 生效，不能带 name 或配置')
  }
  assert.deepEqual(insertedRows(patches), [
    GOAL_ROW,
    COMPACT_ROW,
    ENGINE_ROW,
    SUBAGENT_ROW,
    PTC_ROW,
    ASK_ROW,
    APOLLO_ROW,
  ], 'goal / compact companion / compact engine / subagent / ptc / ask-user / apollo 行都必须留在顶层 insert')
  for (const row of patches.flatMap((entry) => entry.insert ?? [])) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], '插入行不得带 config/group/disabled')
  }
  const ids = insertedRows(patches).map(([id]) => id)
  for (const id of ['dsh-better-goal', 'dsh-better-compact', 'dsh-better-compact-engine', 'dsh-better-subagent', 'dsh-better-ptc', 'dsh-better-ask-user', 'apollo-skills']) {
    assert.equal(ids.filter((candidate) => candidate === id).length, 1, `${id} 只能有一个稳定行`)
  }
})

test('npm manifest：scoped 名、0.6.2、repository、publishConfig 与 license', () => {
  const m = manifest()
  assert.equal(m.name, PACKAGE_NAME)
  assert.equal(m.version, '0.6.2')
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

test('package.json 把五个独立插件声明为精确 npm 版本', () => {
  const dependencies = manifest().dependencies ?? {}
  assert.equal(dependencies['dsh-better-goal'], '0.2.1', 'goal 依赖必须是精确 npm 版本')
  assert.equal(dependencies[SUBAGENT_NAME], '0.2.0', 'better-subagent 依赖必须是精确 npm 版本')
  assert.equal(dependencies[COMPACT_NAME], '0.1.2', 'better-compact 依赖必须是精确 npm 版本')
  assert.equal(dependencies['dsh-better-ask-user'], '0.1.4', 'ask-user 依赖必须是精确 npm 版本')
  assert.equal(dependencies['dsh-better-ptc'], '0.1.0', 'ptc 依赖必须是精确 npm 版本')
  for (const spec of [dependencies['dsh-better-goal'], dependencies[SUBAGENT_NAME], dependencies[COMPACT_NAME], dependencies['dsh-better-ask-user'], dependencies['dsh-better-ptc']]) {
    assert.doesNotMatch(spec, /^(?:github:|git\+|git:|file:|link:|workspace:|npm:|https?:)/)
  }
})

test('已安装的独立 bundle 声明同一组稳定行：goal、compact、subagent、ptc、ask-user', (t) => {
  const goal = installed('dsh-better-goal')
  const subagent = installed(SUBAGENT_NAME)
  const compact = installed(COMPACT_NAME)
  if (goal === undefined || subagent === undefined || compact === undefined) {
    return t.skip('独立插件未安装（link 开发时需先安装依赖）')
  }
  const apollo = bundleRows(ROOT)
  const goalRows = bundleRows(goal)
  assert.deepEqual(goalRows.disabled, [...NATIVE_GOAL_IDS].sort(), 'Apollo 与 goal bundle 的原生 goal 禁用行必须一致')
  assert.deepEqual(goalRows.inserted, [GOAL_ROW])
  assert.deepEqual(apollo.inserted.filter(([id]) => id === 'dsh-better-goal'), [GOAL_ROW])

  const compactRows = bundleRows(compact)
  assert.deepEqual(compactRows.disabled, ['compaction-basic'], 'compact bundle 只停用原生 host-plane 压缩行')
  assert.deepEqual(compactRows.inserted, [COMPACT_ROW, ENGINE_ROW])
  assert.deepEqual(apollo.inserted.filter(([id]) => id === COMPACT_NAME || id === 'dsh-better-compact-engine'), compactRows.inserted)

  const subagentRows = bundleRows(subagent)
  assert.deepEqual(apollo.inserted.filter(([id]) => id === 'dsh-better-subagent'), [SUBAGENT_ROW])
  if (subagentRows.inserted.some(([id]) => id === 'dsh-better-ptc')) {
    assert.deepEqual(subagentRows.inserted, [PTC_ROW, SUBAGENT_ROW])
    assert.deepEqual(apollo.inserted.filter(([id]) => id === 'dsh-better-ptc'), [PTC_ROW])
  }
})

test('Apollo 预设与独立 compact 预设引用同一个 engine 稳定行', (t) => {
  const compact = installed(COMPACT_NAME)
  if (compact === undefined) return t.skip('dsh-better-compact 未安装')
  const standalone = flatten(rowsOfPreset(join(compact, 'presets/better-compact.patch.yml')))
    .find((row) => row.id === 'dsh-better-compact-engine')
  assert.deepEqual([standalone.id, standalone.name], ENGINE_ROW)
  for (const file of [ENG, PTC]) {
    const engine = flatten(rowsOfPreset(file)).find((row) => row.id === 'dsh-better-compact-engine')
    assert.deepEqual([engine.id, engine.name], [standalone.id, standalone.name], `${file} 的 engine 行必须与独立预设一致`)
    const group = rowsOfPreset(file).find((row) => row.id === 'compaction')
    assert.ok(group?.group === true && group.isolate?.compaction === true, 'engine 必须位于预设自己的 compaction 隔离域')
    assert.equal(flatten(group.config).some((row) => row.id === 'compaction-basic'), false, '预设内不能再保留原生 compaction-basic')
  }
})

test('预设不携带第二份 subagent registry / wait 工具，也不引用迁移后的实现', () => {
  for (const file of [ENG, PTC]) {
    const rows = flatten(rowsOfPreset(file))
    assert.equal(rows.some((row) => row.id === 'tool-wait-subagent'), false, 'wait_subagent 由 dsh-better-subagent 的宿主行提供')
    assert.equal(rows.some((row) => row.id === 'dsh-better-subagent'), false, 'subagent 宿主行在顶层 patch，不应复制进预设')
    assert.equal(rows.some((row) => row.name === 'dsh-better-compact'), false, 'compact companion 行在顶层 patch，预设只带 engine')
    assert.equal(rows.some((row) => row.id === 'compaction-basic'), false, '预设内不能保留原生 compaction 引擎')
    assert.equal(rows.filter((row) => row.id === 'tool-subagent').length, 1, '原生 subagent 工具仍由预设提供且只有一份')
  }
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

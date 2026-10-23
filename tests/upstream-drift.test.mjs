/** Strict preset comparison against an installed, supported DSH release. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENG = join(ROOT, 'presets/eng.patch.yml')
const NOASK = join(ROOT, 'presets/eng-noask.patch.yml')
const ownRows = [
  ['tool-wait-subagent', '@menghuan1918/dsh-apollo/presets/eng/plugins/wait-subagent/index.js'],
  ['eng-exit-guard', '@menghuan1918/dsh-apollo/presets/eng/plugins/exit-guard/index.js'],
  ['eng-mode-instructions', '@menghuan1918/dsh-apollo/presets/eng/plugins/mode-instructions/index.js'],
]
const thresholds = { thresholdChars: [16384, 8192], headChars: [8192, 4096], tailChars: [2048, 1024] }
// Deliberate removals from the upstream standard preset. The real-preset test
// asserts each still exists upstream before filtering it out, so a renamed or
// dropped upstream row cannot silently pass. command-goal/tool-goal are now
// owned by the independent dsh-better-goal plugin, not by these presets.
const droppedRows = [
  ['tool-schedule', '@deepseek-ai/dsh-tool-schedule'],
  ['command-goal', '@deepseek-ai/dsh-command-goal'],
  ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
]
const isDropped = (row) => droppedRows.some(([id, name]) => row.id === id && row.name === name)
// Compare platform expressions as data. This test never evaluates !!js.
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (source) => ({ javascript: source }),
}))
const document = (file) => yaml.load(readFileSync(file, 'utf8'), { schema })
const manifest = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const declaration = (file) => document(file).flatMap((patch) => patch.insert ?? []).find((row) => row.name === '@deepseek-ai/dsh-agent-preset')
const rowsOf = (file) => declaration(file).config.plugins
const flatten = (rows) => rows.flatMap((row) => [row, ...(row.group === true ? flatten(row.config) : [])])
const identities = (rows) => flatten(rows).filter((row) => row.id).map((row) => [row.id, row.name])

function dshPackageRoot() {
  const override = process.env.DSH_PACKAGE_ROOT
  if (override !== undefined) {
    assert.ok(existsSync(join(override, 'package.json')), 'DSH_PACKAGE_ROOT 必须指向实际 DSH 包目录')
    assert.equal(JSON.parse(readFileSync(join(override, 'package.json'), 'utf8')).name, '@deepseek-ai/dsh', 'DSH_PACKAGE_ROOT 必须指向 @deepseek-ai/dsh 包')
    return override
  }
  const relative = join('@deepseek-ai', 'dsh', 'package.json')
  let dir = dirname(process.execPath)
  for (let depth = 0; depth < 6; depth += 1) {
    for (const prefix of [['node_modules'], ['lib', 'node_modules']]) {
      const candidate = join(dir, ...prefix, relative)
      if (existsSync(candidate)) return dirname(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try { return dirname(createRequire(process.execPath).resolve('@deepseek-ai/dsh/package.json')) } catch { return undefined }
}

function dshLayout(t) {
  const root = dshPackageRoot()
  const required = process.env.DSH_PACKAGE_ROOT !== undefined
  if (root) {
    const require = createRequire(join(root, 'package.json'))
    let patch
    let semver
    try {
      patch = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets/standard.patch.yml')
      semver = require('semver')
    } catch (error) {
      if (required) throw new Error('指定的 DSH 安装缺少验证依赖', { cause: error })
    }
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    const compatible = semver?.satisfies(version, manifest().engines.dsh)
    if (required) {
      assert.ok(compatible, `指定的 DSH ${version} 不满足 ${manifest().engines.dsh}`)
      assert.ok(patch && existsSync(patch), '指定的 DSH 安装缺少 standard.patch.yml 基准')
    }
    if (compatible && patch && existsSync(patch)) return { root, patch, require, semver, version }
  }
  t.skip('未发现满足 engines.dsh 的本机 DSH 安装；显式设置 DSH_PACKAGE_ROOT 可启用验证')
}

/** Remove the documented Apollo additions, deliberate removals, and exact tuning values. */
function normalizedEng(rows) {
  const normalized = structuredClone(rows).filter((row) => !isDropped(row) && !ownRows.some(([id, name]) => row.id === id && row.name === name))
  for (const row of flatten(normalized)) {
    if (row.id === 'tool-jobs' && Object.hasOwn(row.config ?? {}, 'maxConsecutiveWakes')) {
      assert.equal(row.config.maxConsecutiveWakes, 5000)
      delete row.config.maxConsecutiveWakes
      if (Object.keys(row.config).length === 0) delete row.config
    }
    if (row.id === 'tool-result-pruner') {
      for (const [key, [eng, standard]] of Object.entries(thresholds)) {
        assert.equal(row.config[key], eng, `eng 的 ${key} 必须保留有意调参`)
        row.config[key] = standard
      }
    }
  }
  return normalized
}

function assertStandard(eng, standard) {
  const upstream = structuredClone(standard).filter((row) => !isDropped(row))
  assert.deepEqual(normalizedEng(eng), upstream, '预设存在白名单外差异（含嵌套配置、scope、disabled 和行序）')
}

test('两份预设 patch 结构合法：身份稳定、bundle 引用唯一、无第二份行清单', () => {
  for (const [file, id, order] of [[ENG, 'eng', 10], [NOASK, 'eng-noask', 11]]) {
    const patches = document(file)
    assert.equal(patches.length, 1)
    assert.equal(patches[0].insert.length, 1)
    const preset = declaration(file)
    assert.equal(preset.config.id, id)
    assert.equal(preset.config.order, order)
    assert.ok(Array.isArray(preset.config.plugins) && preset.config.plugins.length)
    for (const legacy of ['agent.cordis.yml', 'preset.yml']) assert.equal(existsSync(join(ROOT, 'presets', id, legacy)), false)
  }
  assert.deepEqual(manifest().dsh.bundle.patch, ['./cordis.patch.yml', './presets/eng.patch.yml', './presets/eng-noask.patch.yml'])
})

test('eng 预设与上游 standard 完整对齐，差异只有声明的加法、剔除与调参', (t) => {
  const layout = dshLayout(t)
  if (!layout) return
  const eng = rowsOf(ENG)
  const standard = rowsOf(layout.patch)
  const upstream = identities(standard)
  for (const [id, name] of droppedRows) {
    assert.ok(upstream.some(([rowId, rowName]) => rowId === id && rowName === name), `剔除行必须仍存在于上游 standard：${id}`)
  }
  assert.deepEqual(identities(eng).filter(([id]) => !upstream.some(([reference]) => reference === id)), ownRows)
  assertStandard(eng, standard)
})

test('配置比较拒绝额外嵌套键和伪装成 pruner 调参的其他行', () => {
  const standard = [{ id: 'tool-jobs', name: 'jobs' }]
  const eng = [{ id: 'tool-jobs', name: 'jobs', config: { maxConsecutiveWakes: 5000 } }]
  assertStandard(eng, standard)
  assert.throws(() => assertStandard([{ ...eng[0], config: { ...eng[0].config, unexpected: true } }], standard), /白名单外差异/)
  assert.throws(() => assertStandard([{ id: 'other', config: { thresholdChars: 16384 } }], [{ id: 'other', config: { thresholdChars: 8192 } }]), /白名单外差异/)
  assert.throws(() => assertStandard([{ ...standard[0], disabled: true }], standard), /白名单外差异/)
})

test('原生 goal 行仍存在于基准安装的 host 组成中', (t) => {
  const layout = dshLayout(t)
  if (!layout) return
  const hostRows = (packageName) => {
    const dir = dirname(layout.require.resolve(`${packageName}/package.json`))
    return identities(document(join(dir, 'cordis.patch.yml')).flatMap((patch) => patch.insert ?? []))
  }
  const base = hostRows('@deepseek-ai/dsh-base')
  const web = hostRows('@deepseek-ai/dsh-web-app')
  for (const [id, name] of [
    ['goal', '@deepseek-ai/dsh-goal'],
    ['goal-round-driver', '@deepseek-ai/dsh-goal-round-driver'],
    ['command-goal', '@deepseek-ai/dsh-command-goal'],
    ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
  ]) {
    assert.ok(base.some(([rowId, rowName]) => rowId === id && rowName === name), `基准安装的 dsh-base 必须仍有原生行：${id}`)
  }
  assert.ok(web.some(([rowId, rowName]) => rowId === 'ui-goal' && rowName === '@deepseek-ai/dsh-client-ui-goal'), '基准安装的 dsh-web-app 必须仍有原生行：ui-goal')
})

test('eng-noask 恰为 eng 删除 ask 工具并改写提问纪律', () => {
  const eng = rowsOf(ENG)
  const noask = structuredClone(rowsOf(NOASK))
  const asEngPath = (value) => value.replace('@menghuan1918/dsh-apollo/presets/eng-noask/', '@menghuan1918/dsh-apollo/presets/eng/')
  for (const row of flatten(noask)) {
    if (row.name) row.name = asEngPath(row.name)
    if (row.id === 'plan-mode') {
      assert.equal(row.config.section.includes('ask_user_question'), false)
      row.config.section = flatten(eng).find((item) => item.id === 'plan-mode').config.section
    }
  }
  assert.deepEqual(noask, eng.filter((row) => row.id !== 'tool-ask-user'))
})

test('两份 patch 的完整模块导出子路径在目标 DSH 安装中均可解析', (t) => {
  const layout = dshLayout(t)
  if (!layout) return
  for (const file of [ENG, NOASK]) {
    const names = [declaration(file).name, ...flatten(rowsOf(file)).map((row) => row.name).filter((name) => name?.startsWith('@deepseek-ai/'))]
    assert.ok(names.includes('@deepseek-ai/dsh-agent-preset') && names.includes('@deepseek-ai/dsh-tool-subagent'))
    for (const name of names) assert.doesNotThrow(() => layout.require.resolve(name), `${name} 不可解析`)
  }
})

test('engines.dsh 覆盖新 RC 与正式版，拒绝旧接口及相邻主版本', (t) => {
  const layout = dshLayout(t)
  if (!layout) return
  const range = manifest().engines.dsh
  assert.equal(layout.semver.satisfies(layout.version, range), true)
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2']) assert.equal(layout.semver.satisfies(version, range), true, version)
  for (const version of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.5', '0.2.1-rc.1', '0.3.0']) assert.equal(layout.semver.satisfies(version, range), false, version)
})

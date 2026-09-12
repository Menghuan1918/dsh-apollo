/**
 * 上游漂移自检：eng 预设是内置 `standard` 预设的整棵 fork，DSH 升级后上游新增
 * 的行不会自动传过来（2026-09-12 已因此漏掉 `@deepseek-ai/dsh-tool-present`）。
 *
 * 两类检查：
 * 1. **漂移**：eng 与上游 standard 去掉注释/空行后只允许有白名单内的差异；出现
 *    白名单外的差异（尤其是上游有 eng 没有的行）即失败，提示把哪一行带过来。
 * 2. **两份副本一致**：`node --test` 会把包内 `presets/eng/` 同步进
 *    `<dshHome>/.agent-presets/eng`（与 dsh 启动时的 sync-on-boot 同一个函数），
 *    改完源树不跑测试直接重启，跑的就是旧副本——这里直接堵掉。
 *
 * 上游文件不存在（非 npm 布局、DSH 未安装）时跳过，不让本包在没有 harness 的
 * 环境里失败。
 * 运行：node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, syncPresetTrees } from '../src/preset-sync.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENG_PRESET = join(PACKAGE_ROOT, 'presets', 'eng')

/**
 * 本包相对上游 standard 的有意差异。eng 只做加法与一处调参：
 * - 三个预设本地插件行（eng 独有）；
 * - tool-result-pruner 的阈值放大到 2 倍，上游值由下方 pruner 常量描述。
 */
const EXTRA_ENG_ROWS = [
  "tool-wait-subagent -> ./plugins/wait-subagent/index.js",
  "eng-exit-guard -> ./plugins/exit-guard/index.js",
  "eng-mode-instructions -> ./plugins/mode-instructions/index.js",
]

/** tool-result-pruner 有意放大的阈值：eng 值 → 上游值（预设内注释说明了原因）。 */
const PRUNER_OVERRIDES = new Map([
  ['16384', '8192'],
  ['8192', '4096'],
  ['2048', '1024'],
])

/**
 * 解析本机 DSH 安装根。优先 `DSH_PACKAGE_ROOT`（指向 dsh 包目录，便于异机排查），
 * 其次沿 node 可执行文件向上找全局安装目录（`node_modules` 与 `lib/node_modules`，
 * 覆盖 nvm 与系统级 npm 两种布局），最后退回 node 自带的解析器；找不到返回
 * undefined，调用方跳过检查——本包在没有 harness 的环境里不该失败。
 */
function dshPackageRoot() {
  const override = process.env.DSH_PACKAGE_ROOT
  if (override !== undefined && existsSync(join(override, 'package.json'))) return override
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
  try {
    return dirname(createRequire(process.execPath).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    return undefined
  }
}

/**
 * 顶层行序列：去掉注释与空行，再把 `- id:` 列表项与紧随其后的 `name:` 折成
 * `id -> name` 一项。折叠断言比逐行断言更严——行序错位或缺配置项都会暴露，
 * 同时允许上游新增行被显式看见。缩进与引号差异被抹平：两者都不改变解析结果。
 */
function topLevelEntries(file) {
  const entries = []
  const rows = normalizedRows(file)
  for (let i = 0; i < rows.length; i += 1) {
    const idMatch = /^- id:[ \t]*(.+)$/.exec(rows[i])
    if (idMatch === null) continue
    const id = idMatch[1].trim()
    const next = rows[i + 1] ?? ''
    entries.push(next.startsWith('name:') ? `${id} -> ${unquote(next.slice('name:'.length).trim())}` : id)
  }
  return entries
}

/**
 * 每个顶层行的 `config:` 子树（id 行自身与 `name:` 行除外），键 → 值。
 * 供逐行比对配置漂移；行原文不再直接比较，避免把行距与缩进当成差异。
 */
function configOfRows(file) {
  const configs = new Map()
  let current
  let nested = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idMatch = /^- id:[ \t]*(.+)$/.exec(line)
    if (idMatch !== null) {
      current = idMatch[1].trim()
      configs.set(current, new Map())
      nested = false
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('name:')) continue
    const keyValue = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (keyValue !== null) {
      // 嵌套键（group/isolate 下的行）归到其父键，不单独成为一项。
      nested = /^[A-Za-z0-9_-]+:$/.test(line)
      const key = nested ? `${keyValue[1]}.*` : keyValue[1]
      configs.get(current).set(key, nested ? '' : keyValue[2])
      continue
    }
    if (nested) {
      const [key] = [...configs.get(current).keys()].slice(-1)
      configs.get(current).set(key, `${configs.get(current).get(key)} ${line}`.trim())
    }
  }
  return configs
}

/** 抹平 YAML 引号差异（`'x'` 与 `x` 解析为同一值）。 */
function unquote(value) {
  return value.replace(/^'(.*)'$/, '$1')
}

/** 去掉注释与空行，并抹平缩进——只留「有哪些行」。 */
function normalizedRows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** 上游 standard 预设文件；本机没有 DSH 安装时返回 undefined（跳过检查）。 */
function upstreamPresetFile() {
  const root = dshPackageRoot()
  if (root === undefined) return undefined
  const file = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  return existsSync(file) ? file : undefined
}

test('eng 预设的行与上游 standard 对齐，差异只有白名单', (t) => {
  const upstreamFile = upstreamPresetFile()
  if (upstreamFile === undefined) {
    t.skip('本机没有 DSH 内置 standard 预设，跳过漂移检查')
    return
  }
  const engFile = join(ENG_PRESET, 'agent.cordis.yml')
  const upstream = topLevelEntries(upstreamFile)
  const eng = topLevelEntries(engFile)

  // 顺序敏感：行序错位与新增/缺失行都在这里暴露。上游有、eng 没有 = 漏抄，
  // 漏抄就是静默少一个能力，必须补进 presets/eng/agent.cordis.yml。
  const extra = eng.filter((entry) => !upstream.includes(entry))
  const missing = upstream.filter((entry) => !eng.includes(entry))
  assert.deepEqual(missing, [], `eng 缺少上游行，请补进 presets/eng/agent.cordis.yml：\n${missing.join('\n')}`)
  assert.deepEqual(extra, EXTRA_ENG_ROWS, 'eng 相对上游出现了白名单外的行')

  // 嵌套 config 里有意的调参：eng 值只允许映射到声明的上游值。
  const upstreamConfigs = configOfRows(upstreamFile)
  for (const [id, config] of configOfRows(engFile)) {
    const reference = upstreamConfigs.get(id)
    if (reference === undefined) {
      assert.equal(EXTRA_ENG_ROWS.some((entry) => entry.startsWith(`${id} ->`)), true, `eng 多出的行 ${id} 不在白名单`)
      continue
    }
    for (const [key, value] of config) {
      const upstreamValue = reference.get(key)
      if (upstreamValue === value) continue
      const declared = PRUNER_OVERRIDES.get(value)
      assert.equal(declared, upstreamValue,
        `${id}.${key} 与上游不同且未声明：eng=${value} upstream=${upstreamValue}`)
    }
  }
})

test('eng 预设引用的每个模块都能在 DSH 里解析到', (t) => {
  const root = dshPackageRoot()
  if (root === undefined) {
    t.skip('本机没有 DSH 安装，跳过模块解析检查')
    return
  }
  const specifiers = normalizedRows(join(ENG_PRESET, 'agent.cordis.yml'))
    .filter((row) => row.startsWith('name:'))
    .map((row) => row.slice('name:'.length).trim().replace(/^'(.*)'$/, '$1'))
  const bare = specifiers.filter((name) => name.startsWith('@deepseek-ai/'))
  assert.equal(bare.length > 20, true, '应解析出全部上游行名')

  const moduleRoot = join(root, 'node_modules')
  const unresolved = bare.filter((name) => {
    const [scope, pkg] = name.split('/')
    // 子路径行（如 `.../list-agents`）只要包在即可，具体子路径由 loader 解析。
    return !existsSync(join(moduleRoot, scope, pkg))
  })
  assert.deepEqual(unresolved, [], `eng 引用了本机 DSH 解析不到的模块：\n${unresolved.join('\n')}`)
})

test('包内 eng 源树与 <dshHome>/.agent-presets/eng 副本一致（顺带刷新副本）', () => {
  const targetRoot = join(dshHome(), '.agent-presets')
  const result = syncPresetTrees(join(PACKAGE_ROOT, 'presets'), targetRoot)
  assert.deepEqual(result.failed, [], `同步失败：${JSON.stringify(result.failed)}`)

  // 同步后逐文件比对：源树 ⊆ 副本且内容一致。
  const sourceRoot = ENG_PRESET
  const copyRoot = join(targetRoot, 'eng')
  const files = walk(sourceRoot, copyRoot)
  // 健全性检查：树被清空或走错目录时上面的逐文件断言会「零次通过」。
  assert.equal(files.includes('agent.cordis.yml'), true, `源树里没有 agent.cordis.yml：${files.join(', ')}`)
  assert.equal(files.length >= 10, true, `eng 源树文件数异常偏少：${files.length}`)
})

/** 递归比对源树与副本，返回源树里的相对路径列表。 */
function walk(dir, copyRoot, base = dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path, copyRoot, base)
    const rel = path.slice(base.length + 1)
    const copy = join(copyRoot, rel)
    assert.equal(existsSync(copy), true, `副本缺少 ${rel}（跑 node --test 即会刷新）`)
    assert.equal(readFileSync(path, 'utf8'), readFileSync(copy, 'utf8'), `副本与源树不一致：${rel}`)
    return [rel]
  })
}

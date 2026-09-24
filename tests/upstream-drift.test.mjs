/**
 * 上游漂移自检：eng 预设是内置 `standard` 预设的整棵 fork，DSH 升级后上游新增
 * 的行不会自动传过来（2026-09-12 已因此漏掉 `@deepseek-ai/dsh-tool-present`）。
 *
 * 0.1.7 起预设机制换代：本包预设以 bundle patch 里的
 * `@deepseek-ai/dsh-agent-preset` insert 行交付（presets/eng.patch.yml、
 * presets/eng-noask.patch.yml），上游基准随之变为已安装 DSH 的
 * `dsh-web-app/presets/standard.patch.yml` 里 `preset-standard` 的
 * `config.plugins` 行集。旧基准（`dsh-agent-presets` 复数包的
 * presets/standard/agent.cordis.yml）在 0.1.7 不存在——旧实现曾因此静默
 * skip，这正是本文件要拦住的失效方式。
 *
 * 检查：
 * 1. **patch 结构**：每份 patch 恰一个 insert、`config.id` 为 eng/eng-noask
 *    （历史会话按它恢复，绝不可改名）；package.json 的 `dsh.bundle.patch`
 *    是引用两份 patch 的数组；源树里不允许再出现第二份行清单
 *    （agent.cordis.yml / preset.yml 必须不存在——单一事实源）。
 * 2. **漂移**：eng 与上游 standard 的 config.plugins 行集只允许白名单内差异
 *    （上游有而 eng 没有 ⇒ 直接失败并列出该补哪一行）；逐 key 配置比对是
 *    双向的——eng 有而上游没有的 key、上游有而 eng 没有的 key 都必须落在
 *    显式白名单，旧实现「undefined === undefined」式的静默通过不再可能。
 *    eng-noask（工程模式(无提问)）单独对齐 eng：唯一允许差异是剔除的
 *    tool-ask-user 行与 plan-mode section 的有意改写。
 * 3. **模块解析**：patch 文件里每个 `@deepseek-ai/*` 行名（含 insert 行自身的
 *    dsh-agent-preset）都能在本机 DSH 安装里解析到；子路径行只要父包在。
 *
 * 上游文件不存在（非 npm 布局、DSH 未安装、或本机装的是没有 patch 基准的
 * 0.1.6-）时跳过，不让本包在没有对应 harness 的环境里失败。
 * 运行：node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENG_PATCH = join(PACKAGE_ROOT, 'presets', 'eng.patch.yml')
const NOASK_PATCH = join(PACKAGE_ROOT, 'presets', 'eng-noask.patch.yml')

/** eng-noask 相对 eng 唯一允许的行差异：整行剔除的 ask 工具行。 */
const NOASK_REMOVED_ROW = 'tool-ask-user -> @deepseek-ai/dsh-tool-ask-user'

/**
 * eng 相对上游 standard 的有意差异。eng 只做加法与调参：
 * - 三个预设本地插件行（eng 独有，裸子路径指向本包，profile node_modules 解析）。
 */
const EXTRA_ENG_ROWS = [
  'tool-wait-subagent -> dsh-apollo/presets/eng/plugins/wait-subagent/index.js',
  'eng-exit-guard -> dsh-apollo/presets/eng/plugins/exit-guard/index.js',
  'eng-mode-instructions -> dsh-apollo/presets/eng/plugins/mode-instructions/index.js',
]

/** tool-result-pruner 有意放大的阈值：eng 值 → 上游值（预设内注释说明了原因）。 */
const PRUNER_OVERRIDES = new Map([
  ['16384', '8192'],
  ['8192', '4096'],
  ['2048', '1024'],
])

/**
 * eng 有、上游没有的配置键（行 id、键、eng 值三元组，显式白名单）：
 * tool-jobs 的唤醒预算本机调大到 5000（上游 standard 根本没有这个键，
 * 旧实现逐 key 比较会在这里静默通过，现在必须显式声明）。
 */
const EXTRA_ENG_KEYS = [
  ['tool-jobs', 'maxConsecutiveWakes', '5000'],
]

// ── 定位本机 DSH 安装 ────────────────────────────────────────────────────────

/**
 * 解析本机 DSH 安装根（dsh 包目录）。优先 `DSH_PACKAGE_ROOT`（便于在隔离预演
 * 安装上跑），其次沿 node 可执行文件向上找全局安装目录（`node_modules` 与
 * `lib/node_modules`，覆盖 nvm 与系统级 npm 两种布局），最后退回 node 自带的
 * 解析器；找不到返回 undefined，调用方跳过检查。
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
 * 定位 0.1.7 的上游基准 patch 与模块根，两种安装布局都兼容：
 * - 嵌套：`<dsh 包目录>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
 * - flat：`<dsh 包目录>/../dsh-web-app/presets/standard.patch.yml`
 *   （`npm i --prefix` 的布局，dsh 与 dsh-web-app 平级躺在同一 scope 下）。
 * 找不到返回 undefined（调用方 skip——本机没有 0.1.7 预设布局时不该失败）。
 */
function dshLayout() {
  const root = dshPackageRoot()
  if (root === undefined) return undefined
  const nestedPatch = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (existsSync(nestedPatch)) return { patch: nestedPatch, moduleRoot: join(root, 'node_modules') }
  const scopeDir = dirname(root)
  const flatPatch = join(scopeDir, 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (existsSync(flatPatch)) return { patch: flatPatch, moduleRoot: dirname(scopeDir) }
  return undefined
}

// ── patch 文件解析（零依赖，逐行；缩进抹平）──────────────────────────────────

/** 读文件按行切（去掉行尾 \r）。 */
function fileLines(file) {
  return readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''))
}

/**
 * 取 patch 文件 `config.plugins` 列表的行，缩进抹平到列表自身：从 8 空格的
 * `plugins:` 键起，到出现更浅缩进的非空行止，统一剥掉 10 空格列表缩进。注释
 * 行保留（后续 normalize 过滤），行距差异随之抹平。
 */
function pluginsBlock(file) {
  const lines = fileLines(file)
  const start = lines.findIndex((line) => /^ {8}plugins:\s*$/.test(line))
  assert.notEqual(start, -1, `${file} 缺少 8 空格缩进的 config.plugins 键`)
  const rows = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!line.startsWith('          ')) break
    rows.push(line.slice(10))
  }
  assert.equal(rows.length > 0, true, `${file} 的 config.plugins 是空列表`)
  return rows
}

/** 去掉注释与空行，并抹平缩进——只留「有哪些行」。 */
function normalizedRows(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * 行序列：把 `- id:` 列表项与紧随其后的 `name:` 折成 `id -> name` 一项。
 * 折叠断言比逐行断言更严——行序错位或缺配置项都会暴露，同时允许上游新增行
 * 被显式看见。缩进与引号差异被抹平：两者都不改变解析结果。
 */
function rowEntries(lines) {
  const entries = []
  const rows = normalizedRows(lines)
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
 * 每个行的 `config:` 子树（id 行自身与 `name:` 行除外），键 → 值。
 * 块标量（`>-` / `|` 等）的正文并入键值（非空行以空格连接），使折叠写法与
 * 单行 plain 写法可比。嵌套键（group/isolate 下的行）归到其父键，不单独
 * 成为一项。行原文不再直接比较，避免把行距与缩进当成差异。
 */
function configOfRows(lines) {
  const configs = new Map()
  let current
  let nested = false
  let blockKey = null
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (blockKey !== null) {
      // 块标量正文：直到下一行变回行标记或键值行为止。
      if (/^- id:/.test(line) || /^([A-Za-z0-9_-]+):(?: |$)/.test(line)) {
        blockKey = null
      } else {
        const previous = configs.get(current).get(blockKey)
        configs.get(current).set(blockKey, previous === undefined || previous === '' ? line : `${previous} ${line}`)
        continue
      }
    }
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
      nested = /^[A-Za-z0-9_-]+:$/.test(line)
      const key = nested ? `${keyValue[1]}.*` : keyValue[1]
      const isBlock = !nested && /^(?:[|>])(?:[+-]|\d+)?$/.test(keyValue[2])
      // 块标量的值在后续行：先把键置空，标记 intro（>- / | 等）不进值。
      configs.get(current).set(key, nested || isBlock ? '' : keyValue[2])
      if (isBlock) blockKey = key
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

/** 把 eng-noask 本地插件行的裸子路径折回 eng 路径，行集才能直接对比。 */
const asEngPath = (entry) => entry.replace('dsh-apollo/presets/eng-noask/', 'dsh-apollo/presets/eng/')

// ── 用例 ─────────────────────────────────────────────────────────────────────

test('两份预设 patch 结构合法：单一 insert、config.id 不变、bundle.patch 数组引用、无第二份行清单', () => {
  for (const [file, id, order] of [[ENG_PATCH, 'eng', 10], [NOASK_PATCH, 'eng-noask', 11]]) {
    const lines = fileLines(file)
    const inserts = lines.filter((line) => /^-\s*insert:\s*$/.test(line))
    assert.equal(inserts.length, 1, `${file} 应恰好一个 insert，实际 ${inserts.length}`)
    // config.id 是历史会话恢复所依的预设身份，order 避开内置 standard=1/ptc=2/minimal=3/cordis=4。
    assert.match(lines.join('\n'), new RegExp(`^ {8}id: ${id}\\s*$`, 'm'), `${file} 的 config.id 应为 ${id}`)
    assert.match(lines.join('\n'), new RegExp(`^ {8}order: ${order}\\s*$`, 'm'), `${file} 的 config.order 应为 ${order}`)
    assert.match(lines.join('\n'), /^ {6}name: '@deepseek-ai\/dsh-agent-preset'\s*$/m, `${file} 的 insert 行 name 应为 dsh-agent-preset`)
  }
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dsh?.bundle?.patch,
    ['./cordis.patch.yml', './presets/eng.patch.yml', './presets/eng-noask.patch.yml'],
    'package.json 的 dsh.bundle.patch 应为数组且引用两份预设 patch')
  // 单一事实源：行清单只允许存在于 patch 文件，旧的 agent.cordis.yml/preset.yml
  // 复活即意味着出现第二份会漂移的副本。
  for (const id of ['eng', 'eng-noask']) {
    assert.equal(existsSync(join(PACKAGE_ROOT, 'presets', id, 'agent.cordis.yml')), false,
      `presets/${id}/agent.cordis.yml 不应存在：行清单的单一事实源是 presets/${id}.patch.yml`)
    assert.equal(existsSync(join(PACKAGE_ROOT, 'presets', id, 'preset.yml')), false,
      `presets/${id}/preset.yml 不应存在：元数据已并入 presets/${id}.patch.yml 的 config`)
  }
})

test('eng 预设的行与上游 standard 对齐，差异只有白名单', (t) => {
  const layout = dshLayout()
  if (layout === undefined) {
    t.skip('本机 DSH 没有 dsh-web-app/presets/standard.patch.yml 基准（0.1.7 布局），跳过漂移检查')
    return
  }
  const upstreamRows = pluginsBlock(layout.patch)
  const engRows = pluginsBlock(ENG_PATCH)
  const upstream = rowEntries(upstreamRows)
  const eng = rowEntries(engRows)

  // 顺序敏感：行序错位与新增/缺失行都在这里暴露。上游有、eng 没有 = 漏抄，
  // 漏抄就是静默少一个能力，必须补进 presets/eng.patch.yml 的 config.plugins。
  const extra = eng.filter((entry) => !upstream.includes(entry))
  const missing = upstream.filter((entry) => !eng.includes(entry))
  assert.deepEqual(missing, [], `eng 缺少上游行，请补进 presets/eng.patch.yml 的 config.plugins：\n${missing.join('\n')}`)
  assert.deepEqual(extra, EXTRA_ENG_ROWS, 'eng 相对上游出现了白名单外的行')

  // 嵌套 config 逐 key 比对（双向）：
  // - eng 与上游都有的 key，值不同时只允许命中的 pruner 阈值映射；
  // - eng 有而上游没有的 key，必须命中显式键白名单（不再静默通过）；
  // - 上游有而 eng 没有的 key，直接失败（漏抄配置同样静默少能力）。
  const upstreamConfigs = configOfRows(upstreamRows)
  for (const [id, config] of configOfRows(engRows)) {
    const reference = upstreamConfigs.get(id)
    if (reference === undefined) {
      assert.equal(EXTRA_ENG_ROWS.some((entry) => entry.startsWith(`${id} ->`)), true, `eng 多出的行 ${id} 不在白名单`)
      continue
    }
    for (const [key, value] of config) {
      const upstreamValue = reference.get(key)
      if (upstreamValue === value) continue
      const extraKey = EXTRA_ENG_KEYS.some(([rid, rkey, rvalue]) => rid === id && rkey === key && rvalue === value && upstreamValue === undefined)
      if (extraKey) continue
      const declared = PRUNER_OVERRIDES.get(value)
      assert.equal(declared, upstreamValue,
        `${id}.${key} 与上游不同且未声明：eng=${value} upstream=${upstreamValue}`)
    }
    for (const key of reference.keys()) {
      if (config.has(key)) continue
      assert.fail(`eng.${id} 缺少上游配置键 ${key}：请把该行配置同步进 presets/eng.patch.yml`)
    }
  }
})

test('eng-noask 预设的行与 eng 对齐，唯一差异是剔除的 ask 行与 plan-mode 改写', () => {
  const engRows = pluginsBlock(ENG_PATCH)
  const noaskRows = pluginsBlock(NOASK_PATCH)
  const expected = rowEntries(engRows).filter((entry) => entry !== NOASK_REMOVED_ROW)
  assert.deepEqual(rowEntries(noaskRows).map(asEngPath), expected,
    'eng-noask 应恰为 eng 去掉 tool-ask-user 行；改完 eng 先整块重拷再重做剔除，勿手工分叉')
  // 同 id 行的 config 键值双向比对；plan-mode 的 section 正文是有意改写（无提问
  // 纪律改写了 ask_user_question 两处表述），键级白名单放行，其余必须一致。
  const engConfigs = configOfRows(engRows)
  for (const [id, config] of configOfRows(noaskRows)) {
    const reference = engConfigs.get(id)
    assert.notEqual(reference, undefined, `eng-noask 多出了 eng 没有的行 ${id}`)
    for (const [key, value] of config) {
      if (id === 'plan-mode' && key === 'section') continue
      assert.equal(reference.get(key), value, `eng-noask.${id}.${key} 与 eng 不同：唯一允许差异是删除 ask 行与 plan-mode section 改写`)
    }
    for (const key of reference.keys()) {
      if (config.has(key)) continue
      assert.fail(`eng-noask.${id} 缺少 eng 配置键 ${key}`)
    }
  }
})

test('两份 patch 引用的每个 @deepseek-ai 模块都能在本机 DSH 里解析到', (t) => {
  const layout = dshLayout()
  if (layout === undefined) {
    t.skip('本机 DSH 没有 0.1.7 预设布局，跳过模块解析检查')
    return
  }
  for (const file of [ENG_PATCH, NOASK_PATCH]) {
    // 全文件的行名（含 insert 行自身的 dsh-agent-preset），不只 plugins 块。
    const specifiers = normalizedRows(fileLines(file))
      .filter((row) => row.startsWith('name:'))
      .map((row) => unquote(row.slice('name:'.length).trim()))
    const bare = specifiers.filter((name) => name.startsWith('@deepseek-ai/'))
    assert.equal(bare.length > 20, true, `${file} 应解析出全部上游行名`)
    const unresolved = bare.filter((name) => {
      const [scope, pkg] = name.split('/')
      // 子路径行（如 `.../list-agents`）只要包在即可，具体子路径由 loader 解析。
      return !existsSync(join(layout.moduleRoot, scope, pkg))
    })
    assert.deepEqual(unresolved, [], `${file} 引用了本机 DSH 解析不到的模块：\n${unresolved.join('\n')}`)
  }
})

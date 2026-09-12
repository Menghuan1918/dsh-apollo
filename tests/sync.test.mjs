/**
 * preset-sync.js 单元测试：幂等同步、变更重写、多余文件清理、retire、无关目录隔离。
 * 运行：node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { syncOnePreset, syncPresetTrees } from '../src/preset-sync.js'

function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
}

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

function readTree(root) {
  const out = {}
  for (const rel of treeFiles(root)) out[rel] = readFileSync(join(root, rel), 'utf8')
  return out
}

test('首次同步：完整复制并返回 synced', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'src')
  const target = join(base, 'dst')
  makeTree(source, { 'agent.cordis.yml': 'rows: []\n', 'preset.yml': 'name: 工程模式\n', 'plugins/a/index.js': 'export const name = "a"\n' })

  const outcome = syncOnePreset(source, target)
  assert.equal(outcome, 'synced')
  assert.deepEqual(readTree(target), readTree(source))
  rmSync(base, { recursive: true, force: true })
})

test('再次同步：字节一致时返回 current 且不重写', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'src')
  const target = join(base, 'dst')
  makeTree(source, { 'agent.cordis.yml': 'rows: []\n', 'plugins/a/index.js': 'x' })

  assert.equal(syncOnePreset(source, target), 'synced')
  const mtime = statSync(join(target, 'agent.cordis.yml')).mtimeMs
  assert.equal(syncOnePreset(source, target), 'current')
  assert.equal(statSync(join(target, 'agent.cordis.yml')).mtimeMs, mtime)
  rmSync(base, { recursive: true, force: true })
})

test('源变更：重写对应文件并返回 synced', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'src')
  const target = join(base, 'dst')
  makeTree(source, { 'agent.cordis.yml': 'v1', 'preset.yml': 'keep' })
  syncOnePreset(source, target)

  writeFileSync(join(source, 'agent.cordis.yml'), 'v2-changed')
  assert.equal(syncOnePreset(source, target), 'synced')
  assert.equal(readFileSync(join(target, 'agent.cordis.yml'), 'utf8'), 'v2-changed')
  assert.equal(readFileSync(join(target, 'preset.yml'), 'utf8'), 'keep')
  rmSync(base, { recursive: true, force: true })
})

test('目标多余文件：被清理（prune）', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'src')
  const target = join(base, 'dst')
  makeTree(source, { 'agent.cordis.yml': 'x' })
  syncOnePreset(source, target)
  writeFileSync(join(target, 'stale.txt'), 'stale')
  mkdirSync(join(target, 'stale-dir', 'nested'), { recursive: true })
  writeFileSync(join(target, 'stale-dir', 'nested', 'f.txt'), 'stale')

  assert.equal(syncOnePreset(source, target), 'synced')
  assert.deepEqual(treeFiles(target), ['agent.cordis.yml'])
  rmSync(base, { recursive: true, force: true })
})

test('目标位置被同名文件占位：替换为目录并返回 synced', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const source = join(base, 'src')
  const target = join(base, 'dst')
  makeTree(source, { 'agent.cordis.yml': 'eng' })
  writeFileSync(target, 'not a dir')

  assert.equal(syncOnePreset(source, target), 'synced')
  assert.equal(existsSync(join(target, 'agent.cordis.yml')), true)
  rmSync(base, { recursive: true, force: true })
})

test('syncPresetTrees：多预设 + retire 只删插件曾拥有的 id，不碰无关目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const sourceRoot = join(base, 'presets')
  const targetRoot = join(base, '.agent-presets')
  makeTree(join(sourceRoot, 'eng'), { 'agent.cordis.yml': 'eng' })
  makeTree(join(sourceRoot, 'other'), { 'agent.cordis.yml': 'other' })
  // 目标根预先存在：插件拥有的过期预设、以及一个用户自建预设
  makeTree(join(targetRoot, 'retired-old'), { 'agent.cordis.yml': 'old' })
  makeTree(join(targetRoot, 'user-made'), { 'agent.cordis.yml': 'mine' })

  const result = syncPresetTrees(sourceRoot, targetRoot, ['retired-old'])
  assert.deepEqual(result.synced.sort(), ['eng', 'other'])
  assert.deepEqual(result.current, [])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(result.retired, ['retired-old'])
  assert.equal(existsSync(join(targetRoot, 'retired-old')), false)
  assert.equal(existsSync(join(targetRoot, 'user-made')), true)
  assert.equal(readFileSync(join(targetRoot, 'user-made', 'agent.cordis.yml'), 'utf8'), 'mine')
  rmSync(base, { recursive: true, force: true })
})

test('syncPresetTrees：retire 中 id 仍在源树时不删除', () => {
  const base = mkdtempSync(join(tmpdir(), 'eng-sync-'))
  const sourceRoot = join(base, 'presets')
  const targetRoot = join(base, '.agent-presets')
  makeTree(join(sourceRoot, 'eng'), { 'agent.cordis.yml': 'eng' })
  makeTree(join(targetRoot, 'eng'), { 'agent.cordis.yml': 'eng' })

  const result = syncPresetTrees(sourceRoot, targetRoot, ['eng'])
  assert.deepEqual(result.retired, [])
  assert.equal(existsSync(join(targetRoot, 'eng')), true)
  rmSync(base, { recursive: true, force: true })
})

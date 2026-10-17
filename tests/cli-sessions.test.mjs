/**
 * cli-sessions 独立契约测试：openCliSessions / CliSessions 的持久化契约。
 *
 * 契约来源：
 * - `ctx.storage.backend.get('json')` 返回带 `kv` facet 的 backend；`kv.open(descriptor)`
 *   接受 `{name, version, tables, hasGlobal, layout}`，返回 `KvUnit`，其公开方法为
 *   `loadAll()`（返回 `{tables, global}`）、`putRecord(table,key,value)`、
 *   `deleteRecord(table,key)`、`close()`（`…/dsh-storage-json/lib/types/per-record-unit.d.ts`）。
 * - `@deepseek-ai/dsh-storage-json` 的 per-record 单位是「一条记录一个文件、原子重写」，
 *   所以这里的 fake medium 也按「单键整值原子替换」实现：测试关心的是
 *   「再开一次能不能读回同一份记录」与「写入是否串行、是否在 close 前排空」。
 *
 * 运行：node --test tests/cli-sessions.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CliSessions, openCliSessions } from '../src/cli-sessions.js'

// ── fake 存储介质 ────────────────────────────────────────────────────────────
// medium: name -> Map(key -> value)，跨 open/close 存活，模拟磁盘上的 per-record 目录。

function makeStorage(medium = new Map(), { failOpen = false, failLoad = false, track = false, failFirstPut = false } = {}) {
  const opened = []
  const mediumWrites = []
  let putCalls = 0
  const backend = {
    kv: {
      async open(descriptor) {
        if (failOpen) throw new Error('no kv facet')
        const existing = medium.get(descriptor.name)
        const table = typeof existing === 'object' && existing !== null && existing instanceof Map ? existing : new Map()
        medium.set(descriptor.name, table)
        const unit = {
          descriptor,
          closed: false,
          async loadAll() {
            if (failLoad) throw new Error('malformed medium')
            if (unit.closed) throw new Error('unit closed')
            return { tables: { sessions: Object.fromEntries(table) }, global: null }
          },
          async putRecord(name, key, value) {
            if (unit.closed) throw new Error('unit closed')
            putCalls += 1
            if (failFirstPut && putCalls === 1) throw new Error('disk full')
            if (track) mediumWrites.push(['start', key])
            if (track) await new Promise((resolve) => setImmediate(resolve))
            table.set(key, structuredClone(value))
            if (track) mediumWrites.push(['end', key])
          },
          async deleteRecord(name, key) {
            if (unit.closed) throw new Error('unit closed')
            table.delete(key)
          },
          async close() {
            unit.closed = true
            opened.push(unit)
          },
        }
        return unit
      },
    },
  }
  const ctx = { get: (name) => (name === 'profileContext' ? { dir: '/profiles/web' } : undefined), storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } } }
  return { ctx, medium, opened, mediumWrites }
}

const RECORD = Object.freeze({
  version: 1, id: 'child-1', parentId: 'parent-1', cli: 'codex', cwd: '/tmp/work',
  executable: 'codex', profile: '', model: 'gpt-5-codex', effort: 'low', delivered: [],
})

const record = (over = {}) => structuredClone({ ...RECORD, ...over })

// ── A. 命名空间与 descriptor ─────────────────────────────────────────────────

test('命名空间：同一 profile dir 两次打开命中同一个 unit name，descriptor 形状固定', async () => {
  const { ctx } = makeStorage()
  const first = await openCliSessions(ctx)
  const second = await openCliSessions(ctx)
  assert.equal(first.unit.descriptor.name, second.unit.descriptor.name)
  assert.match(first.unit.descriptor.name, /^apollo_cli_[0-9a-f]{16}$/)
  assert.deepEqual(first.unit.descriptor, {
    name: first.unit.descriptor.name,
    version: 1,
    tables: ['sessions'],
    hasGlobal: false,
    layout: 'per-record',
  })
})

test('KV 独立：不同 profile dir → 不同 unit name（互不串记录）', async () => {
  const medium = new Map()
  const storage = makeStorage(medium)
  const other = { ...storage.ctx, get: (name) => (name === 'profileContext' ? { dir: '/profiles/desktop' } : undefined) }
  const a = await openCliSessions(storage.ctx)
  const b = await openCliSessions(other)
  assert.notEqual(a.unit.descriptor.name, b.unit.descriptor.name)
})

test('KV 独立：缺 profileContext 时退化为稳定的 default 命名空间', async () => {
  const storage = makeStorage()
  const bare = { ...storage.ctx, get: () => undefined }
  const a = await openCliSessions(bare)
  const b = await openCliSessions(bare)
  assert.equal(a.unit.descriptor.name, b.unit.descriptor.name)
  assert.match(a.unit.descriptor.name, /^apollo_cli_[0-9a-f]{16}$/)
})

test('缺失：没有 json backend / 没有 kv facet → 明确报错', async () => {
  const ctx = { get: () => ({ dir: '/profiles/web' }), storage: { backend: { get: () => undefined } } }
  await assert.rejects(() => openCliSessions(ctx), /JSON storage backend/)
  const storage = makeStorage(new Map(), { failOpen: true })
  await assert.rejects(() => openCliSessions(storage.ctx), /no kv facet/)
})

test('失败路径：loadAll 抛错时关闭 unit（不泄漏已打开的槽位）', async () => {
  const storage = makeStorage(new Map(), { failLoad: true })
  await assert.rejects(() => openCliSessions(storage.ctx), /malformed medium/)
  assert.equal(storage.opened.length, 1)
  assert.equal(storage.opened[0].closed, true)
})

// ── B. 记录读取与校验 ────────────────────────────────────────────────────────

test('读取：open 时装载已有记录，get 返回独立副本', async () => {
  const medium = new Map()
  const storage = makeStorage(medium)
  const first = await openCliSessions(storage.ctx)
  await first.put(record())
  await first.close()

  const second = await openCliSessions(storage.ctx)
  const loaded = second.get('child-1')
  assert.equal(loaded.model, 'gpt-5-codex')
  loaded.model = 'mutated'
  assert.equal(second.get('child-1').model, 'gpt-5-codex', 'get 必须返回副本，外部改动不得污染 store')
  assert.equal(second.get('missing'), undefined)
})

test('校验：非法存档形状一律抛错（版本/cli/id/parentId/cwd/model/effort/executable/delivered）', async () => {
  const cases = [
    ['版本', { version: 2 }],
    ['cli', { cli: 'other' }],
    ['id', { id: 'mismatch' }],
    ['parentId', { parentId: 1 }],
    ['cwd', { cwd: 1 }],
    ['model', { model: 1 }],
    ['effort', { effort: 1 }],
    ['executable', { executable: 1 }],
    ['delivered', { delivered: 'm1' }],
  ]
  for (const [label, over] of cases) {
    const sessions = new CliSessions({}, { 'child-1': record(over) })
    assert.throws(() => sessions.get('child-1'), /invalid stored state/, label)
  }
})

// ── C. 序列原子写 ────────────────────────────────────────────────────────────

test('原子写：put 落盘的是独立副本（调用方后续改动不影响存档）', async () => {
  const storage = makeStorage()
  const sessions = await openCliSessions(storage.ctx)
  const value = record()
  const pending = sessions.put(value)
  value.model = 'mutated-after-put'
  await pending
  assert.equal(sessions.get('child-1').model, 'gpt-5-codex')
})

test('原子写：id 必须是安全 token（路径穿越/空值被拒且不落盘）', async () => {
  const storage = makeStorage()
  const sessions = await openCliSessions(storage.ctx)
  for (const id of ['../escape', 'a/b', '', 'has space']) {
    await assert.rejects(() => sessions.put(record({ id })), /Invalid Apollo CLI session id/, id)
  }
  assert.equal(sessions.get('../escape'), undefined)
  assert.equal(sessions.get('a/b'), undefined)
})

test('序列原子写：并发 put 串行落盘，顺序与调用顺序一致', async () => {
  const storage = makeStorage(new Map(), { track: true })
  const sessions = await openCliSessions(storage.ctx)
  await Promise.all([
    sessions.put(record({ id: 'a' })),
    sessions.put(record({ id: 'b' })),
    sessions.put(record({ id: 'c' })),
  ])
  assert.deepEqual(storage.mediumWrites, [
    ['start', 'a'], ['end', 'a'],
    ['start', 'b'], ['end', 'b'],
    ['start', 'c'], ['end', 'c'],
  ], '写入必须严格串行，不得交错')
})

test('序列原子写：前一次写失败不阻断后续写入（写队列吞掉异常）', async () => {
  const storage = makeStorage(new Map(), { failFirstPut: true })
  const sessions = await openCliSessions(storage.ctx)
  await assert.rejects(() => sessions.put(record({ id: 'a' })), /disk full/)
  await sessions.put(record({ id: 'b' }))
  assert.equal(sessions.get('b').id, 'b')
  assert.equal(sessions.get('a'), undefined)
})

test('序列原子写：并发 put/delete 同一 id 的最终态等于提交顺序的最终态', async () => {
  const storage = makeStorage()
  const sessions = await openCliSessions(storage.ctx)
  await sessions.put(record({ id: 'a' }))
  await Promise.all([
    sessions.put(record({ id: 'a', model: 'second' })),
    sessions.delete('a'),
    sessions.put(record({ id: 'a', model: 'third' })),
  ])
  assert.equal(sessions.get('a').model, 'third')
})

// ── D. 重开与 close ──────────────────────────────────────────────────────────

test('重开：close 后重新 open 能读回同一份记录（medium 是唯一事实源）', async () => {
  const storage = makeStorage()
  const first = await openCliSessions(storage.ctx)
  await first.put(record({ delivered: ['m1'], remoteId: 'thread-9' }))
  await first.close()

  const second = await openCliSessions(storage.ctx)
  const loaded = second.get('child-1')
  assert.deepEqual(loaded.delivered, ['m1'])
  assert.equal(loaded.remoteId, 'thread-9')
  await second.close()
})

test('重开：delete 是持久的（重开后不再出现）', async () => {
  const storage = makeStorage()
  const first = await openCliSessions(storage.ctx)
  await first.put(record())
  await first.delete('child-1')
  await first.close()
  const second = await openCliSessions(storage.ctx)
  assert.equal(second.get('child-1'), undefined)
  await second.close()
})

test('close：先排空在途写入再关闭 unit，之后任何写入都被拒', async () => {
  const storage = makeStorage(new Map(), { track: true })
  const sessions = await openCliSessions(storage.ctx)
  const pending = sessions.put(record())
  const closing = sessions.close()
  await closing
  assert.deepEqual(storage.mediumWrites, [['start', 'child-1'], ['end', 'child-1']], 'close 必须等在途写落盘')
  assert.equal(storage.opened.length, 1)
  assert.equal(storage.opened[0].closed, true)
  await pending
  await assert.rejects(() => sessions.put(record({ id: 'later' })), /closed/)
  await assert.rejects(() => sessions.delete('child-1'), /closed/)
})

test('close：写失败也不阻塞 close（写队列已吞异常）', async () => {
  const storage = makeStorage(new Map(), { failFirstPut: true })
  const sessions = await openCliSessions(storage.ctx)
  await assert.rejects(() => sessions.put(record()), /disk full/)
  await assert.doesNotReject(() => sessions.close())
})

test('close：已落盘的记录在 close 后仍然可读（读走内存副本）', async () => {
  const storage = makeStorage()
  const sessions = await openCliSessions(storage.ctx)
  await sessions.put(record())
  await sessions.close()
  assert.equal(sessions.get('child-1').id, 'child-1')
})

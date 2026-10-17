/**
 * cli-adapter 独立契约测试：createCliAdapter 的对外可观察行为。
 *
 * 契约来源（不镜像实现，只断言 runtime 契约）：
 * - LLM adapter 由 `ctx.llm.registerAdapter([route], adapter)` 注册；Agent loop 通过
 *   `adapter.stream(GenerateOptions)` 消费 `StreamChunk`（`…/dsh-llm/lib/types/types.d.ts`
 *   的 `GenerateOptions` / `StreamChunk`），`GenerateOptions.sessionId` 是子会话 id。
 * - 托管子进程走 `ctx.subprocess.spawn(SubprocessSpawnSpec)`，返回
 *   `SubprocessHandle`：`stdout: Readable | undefined`、`done: Promise<SubprocessOutcome>`、
 *   `terminate()`、`waitForExit()`；`SubprocessOutcome = {exitCode, signal}`；
 *   stdin 的 `{data: string}` 形态即「把这段文本写进子进程 stdin」
 *   （`…/dsh-subprocess/lib/types/types.d.ts`）。
 * - 这里用 **fake managed subprocess + 真实协议事件**：事件是 codex/claude 两个 CLI 的
 *   真实 JSONL 形态（与 tests/cli.test.mjs 的 fixture 同源），不启动真实 CLI。
 *
 * 运行：node --test tests/cli-adapter.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { CLI_ROUTES, createCliAdapter, pendingMessages } from '../src/cli-adapter.js'

// ── fake managed subprocess ──────────────────────────────────────────────────

const JSONL = (events) => events.map((event) => `${JSON.stringify(event)}\n`).join('')

/**
 * 构造一个 fake 托管子进程服务：每次 spawn 记录 spec，并让 stdout 依次吐出给定事件。
 * stdout 是 push-based Readable（数据先入缓冲，消费者随后读取），`done` 与真实契约一致：
 * **进程结束（stdout 结束）或 `terminate()` 后 resolve `SubprocessOutcome`**；两者只发生一次。
 * `terminate()` 会结束 stdout 并 settle done —— 真实 managed service 就是这样，否则 adapter
 * 的 `dispose()` 会（正确地）一直等一个永不 settle 的 done。
 */
function makeSubprocess() {
  const spawns = []
  const behaviors = []
  const subprocess = {
    spawns,
    behaviors,
    spawn(spec) {
      // 脚本按 FIFO 消耗；队列空时复用最后一个（同一脚本往往要作用于多个会话）。
      const behavior = behaviors.length > 1 ? behaviors.shift() : (behaviors[0] ?? {})
      const entry = {
        spec,
        stdin: spec.stdio.stdin?.data,
        terminateCalls: 0,
        chunks: behavior.chunks ?? [JSONL(behavior.events ?? [])],
      }
      let finishDone
      let finished = false
      entry.exited = false
      entry.doneSettledWith = undefined
      entry.done = new Promise((resolve) => { finishDone = resolve })
      const finish = () => {
        if (finished) return
        finished = true
        if (!entry.stdoutEnded) {
          entry.stdoutEnded = true
          try { entry.stdout.push(null) } catch { /* 已 EOF：忽略重复结束 */ }
        }
        entry.exited = true
        entry.doneSettledWith = behavior.outcome ?? { exitCode: 0, signal: null }
        finishDone(entry.doneSettledWith)
      }
      entry.finish = finish
      const stdout = new Readable({ read() {} })
      entry.stdout = stdout
      stdout.on('end', finish)
      // `defer` 表示「本次 spawn 由测试自己按时间推进事件流」（用于中断/时序用例）。
      if (behavior.defer !== true) {
        for (const chunk of entry.chunks) stdout.push(chunk)
        stdout.push(null)
      }
      entry.handle = {
        stdin: undefined,
        stdout,
        stderr: undefined,
        control: undefined,
        collected: {},
        done: entry.done,
        terminate() { entry.terminateCalls += 1; finish() },
        async waitForExit() { return true },
      }
      spawns.push(entry)
      return entry.handle
    },
  }
  return { subprocess, spawns, behaviors }
}

/** 排入「下一次 spawn 该吐什么事件」的行为（fake 专用，不属于真实 seam）。 */
function scriptNext(subprocess, behavior = {}) {
  subprocess.behaviors.push(behavior)
}

// ── 契约 stub ────────────────────────────────────────────────────────────────

function makeConfig({ codex = {}, claude = {} } = {}) {
  const backend = (extra) => ({
    enabled: true,
    executable: 'codex',
    profile: '',
    permissionMode: 'read-only',
    defaultModel: 'gpt-5-codex',
    models: [{ id: 'gpt-5-codex', efforts: ['low', 'high'], defaultEffort: 'low' }],
    ...extra,
  })
  return {
    subagents: {
      global: true,
      eng: false,
      codex: backend(codex),
      claude: backend({ executable: 'claude', defaultModel: 'sonnet', models: [{ id: 'sonnet', efforts: ['low'], defaultEffort: 'low' }], ...claude }),
    },
  }
}

/** 满足 CliSessions 公开方法面的可变 store（可观察 put/get）。 */
function makeSessions(records = {}) {
  const store = new Map(Object.entries(records))
  return {
    store,
    puts: [],
    get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),
    async put(record) { this.puts.push(structuredClone(record)); store.set(record.id, structuredClone(record)) },
    async delete(id) { store.delete(id) },
  }
}

// 形状与 src/subagents.js 落盘的记录一致（含 cliHome 与 started 两个字段）。
const record = (over = {}) => ({
  version: 1, id: 'child-1', parentId: 'parent-1', cli: 'codex', cwd: '/tmp/apollo-work',
  executable: 'codex', profile: '', cliHome: '/tmp/codex-home', model: 'gpt-5-codex',
  effort: 'low', delivered: [], started: false, ...over,
})

/** 一个子会话 Agent（适配器校验 parentSession/origin/isSeeded）。 */
function makeChildAgent(id, { subprocess, header = {}, withSubprocess = true } = {}) {
  return {
    id,
    session: { header: { parentSession: 'parent-1', origin: 'subagent', isSeeded: false, agentPreset: 'eng', ...header } },
    ctx: { get: (name) => (name === 'subprocess' && withSubprocess ? subprocess : undefined) },
  }
}

/** 组装一次 adapter.stream 所需的 ctx/agent/sessions/options。 */
function harness({ cli = 'codex', config = makeConfig(), state = record(), subprocess, generate = {}, withSubprocess = true } = {}) {
  const sessions = makeSessions({ [state.id]: state })
  const agents = new Map([[state.id, makeChildAgent(state.id, { subprocess, withSubprocess })]])
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    get: (name) => (name === 'subprocess' && withSubprocess ? subprocess : undefined),
  }
  const adapter = createCliAdapter(ctx, config, sessions, cli)
  const options = {
    provider: CLI_ROUTES[cli],
    model: state.model,
    reasoningEffort: state.effort,
    sessionId: state.id,
    messages: [{ role: 'user', id: 'm1', content: 'hello' }],
    ...generate,
  }
  return { adapter, ctx, sessions, options, agents }
}

/** 收齐 stream 产出的所有 chunk（adapter.stream 是 async generator）。 */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 断言抛出且信息匹配（async generator 的错误在迭代时才出现）。 */
async function rejectsAsync(fn, pattern) {
  await assert.rejects(async () => { await fn() }, pattern)
}

// ── A. provider 元数据与模型目录 ─────────────────────────────────────────────

test('元数据：providerInfo/route 与关闭开关时的空目录', async () => {
  const { subprocess } = makeSubprocess()
  const { adapter } = harness({ subprocess })
  assert.equal(adapter.providerInfo().id, 'apollo-cli-codex')
  assert.match(adapter.providerInfo().name, /Codex/)
  const off = harness({ subprocess, config: makeConfig({ codex: { enabled: false } }) }).adapter
  assert.deepEqual(await off.listModels(), [])
  const on = harness({ subprocess, config: makeConfig() }).adapter
  assert.deepEqual((await on.listModels()).map((m) => m.id), ['gpt-5-codex'])
})

test('元数据：resolveModel 只认自己的 route + 白名单内的模型', async () => {
  const { subprocess } = makeSubprocess()
  const { adapter } = harness({ subprocess })
  await assert.rejects(() => adapter.resolveModel('apollo-cli-claude', 'gpt-5-codex'), /unavailable/)
  await assert.rejects(() => adapter.resolveModel('apollo-cli-codex', 'nope'), /unavailable/)
  const info = await adapter.resolveModel('apollo-cli-codex', 'gpt-5-codex')
  assert.equal(info.provider, 'apollo-cli-codex')
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'low')
})

test('元数据：CLI 轮次绝不自动重试（maxRetries=0，可重试码为空）', () => {
  const { subprocess } = makeSubprocess()
  const { adapter } = harness({ subprocess })
  const policy = adapter.providerRetryPolicy()
  assert.equal(policy.maxRetries, 0)
  assert.deepEqual([...policy.retryableCodes], [])
})

// ── B. 早存 remoteId（首轮）──────────────────────────────────────────────────

test('早存：thread.started 一出现就把 remoteId 落进 session store（进程结束前）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, {
    events: [
      { type: 'thread.started', thread_id: 'thread-abc' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ],
  })
  const { adapter, sessions, options } = harness({ subprocess })
  const chunks = await collect(adapter, options)
  assert.equal(sessions.get('child-1').remoteId, 'thread-abc')
  assert.equal(spawns.length, 1)
  assert.match(spawns[0].stdin, /hello/)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('早存：remoteId 在「事件流被消费时」即已持久化，而不是等到流结束', async () => {
  const { subprocess } = makeSubprocess()
  const observed = []
  // 第一行 thread.started、第二行在下一个 tick 才到达：中途读一次 store 应为已存。
  const first = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-early' })}\n`
  const second = `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`
  scriptNext(subprocess, { chunks: [first, second] })
  const { adapter, sessions, options } = harness({ subprocess })
  const originalPut = sessions.put.bind(sessions)
  sessions.put = async (value) => { observed.push([value.remoteId, value.started]); return originalPut(value) }
  await collect(adapter, options)
  assert.deepEqual(observed, [
    [undefined, true], // 回合开始：先落「已尝试投递」
    ['thread-early', true], // 第一行事件：立刻补上身份
  ], 'remoteId 必须在第一行事件后立刻落盘（不等到流结束）')
})

test('早存：claude 用第一个带 session_id 的 system 事件（hook_started 早于 init）', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, {
    events: [
      { type: 'system', subtype: 'hook_started', session_id: 'sess-1' },
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  })
  const { adapter, sessions, options } = harness({ cli: 'claude', subprocess, state: record({ cli: 'claude', executable: 'claude', model: 'sonnet', effort: 'low' }) })
  await collect(adapter, options)
  assert.equal(sessions.get('child-1').remoteId, 'sess-1')
})

// ── C. 中断后续接（resume）与身份固定 ────────────────────────────────────────

test('续接：已有 remoteId 时走 resume 位置参数，且 remoteId 不再重写', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, {
    events: [
      { type: 'thread.started', thread_id: 'thread-abc' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'second turn' } },
      { type: 'turn.completed', usage: {} },
    ],
  })
  const state = record({ remoteId: 'thread-abc', started: true, delivered: ['m0'] })
  const { adapter, sessions, options } = harness({ subprocess, state, generate: { messages: [{ role: 'user', id: 'm1', content: 'again' }] } })
  await collect(adapter, options)
  assert.ok(spawns[0].spec.argv.includes('resume'))
  assert.equal(spawns[0].spec.argv[spawns[0].spec.argv.indexOf('resume') + 1], 'thread-abc')
  assert.equal(sessions.get('child-1').remoteId, 'thread-abc')
  assert.equal(sessions.puts.length, 1, '续接轮只落一次盘（记录投递），身份不重写')
  assert.equal(sessions.puts[0].remoteId, 'thread-abc')
})

test('续接：resume 回来的 remoteId 与存档不同 → 拒绝替换身份', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 'thread-OTHER' }, { type: 'turn.completed', usage: {} }] })
  const state = record({ remoteId: 'thread-abc', started: true, delivered: ['m0'] })
  const { adapter, options } = harness({ subprocess, state })
  await rejectsAsync(() => collect(adapter, options), /different session/)
})

test('身份固定：换权限模式（permissionMode）不换 model/profile', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, {
    events: [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.completed', usage: {} },
    ],
  })
  const state = record({ permissionMode: 'read-only', profile: 'work' })
  const config = makeConfig({ codex: { permissionMode: 'workspace-write' } })
  const { adapter, options } = harness({ subprocess, state, config })
  await collect(adapter, options)
  const argv = spawns[0].spec.argv
  assert.deepEqual(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2), ['-s', 'workspace-write'], '权限取当前配置')
  assert.deepEqual(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2), ['-m', 'gpt-5-codex'], '模型取存档（不随配置漂移）')
  assert.deepEqual(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2), ['-p', 'work'], 'profile 取存档')
})

test('身份固定：请求的 model/effort 与会话存档不一致 → 拒绝（冷续接也走这条校验）', async () => {
  const { subprocess } = makeSubprocess()
  const { adapter, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, { ...options, model: 'other-model' }), /fixed at creation/)
  await rejectsAsync(() => collect(adapter, { ...options, reasoningEffort: 'high' }), /fixed at creation/)
})

// ── D. env snapshot（cliHome）───────────────────────────────────────────────

test('env snapshot：codex 的 cliHome 以 CODEX_HOME 传给托管子进程', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const state = record({ cliHome: '/tmp/codex-home' })
  const { adapter, options } = harness({ subprocess, state })
  await collect(adapter, options)
  assert.deepEqual(spawns[0].spec.env, { CODEX_HOME: '/tmp/codex-home' })
})

test('env snapshot：claude 的 cliHome 以 CLAUDE_CONFIG_DIR 传入；无 cliHome 时不传 env', async () => {
  const first = makeSubprocess()
  scriptNext(first.subprocess, { events: [{ type: 'system', session_id: 's' }, { type: 'result', subtype: 'success', result: 'ok' }] })
  const claudeState = record({ cli: 'claude', executable: 'claude', model: 'sonnet', effort: 'low', cliHome: '/tmp/claude-home' })
  const a = harness({ cli: 'claude', subprocess: first.subprocess, state: claudeState })
  await collect(a.adapter, a.options)
  assert.deepEqual(first.spawns[0].spec.env, { CLAUDE_CONFIG_DIR: '/tmp/claude-home' })

  const second = makeSubprocess()
  scriptNext(second.subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const b = harness({ subprocess: second.subprocess, state: record({ cliHome: undefined }) })
  await collect(b.adapter, b.options)
  assert.equal(Object.hasOwn(second.spawns[0].spec, 'env'), false, '没有 cliHome 时不得注入空 env')
})

test('env snapshot：Claude 默认模式冷续接保持 HOME，并移除后来新增的 CLAUDE_CONFIG_DIR', async () => {
  const saved = process.env.CLAUDE_CONFIG_DIR
  try {
    delete process.env.CLAUDE_CONFIG_DIR
    const state = record({ cli: 'claude', executable: 'claude', model: 'sonnet', cliHome: '/tmp/original-user/.claude', claudeDefaultHome: true })
    const first = makeSubprocess()
    scriptNext(first.subprocess, { events: [{ type: 'system', session_id: 's' }, { type: 'result', subtype: 'success', result: 'ok' }] })
    const a = harness({ cli: 'claude', subprocess: first.subprocess, state })
    await collect(a.adapter, a.options)
    assert.deepEqual(first.spawns[0].spec.env, { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: '/tmp/original-user', CLAUDE_CONFIG_DIR: undefined })

    process.env.CLAUDE_CONFIG_DIR = '/tmp/changed-config'
    const second = makeSubprocess()
    scriptNext(second.subprocess, { events: [{ type: 'system', session_id: 's' }, { type: 'result', subtype: 'success', result: 'resumed' }] })
    const b = harness({ cli: 'claude', subprocess: second.subprocess, state: a.sessions.get(state.id), generate: { messages: [...a.options.messages, { role: 'user', id: 'm2', content: 'again' }] } })
    await collect(b.adapter, b.options)
    assert.deepEqual(second.spawns[0].spec.env, first.spawns[0].spec.env)
    assert.ok(second.spawns[0].spec.argv.includes('--resume'))
    assert.equal(b.sessions.get(state.id).remoteId, 's')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

// ── E. 并发隔离 ──────────────────────────────────────────────────────────────

test('并发隔离：同一 adapter 上两个不同会话各自 spawn，互不干扰', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const sessions = makeSessions({ 'child-1': record(), 'child-2': record({ id: 'child-2' }) })
  const agents = new Map([
    ['child-1', makeChildAgent('child-1', { subprocess })],
    ['child-2', makeChildAgent('child-2', { subprocess })],
  ])
  const ctx = { agents: { get: (id) => agents.get(id) }, get: () => subprocess }
  const adapter = createCliAdapter(ctx, makeConfig(), sessions, 'codex')
  const base = { provider: 'apollo-cli-codex', model: 'gpt-5-codex', reasoningEffort: 'low', messages: [{ role: 'user', id: 'm1', content: 'hi' }] }
  const [one, two] = await Promise.all([
    collect(adapter, { ...base, sessionId: 'child-1' }),
    collect(adapter, { ...base, sessionId: 'child-2' }),
  ])
  assert.equal(spawns.length, 2)
  assert.equal(one.at(-1).type, 'finish')
  assert.equal(two.at(-1).type, 'finish')
  assert.equal(sessions.get('child-1').delivered.includes('m1'), true)
  assert.equal(sessions.get('child-2').delivered.includes('m1'), true)
})

test('并发隔离：同一会话重入（已有 active turn）被拒绝', async () => {
  const { subprocess, spawns } = makeSubprocess()
  // defer：第一轮停在活跃状态（stdout 未结束 → done 未 settle），才能观察重入。
  scriptNext(subprocess, { defer: true })
  const { adapter, options } = harness({ subprocess })
  const first = collect(adapter, options)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawns.length, 1, '第一轮应已 spawn')
  await rejectsAsync(() => collect(adapter, { ...options, messages: [{ role: 'user', id: 'm2', content: 'again' }] }), /active turn/)
  // 结束第一轮：真实 CLI 会写完事件后退出（stdout 结束 → done resolve）。
  spawns[0].stdout.push(`${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n`)
  spawns[0].stdout.push(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`)
  spawns[0].stdout.push(null)
  await first
})

// ── F. 坏 JSON / 非零退出 / 无完成标志 ───────────────────────────────────────

test('坏 JSON：非空非法行 → 抛语法错误（不静默当成功）', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { chunks: ['{"type":"thread.started","thread_id":"t"}\n', 'not json\n'] })
  const { adapter, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, options), /不是合法 JSON/)
})

test('坏 JSON：空白行被跳过，不破坏事件流', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { chunks: ['\n{"type":"thread.started","thread_id":"t"}\n\n{"type":"turn.completed","usage":{}}\n\n'] })
  const { adapter, options } = harness({ subprocess })
  const chunks = await collect(adapter, options)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('非零退出：exitCode!==0 → 抛错并提示认证/权限', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }], outcome: { exitCode: 2, signal: null } })
  const { adapter, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, options), /exited with 2/)

  const stderrProcess = makeSubprocess()
  const spawn = stderrProcess.subprocess.spawn.bind(stderrProcess.subprocess)
  stderrProcess.subprocess.spawn = (spec) => {
    const handle = spawn(spec)
    handle.collected = { stderr: { readFrom: () => ({ text: '403 credit allowance exhausted; api_key=sk-abcdefghijklmnopqrstuv' }) } }
    return handle
  }
  scriptNext(stderrProcess.subprocess, { events: [], outcome: { exitCode: 1, signal: null } })
  const failed = harness({ subprocess: stderrProcess.subprocess })
  await assert.rejects(collect(failed.adapter, failed.options), (error) => {
    assert.match(error.message, /403 credit allowance exhausted/)
    assert.doesNotMatch(error.message, /sk-abcdefghijklmnopqrstuv/)
    return true
  })
})

test('非零退出：结构化 API 错误优先于重复的 stderr 配置告警', async () => {
  const { subprocess } = makeSubprocess()
  const spawn = subprocess.spawn.bind(subprocess)
  subprocess.spawn = (spec) => {
    const handle = spawn(spec)
    handle.collected = { stderr: { readFrom: () => ({ text: 'Claude configuration file not found; backup available. '.repeat(30) }) } }
    return handle
  }
  scriptNext(subprocess, { events: [
    { type: 'system', session_id: 's' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 403 credit allowance exhausted; api_key=sk-abcdefghijklmnopqrstuv'] },
  ], outcome: { exitCode: 1, signal: null } })
  const failed = harness({ cli: 'claude', subprocess, state: record({ cli: 'claude', executable: 'claude', model: 'sonnet' }) })
  await assert.rejects(collect(failed.adapter, failed.options), (error) => {
    assert.match(error.message, /403 credit allowance exhausted/)
    assert.doesNotMatch(error.message, /backup available|sk-abcdefghijklmnopqrstuv/)
    return true
  })
})

test('非零退出：spawn 失败（done reject）→ 归类为进程无法启动', async () => {
  const { subprocess } = makeSubprocess()
  const original = subprocess.spawn.bind(subprocess)
  subprocess.spawn = (spec) => {
    const handle = original(spec)
    // 真实契约允许 done reject（spawn/provider 失败）；先挂 catch 避免 unhandled，adapter 仍能 await 到 rejection。
    handle.done = Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
    handle.done.catch(() => {})
    return handle
  }
  scriptNext(subprocess, { events: [] })
  const { adapter, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, options), /could not start: ENOENT/)
})

test('无完成标志：流结束但没收到 turn.completed → 抛错，不产出 finish', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }] })
  const { adapter, options } = harness({ subprocess })
  const chunks = []
  await rejectsAsync(async () => { for await (const chunk of adapter.stream(options)) chunks.push(chunk) }, /turn\.completed/)
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), false)
})

test('Codex 配置告警（item.type=error）不致命：回合仍可成功', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, {
    events: [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { type: 'error', message: 'ignoring 2 unrecognized configuration settings' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
      { type: 'turn.completed', usage: {} },
    ],
  })
  const { adapter, options } = harness({ subprocess })
  const chunks = await collect(adapter, options)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'final')
})

test('致命事件：turn.failed → 抛错且不产出 finish', async () => {
  const { subprocess } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: 'boom' } }] })
  const { adapter, options } = harness({ subprocess })
  const chunks = []
  await rejectsAsync(async () => { for await (const chunk of adapter.stream(options)) chunks.push(chunk) }, /codex 回合失败/)
  assert.equal(chunks.length, 0)
})

test('中断无自动重试：中断后不产出 finish、不重跑进程，且已收到的身份仍然保留', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const controller = new AbortController()
  const line = (event) => `${JSON.stringify(event)}\n`
  // 事件之间留出真实异步边界：先等到「身份已落盘」再中断，中断落在 turn.completed 之前。
  scriptNext(subprocess, { defer: true })
  const original = subprocess.spawn.bind(subprocess)
  subprocess.spawn = (spec) => {
    const handle = original(spec)
    handle.stdout.push(line({ type: 'thread.started', thread_id: 't' }))
    setTimeout(() => handle.stdout.push(line({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } })), 400)
    setTimeout(() => handle.stdout.push(line({ type: 'turn.completed', usage: {} })), 800)
    setTimeout(() => handle.stdout.push(null), 900)
    return handle
  }
  const { adapter, sessions, options } = harness({ subprocess, generate: { signal: controller.signal } })
  const chunks = []
  const pending = (async () => {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  })().then(() => 'completed', (error) => error.name)

  const deadline = Date.now() + 2000
  while (sessions.get('child-1')?.remoteId !== 't' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(sessions.get('child-1').remoteId, 't', '第一行事件到达后身份应先落盘')
  controller.abort()

  const outcome = await pending
  assert.notEqual(outcome, 'completed', '中断的轮次不得报告 completed')
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), false, '中断的轮次不得产出 finish')
  assert.equal(spawns.length, 1, '中断后不得自动重试')
  assert.equal(sessions.get('child-1').remoteId, 't', '中断前收到的身份保留')
  assert.equal(adapter.providerRetryPolicy().maxRetries, 0)
})

test('中断无自动重试：完成标志之后的中断不影响既有结果（不重跑进程）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const controller = new AbortController()
  scriptNext(subprocess, {
    events: [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: {} },
    ],
  })
  const { adapter, options } = harness({ subprocess, generate: { signal: controller.signal } })
  const chunks = []
  const iterator = adapter.stream(options)
  for (;;) {
    const step = await iterator.next()
    if (step.done) break
    chunks.push(step.value)
    if (step.value.type === 'finish') break
  }
  controller.abort()
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(spawns.length, 1)
})

test('中断：已中断的 signal 在 spawn 之前就抛出（不产生子进程）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const controller = new AbortController()
  controller.abort()
  const { adapter, options } = harness({ subprocess, generate: { signal: controller.signal } })
  await rejectsAsync(() => collect(adapter, options), (error) => error.name === 'AbortError')
  assert.equal(spawns.length, 0)
})

// ── G. history cursor（只发新消息）─────────────────────────────────────────

test('history cursor：只把未 delivered 的用户消息写进 stdin，已投递的不重发', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const state = record({ delivered: ['m1'] })
  const { adapter, sessions, options } = harness({
    subprocess,
    state,
    generate: { messages: [{ role: 'user', id: 'm1', content: 'old' }, { role: 'assistant', content: 'noise' }, { role: 'user', id: 'm2', content: 'new' }] },
  })
  await collect(adapter, options)
  assert.doesNotMatch(spawns[0].stdin, /old/)
  assert.match(spawns[0].stdin, /new/)
  assert.deepEqual(sessions.get('child-1').delivered, ['m1', 'm2'])
})

test('history cursor：没有新用户消息时拒绝这一轮（不空跑 CLI）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const state = record({ delivered: ['m1'] })
  const { adapter, options } = harness({ subprocess, state })
  await rejectsAsync(() => collect(adapter, options), /no new user message/)
  assert.equal(spawns.length, 0)
})

test('history cursor：投递记录在 spawn 之前落盘（崩溃后不重发）', async () => {
  const { subprocess } = makeSubprocess()
  let deliveredAtSpawn
  const original = subprocess.spawn.bind(subprocess)
  const ref = {}
  subprocess.spawn = (spec) => { deliveredAtSpawn = ref.sessions.get('child-1').delivered; return original(spec) }
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const { adapter, sessions, options } = harness({ subprocess })
  ref.sessions = sessions
  await collect(adapter, options)
  assert.deepEqual(deliveredAtSpawn, ['m1'], 'spawn 时投递记录必须已落盘')
})

test('history cursor：pendingMessages 纯函数契约（id 优先，缺 id 用内容哈希）', () => {
  const withIds = pendingMessages([{ role: 'user', id: 'a', content: 'x' }, { role: 'user', id: 'b', content: 'y' }], ['a'])
  assert.deepEqual(withIds, [{ id: 'b', text: 'y' }])
  const hashed1 = pendingMessages([{ role: 'user', content: 'same' }], [])
  const hashed2 = pendingMessages([{ role: 'user', content: 'same' }], [])
  assert.equal(hashed1.length, 1)
  assert.equal(hashed1[0].id, hashed2[0].id, '同一内容必须得到稳定 id')
  assert.deepEqual(pendingMessages([{ role: 'assistant', content: 'x' }], []), [])
  assert.throws(() => pendingMessages([{ role: 'user', id: 'c', content: [{ type: 'image', data: 'x' }] }], []), /text messages only/)
})

// ── H. 会话归属校验 ──────────────────────────────────────────────────────────

test('归属：非子代理会话 / 缺 parentSession / isSeeded / cli 不匹配 一律拒绝', async () => {
  const { subprocess } = makeSubprocess()
  const cases = [
    ['origin 不是 subagent', { origin: undefined }],
    ['parentSession 不匹配', { parentSession: 'other-parent' }],
    ['fork 种子会话', { isSeeded: true }],
  ]
  for (const [label, header] of cases) {
    const sessions = makeSessions({ 'child-1': record() })
    const agents = new Map([['child-1', makeChildAgent('child-1', { subprocess, header })]])
    const ctx = { agents: { get: (id) => agents.get(id) }, get: () => subprocess }
    const adapter = createCliAdapter(ctx, makeConfig(), sessions, 'codex')
    await rejectsAsync(() => collect(adapter, { provider: 'apollo-cli-codex', model: 'gpt-5-codex', reasoningEffort: 'low', sessionId: 'child-1', messages: [{ role: 'user', id: 'm', content: 'x' }] }), /reserved/, label)
  }

  const wrongCli = makeSessions({ 'child-1': record({ cli: 'claude' }) })
  const agents = new Map([['child-1', makeChildAgent('child-1', { subprocess })]])
  const ctx = { agents: { get: (id) => agents.get(id) }, get: () => subprocess }
  const adapter = createCliAdapter(ctx, makeConfig(), wrongCli, 'codex')
  await rejectsAsync(() => collect(adapter, { provider: 'apollo-cli-codex', model: 'gpt-5-codex', reasoningEffort: 'low', sessionId: 'child-1', messages: [{ role: 'user', id: 'm', content: 'x' }] }), /reserved/)
})

test('归属：无 sessionId 或未知 session → 拒绝，不 spawn', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const { adapter, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, { ...options, sessionId: undefined }), /reserved/)
  await rejectsAsync(() => collect(adapter, { ...options, sessionId: 'ghost' }), /reserved/)
  assert.equal(spawns.length, 0)
})

test('归属：缺少托管子进程服务 → 明确报错', async () => {
  const { adapter, options } = harness({ subprocess: undefined })
  await rejectsAsync(() => collect(adapter, options), /subprocess/)
})

test('中断前存身份：started=true 但没有 remoteId → 明确要求新建子代理', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const { adapter, options } = harness({ subprocess, state: record({ started: true }) })
  await rejectsAsync(() => collect(adapter, options), /interrupted before its identity was saved/)
  assert.equal(spawns.length, 0)
})

// ── I. dispose ───────────────────────────────────────────────────────────────

test('dispose：未加载的 adapter 拒绝新一轮，且已 dispose 后 stream 直接抛错', async () => {
  const { subprocess } = makeSubprocess()
  const { adapter, options } = harness({ subprocess })
  await adapter.dispose()
  await rejectsAsync(() => collect(adapter, options), /unloaded/)
})

test('dispose：进行中的子进程被 terminate，并等它 settle（不挂死）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  // defer：子进程停在活跃状态，只有 dispose/terminate 才能让它结束。
  scriptNext(subprocess, { defer: true })
  const { adapter, sessions, options } = harness({ subprocess })
  // 记录在途写入：dispose 返回后不得还有未结束的 put。
  const writeIntervals = []
  const originalPut = sessions.put.bind(sessions)
  sessions.put = async (value) => {
    const started = { value, open: true }
    writeIntervals.push(started)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      return await originalPut(value)
    } finally {
      started.open = false
    }
  }
  const pending = collect(adapter, options)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawns.length, 1, '应已 spawn 一个子进程')

  const disposing = adapter.dispose()
  await disposing

  assert.equal(spawns[0].terminateCalls > 0, true, 'dispose 必须 terminate 活跃句柄')
  assert.equal(spawns[0].stdoutEnded, true, 'terminate 必须结束 stdout（真实 managed service 语义）')
  assert.equal(spawns[0].exited, true, 'dispose 返回前 handle 必须已经 exit（done settle）')
  assert.deepEqual(spawns[0].doneSettledWith, { exitCode: 0, signal: null }, 'done 必须以真实 SubprocessOutcome 收场')
  const stillOpen = writeIntervals.filter((interval) => interval.open)
  assert.deepEqual(stillOpen, [], 'dispose 返回后不得存在在途写入')

  // 新契约：dispose 立刻 abort lifetime，因此被中断的轮次是 rejection（不是「还在 pending」）。
  await assert.rejects(() => pending, /Apollo CLI adapter unloaded/)
})

// ── J. lifetime signal / settle 排空 / pre-spawn rollback ────────────────────

test('lifetime：传给 spawn 的是 options.signal 与 adapter lifetime 的 fused signal', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const controller = new AbortController()
  const { adapter, options } = harness({ subprocess, generate: { signal: controller.signal } })
  await collect(adapter, options)
  const specSignal = spawns[0].spec.signal
  assert.notEqual(specSignal, controller.signal, '必须是 fused signal，而不是调用方的 signal')
  controller.abort()
  assert.equal(specSignal.aborted, true, '调用方中断必须传递到子进程 signal')
})

test('dispose：abort lifetime 使在跑的一轮以错误收场，并在返回前等 settling（不挂死）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { defer: true })
  const { adapter, options } = harness({ subprocess })
  const pending = collect(adapter, options).catch((error) => error)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawns.length, 1)
  await adapter.dispose()
  assert.equal(spawns[0].spec.signal.aborted, true, 'dispose 必须 abort lifetime')
  const outcome = await pending
  assert.equal(outcome instanceof Error, true, '被 unload 的轮次必须以错误收场')
  assert.match(outcome.message, /unloaded/)
})

test('dispose：等 settling —— 即使此时投递的 KV put 还没完成', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { defer: true })
  const { adapter, sessions, options } = harness({ subprocess })
  let releaseHold
  const hold = new Promise((resolve) => { releaseHold = resolve })
  const originalPut = sessions.put.bind(sessions)
  let held = false
  sessions.put = async (value) => {
    if (!held) {
      held = true
      await hold
    }
    return originalPut(value)
  }
  const pending = collect(adapter, options).catch((error) => error)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(held, true, '第一轮的投递 put 应已进入在途状态')
  assert.equal(spawns.length, 0, 'put 在途时还不该 spawn')
  let disposeSettled = false
  const disposing = adapter.dispose().then(() => { disposeSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disposeSettled, false, 'dispose 必须等待仍在途的 settling')
  releaseHold()
  await disposing
  assert.equal(disposeSettled, true)
  await pending
})

test('rollback：spawn 同步抛出 → 恢复投递前 state（started/delivered 回滚），下一轮可重试', async () => {
  const { subprocess } = makeSubprocess()
  const boom = Object.assign(new Error('spawn refused'), { code: 'ENOENT' })
  subprocess.spawn = () => { throw boom }
  const { adapter, sessions, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, options), /spawn refused/)
  const after = sessions.get('child-1')
  assert.equal(after.started, false, '没有发布进程时必须回滚 started')
  assert.deepEqual(after.delivered, [], '没有发布进程时必须回滚 delivered（否则首条消息永久丢失）')

  const { subprocess: retrySubprocess, spawns } = makeSubprocess()
  scriptNext(retrySubprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  const retrySessions = makeSessions({ 'child-1': record() })
  const agents = new Map([['child-1', makeChildAgent('child-1', { subprocess: retrySubprocess })]])
  const retryAdapter = createCliAdapter({ agents: { get: (id) => agents.get(id) }, get: () => retrySubprocess }, makeConfig(), retrySessions, 'codex')
  const chunks = await collect(retryAdapter, options)
  assert.equal(chunks.at(-1).type, 'finish', '回滚后重试必须真的把消息发出去')
  assert.equal(spawns.length, 1)
})

test('rollback：put 之后、spawn 之前被取消 → 回滚 state，下一轮可重试', async () => {
  const { subprocess, spawns } = makeSubprocess()
  const controller = new AbortController()
  const { adapter, sessions, options } = harness({ subprocess, generate: { signal: controller.signal } })
  const originalPut = sessions.put.bind(sessions)
  sessions.put = async (value) => {
    await originalPut(value)
    controller.abort()
    return undefined
  }
  await rejectsAsync(() => collect(adapter, options), (error) => error.name === 'AbortError')
  assert.equal(spawns.length, 0, '取消后不得 spawn')
  const after = sessions.get('child-1')
  assert.equal(after.started, false, '取消必须回滚 started')
  assert.deepEqual(after.delivered, [], '取消必须回滚 delivered')
  await rejectsAsync(() => collect(adapter, options), (error) => error.name === 'AbortError')
})

test('rollback：缺 subprocess 服务 → 可修复（回滚 state），装上服务后同一会话可重试', async () => {
  const { subprocess } = makeSubprocess()
  const broken = harness({ subprocess, withSubprocess: false })
  scriptNext(subprocess, { events: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed', usage: {} }] })
  await rejectsAsync(() => collect(broken.adapter, broken.options), /managed subprocess service/)
  const after = broken.sessions.get('child-1')
  assert.equal(after.started, false, '缺服务时必须回滚 started（否则该子代理永久报 interrupted）')
  assert.deepEqual(after.delivered, [])

  const agents = new Map([['child-1', makeChildAgent('child-1', { subprocess })]])
  const retryAdapter = createCliAdapter({ agents: { get: (id) => agents.get(id) }, get: () => subprocess }, makeConfig(), broken.sessions, 'codex')
  const chunks = await collect(retryAdapter, broken.options)
  assert.equal(chunks.at(-1).type, 'finish', '修复后同一会话必须能重试')
})

test('不回退语义：进程已成功 spawn 但没拿到 ID → 仍然要求新建子代理（不自动重跑）', async () => {
  const { subprocess, spawns } = makeSubprocess()
  scriptNext(subprocess, { events: [{ type: 'item.completed', item: { type: 'agent_message', text: 'no id here' } }, { type: 'turn.completed', usage: {} }] })
  const { adapter, sessions, options } = harness({ subprocess })
  await rejectsAsync(() => collect(adapter, options), /without a resumable session id/)
  assert.equal(spawns.length, 1, '不得自动重跑一个已经起过的进程')
  const after = sessions.get('child-1')
  assert.equal(after.started, true, '进程真的起过 → started 保留')
  assert.deepEqual(after.delivered, ['m1'], '进程真的起过 → 投递记录保留')
  const nextTurn = { ...options, messages: [{ role: 'user', id: 'm2', content: 'again' }] }
  await rejectsAsync(() => collect(adapter, nextTurn), /interrupted before its identity was saved/)
})

test('配置诊断：模型没有配置 reasoning efforts → resolveModel 给出可操作错误', async () => {
  const { subprocess } = makeSubprocess()
  const config = makeConfig({ codex: { models: [{ id: 'gpt-5-codex', efforts: [], defaultEffort: '' }] } })
  const { adapter } = harness({ subprocess, config })
  await assert.rejects(() => adapter.resolveModel('apollo-cli-codex', 'gpt-5-codex'), /no allowed reasoning efforts/)
})

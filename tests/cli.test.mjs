/**
 * CLI 适配层测试：JSONL 切行、argv 精确构造、两个 backend 的事件语义。
 *
 * 为什么需要：这三个模块的价值全在「细节必须与真实 CLI 一致」——argv 少一个 `-a never`
 * 就会在无人值守管道里挂死，root 选项挪到 `exec` 之后续接就会失效，把 reasoning 当正文
 * 就会把思考过程写进会话。这些错误本地跑一次真实 CLI 才看得见，代价高且不稳定，所以把
 * **实测抓到的真实事件样本**固化成 fixture 在这里断言（语义等价于真机，成本为 0）。
 *
 * 真实样本来源（codex-cli 0.162.1 / Claude Code 2.1.300，各两轮：新建 + 续接）：
 * - codex：`codex -p meliai -s read-only -a never -C <cwd> exec --json --skip-git-repo-check -c 'model_reasoning_effort="low"' -`
 * - claude：`claude --print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --effort low`
 * 运行：node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { MAX_ERROR_CHARS, readJsonLines, sanitizeError } from '../src/cli/jsonl.js'
import { buildCommand as buildCodexCommand, createParser as createCodexParser } from '../src/cli/codex.js'
import { buildCommand as buildClaudeCommand, createParser as createClaudeParser } from '../src/cli/claude.js'

/** 把一组 chunk 喂进 readJsonLines，收齐所有产出的事件。 */
async function collect(chunks, options) {
  const out = []
  for await (const value of readJsonLines(Readable.from(chunks), options)) out.push(value)
  return out
}

/** 迭代一个生成器以触发其函数体（async generator 在首次 next() 前不执行）。 */
async function drain(readable, options) {
  for await (const _ of readJsonLines(readable, options)) void _
}

/** 依次 push 一批事件，收集所有非 undefined 的动作。 */
function feed(parser, events) {
  const actions = []
  for (const event of events) {
    const action = parser.push(event)
    if (action !== undefined) actions.push(action)
  }
  return actions
}

// ─────────────────────────── jsonl：切行与解码 ───────────────────────────

test('readJsonLines: 半行、chunk 内多行、无换行尾行', async () => {
  const chunks = [Buffer.from('{"a":1}\n{"b"'), Buffer.from(':2}\n{"c":3}')]
  assert.deepEqual(await collect(chunks), [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('readJsonLines: CRLF 与空白行被跳过，不产生伪事件', async () => {
  assert.deepEqual(await collect([Buffer.from('{"a":1}\r\n\r\n  \r\n{"b":2}\r\n')]), [{ a: 1 }, { b: 2 }])
})

test('readJsonLines: 多字节字符跨 chunk 切断也不乱码', async () => {
  const line = Buffer.from('{"text":"对话结束"}\n')
  const cut = line.indexOf(Buffer.from('对')) + 1 // 切在「对」的 3 字节中间
  assert.deepEqual(await collect([line.subarray(0, cut), line.subarray(cut)]), [{ text: '对话结束' }])

  const emoji = Buffer.from('{"emoji":"🙂"}\n')
  const at = emoji.indexOf(Buffer.from('🙂')) + 2 // 切在 4 字节代理对中间
  const parsed = await collect([emoji.subarray(0, at), emoji.subarray(at)])
  assert.deepEqual(parsed, [{ emoji: '🙂' }])
  assert.ok(!JSON.stringify(parsed).includes('\uFFFD'))
})

test('readJsonLines: 非法 JSON 抛 SyntaxError 且带行号，不静默跳过', async () => {
  await assert.rejects(
    () => collect([Buffer.from('{"a":1}\nnot json\n{"b":2}\n')]),
    (error) => {
      assert.ok(error instanceof SyntaxError, `期望 SyntaxError，收到 ${error}`)
      assert.match(error.message, /第 2 行/)
      return true
    },
  )
  // 尾行同样不放行：截断的流必须暴露出来。
  await assert.rejects(() => collect([Buffer.from('{"a":1}\n{"b":')]), SyntaxError)
})

test('readJsonLines: 超长行抛 RangeError（未换行增长 + 完整长行两条路径）', async () => {
  await assert.rejects(() => collect([Buffer.from('x'.repeat(64))], { maxLineBytes: 16 }), RangeError)
  await assert.rejects(() => collect([Buffer.from(`${'x'.repeat(64)}\n`)], { maxLineBytes: 16 }), RangeError)
  // 恰好等于上限的行必须放行（边界不算超限）。
  const line = `{"a":"${'x'.repeat(8)}"}`
  assert.deepEqual(await collect([Buffer.from(`${line}\n`)], { maxLineBytes: Buffer.byteLength(line) }), [
    { a: 'xxxxxxxx' },
  ])
})

test('readJsonLines: string chunk 与参数校验', async () => {
  assert.deepEqual(await collect(['{"a":1}\n{"b":2}\n']), [{ a: 1 }, { b: 2 }])
  await assert.rejects(() => drain(null), TypeError)
  await assert.rejects(() => drain(Readable.from([]), { maxLineBytes: 0 }), TypeError)
  await assert.rejects(() => drain(Readable.from([]), { maxLineBytes: 1.5 }), TypeError)
})

// ─────────────────────────── 共享：错误去敏/有界 ───────────────────────────

test('sanitizeError: 压成单行、抹掉凭据形状、按上限截断', () => {
  assert.equal(sanitizeError(new Error('boom\nboom\tboom')), 'boom boom boom')
  assert.equal(sanitizeError(undefined), '未知错误')
  assert.equal(sanitizeError({ code: 42 }), '{"code":42}')
  for (const secret of [
    'Authorization: Bearer abcdefghijklmnop',
    'api_key=abcdefghijklmnop',
    'token: ghp_abcdefghijklmnopqrst',
    'sk-abcdefghijklmnopqrstuvwx',
    'x'.repeat(80),
  ]) {
    const cleaned = sanitizeError(`request failed: ${secret}`)
    assert.ok(!cleaned.includes(secret), `未去敏：${cleaned}`)
  }
  const long = sanitizeError('word '.repeat(400))
  assert.ok(long.length <= MAX_ERROR_CHARS + 1, `未截断：${long.length}`)
})

// ─────────────────────────── codex：argv 构造 ───────────────────────────

test('codex buildCommand: 完整 argv 精确匹配（root 选项在 exec 之前）', () => {
  const result = buildCodexCommand({
    cwd: '/work',
    model: 'gpt-5-codex',
    effort: 'high',
    profile: 'meliai',
    permissionMode: 'read-only',
    prompt: 'hi',
  })
  assert.deepEqual(Object.keys(result).sort(), ['argv', 'input'])
  assert.deepEqual(result.argv, [
    'codex',
    '-p',
    'meliai',
    '-s',
    'read-only',
    '-a',
    'never',
    '-C',
    '/work',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-m',
    'gpt-5-codex',
    '-c',
    'model_reasoning_effort="high"',
    '-',
  ])
  // 双引号必须是 argv 里的字面量：argv 不经 shell 解释。
  assert.ok(result.argv.includes('model_reasoning_effort="high"'))
  assert.equal(result.input, 'hi')
})

test('codex buildCommand: 续接时 -p/-s/-a/-C 全部留在 exec 之前（exec resume 不接受它们）', () => {
  const { argv, input } = buildCodexCommand({
    cwd: '/work',
    model: 'gpt-5-codex',
    effort: 'low',
    profile: 'meliai',
    permissionMode: 'read-only',
    remoteId: '01a14357-1204-7031-b83d-68581050d0d7',
    prompt: 'next turn',
  })
  const execAt = argv.indexOf('exec')
  for (const flag of ['-p', '-s', '-a', '-C']) {
    assert.ok(argv.indexOf(flag) !== -1, `缺少 ${flag}`)
    assert.ok(argv.indexOf(flag) < execAt, `${flag} 必须位于 exec 之前`)
  }
  assert.deepEqual(argv.slice(execAt, execAt + 3), ['exec', 'resume', '01a14357-1204-7031-b83d-68581050d0d7'])
  assert.deepEqual(argv.slice(execAt + 3), ['--json', '--skip-git-repo-check', '-m', 'gpt-5-codex', '-c', 'model_reasoning_effort="low"', '-'])
  assert.equal(argv.at(-1), '-')
  assert.equal(input, 'next turn')
})

test('codex buildCommand: 最小调用只带非交互与 stdin 约定', () => {
  assert.deepEqual(buildCodexCommand({ prompt: '' }), {
    argv: ['codex', '-a', 'never', 'exec', '--json', '--skip-git-repo-check', '-'],
    input: '',
  })
})

test('codex buildCommand: 非法取值在构造期就抛 TypeError', () => {
  // exec resume 不接受 -s，因此不支持的 sandbox 模式必须提前拦下。
  assert.throws(() => buildCodexCommand({ permissionMode: 'bypassPermissions', prompt: 'x' }), TypeError)
  // id 是位置参数：前导 '-' 会被当成选项。
  assert.throws(() => buildCodexCommand({ remoteId: '--json', prompt: 'x' }), TypeError)
  // effort 会被拼进 TOML 字面量，引号/分号一律拒绝。
  assert.throws(() => buildCodexCommand({ effort: 'high"; rm -rf /', prompt: 'x' }), TypeError)
  assert.throws(() => buildCodexCommand({ model: '', prompt: 'x' }), TypeError)
  assert.throws(() => buildCodexCommand({ prompt: 42 }), TypeError)
  assert.throws(() => buildCodexCommand({ cwd: 'bad\ncwd', prompt: 'x' }), TypeError)
})

// ─────────────────────────── claude：argv 构造 ───────────────────────────

test('claude buildCommand: argv 精确匹配，prompt 只走 stdin', () => {
  const result = buildClaudeCommand({ cwd: '/work', model: 'sonnet', effort: 'low', permissionMode: 'plan', prompt: 'hi' })
  assert.deepEqual(Object.keys(result).sort(), ['argv', 'input'])
  assert.deepEqual(result.argv, [
    'claude',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--permission-mode',
    'plan',
    '--permission-prompts',
    'none',
  ])
  assert.equal(result.input, 'hi')
  // 传了就不是可续接会话了，绝不能出现在我们的 argv 里。
  assert.ok(!result.argv.includes('--no-session-persistence'))
  assert.ok(!result.argv.some((arg) => arg.includes('hi')), 'prompt 不应进入 argv')
})

test('claude buildCommand: 续接追加 --resume，且忽略 cwd/profile', () => {
  const { argv } = buildClaudeCommand({
    cwd: '/work',
    profile: 'meliai',
    permissionMode: 'dontAsk',
    remoteId: 'c6ffb5b4-60ea-4c80-bb76-23d6a1c04118',
    prompt: 'next',
  })
  assert.deepEqual(argv.slice(-2), ['--resume', 'c6ffb5b4-60ea-4c80-bb76-23d6a1c04118'])
  assert.ok(argv.includes('--permission-prompts'))
  // claude 没有 cwd 选项（--add-dir 只是追加可写目录），profile 也是 codex 专属。
  assert.ok(!argv.includes('/work'))
  assert.ok(!argv.includes('meliai'))
})

test('claude buildCommand: 非法取值在构造期就抛 TypeError', () => {
  // 'read-only' 是 codex 的 sandbox 取值，不是 claude 的 permission-mode。
  assert.throws(() => buildClaudeCommand({ permissionMode: 'read-only', prompt: 'x' }), TypeError)
  assert.throws(() => buildClaudeCommand({ remoteId: '-x', prompt: 'x' }), TypeError)
  assert.throws(() => buildClaudeCommand({ prompt: undefined }), TypeError)
})

// ─────────────────────────── codex：事件语义 ───────────────────────────

/** 真实首轮 codex 事件（含实测的配置告警 item 与 thread_id）。 */
const CODEX_RUN = [
  { type: 'thread.started', thread_id: '01a14357-1204-7031-b83d-68581050d0d7' },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'error',
      message: 'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'error',
      message: 'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.',
    },
  },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'APOLLO_CLI_PROTOCOL_OK' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 18572,
      cached_input_tokens: 4096,
      cache_write_input_tokens: 0,
      output_tokens: 11,
      reasoning_output_tokens: 0,
    },
  },
]

test('codex parser: 真实事件序列的每个语义动作', () => {
  const parser = createCodexParser()
  assert.deepEqual(parser.push(CODEX_RUN[0]), { remoteId: '01a14357-1204-7031-b83d-68581050d0d7' })
  // 第二次回报同一个 thread 必须沉默，父只落一次 KV。
  assert.equal(parser.push(CODEX_RUN[0]), undefined)

  // 配置告警：信息性 error，但**不**意味着回合失败。
  const warning = parser.push(CODEX_RUN[1])
  assert.match(warning.error, /unrecognized configuration settings/)
  assert.equal(warning.completed, undefined)

  assert.equal(parser.push(CODEX_RUN[3]), undefined) // turn.started
  assert.deepEqual(parser.push(CODEX_RUN[4]), { text: 'APOLLO_CLI_PROTOCOL_OK' })

  // usage 归一：inputTokens 扣掉缓存，totalTokens 还原完整调用量，为 0 的可选字段省略。
  assert.deepEqual(parser.push(CODEX_RUN[5]), {
    usage: { inputTokens: 14476, outputTokens: 11, totalTokens: 18583, cacheReadTokens: 4096 },
    completed: true,
  })

  assert.deepEqual(parser.finish(), {
    text: 'APOLLO_CLI_PROTOCOL_OK',
    remoteId: '01a14357-1204-7031-b83d-68581050d0d7',
    usage: { inputTokens: 14476, outputTokens: 11, totalTokens: 18583, cacheReadTokens: 4096 },
  })
  // finish 幂等，不改变状态。
  assert.deepEqual(parser.finish(), parser.finish())
})

test('codex parser: reasoning/tool 事件绝不产出正文', () => {
  const parser = createCodexParser()
  for (const item of [
    { type: 'reasoning', text: 'let me think about this' },
    { type: 'command_execution', command: 'ls -la' },
    { type: 'file_change', path: 'a.js' },
    { type: 'mcp_tool_call', tool: 'x' },
  ]) {
    assert.equal(parser.push({ type: 'item.completed', item }), undefined, `${item.type} 不应产出动作`)
  }
  assert.equal(parser.push({ type: 'item.updated', item: { type: 'reasoning', text: 'more' } }), undefined)
  parser.push({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } })
  assert.equal(parser.finish().text, '')
})

test('codex parser: 后到的 agent_message 覆盖先到的', () => {
  const parser = createCodexParser()
  parser.push({ type: 'item.completed', item: { type: 'agent_message', text: '先说一句' } })
  parser.push({ type: 'item.completed', item: { type: 'agent_message', text: '最终答复' } })
  parser.push({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(parser.finish().text, '最终答复')
})

test('codex parser: 失败与缺完成标志都让 finish 抛错', () => {
  const failed = createCodexParser()
  failed.push({ type: 'thread.started', thread_id: 't1' })
  const action = failed.push({ type: 'turn.failed', error: { message: 'stream disconnected' } })
  assert.match(action.error, /stream disconnected/)
  assert.throws(() => failed.finish(), /codex 回合失败/)

  const topLevel = createCodexParser()
  topLevel.push({ type: 'error', message: 'unexpected status 401' })
  assert.throws(() => topLevel.finish(), /codex 回合失败/)

  // 只有「回合正常结束」不等于成功：没有 turn.completed 就必须抛。
  const truncated = createCodexParser()
  truncated.push({ type: 'item.completed', item: { type: 'agent_message', text: '半截' } })
  assert.throws(() => truncated.finish(), /turn\.completed/)
})

test('codex parser: 非事件输入被忽略，错误文本有界', () => {
  const parser = createCodexParser()
  for (const value of [undefined, null, 'string', 42, []]) assert.equal(parser.push(value), undefined)
  const action = parser.push({ type: 'item.completed', item: { type: 'error', message: 'sk-abcdefghijklmnopqrstuv ' * 1 + 'y'.repeat(1200) } })
  assert.ok(action.error.length <= MAX_ERROR_CHARS + 1)
  assert.ok(!action.error.includes('sk-abcdefghijklmnopqrstuv'))
})

// ─────────────────────────── claude：事件语义 ───────────────────────────

/** 真实首轮 claude 事件（hook_* 早于 init，两者都带 session_id）。 */
const CLAUDE_SESSION_ID = 'c6ffb5b4-60ea-4c80-bb76-23d6a1c04118'
const CLAUDE_RUN = [
  { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup', session_id: CLAUDE_SESSION_ID },
  { type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', exit_code: 0, session_id: CLAUDE_SESSION_ID },
  { type: 'system', subtype: 'init', cwd: '/private/tmp', model: 'claude-sonnet-5', permissionMode: 'plan', session_id: CLAUDE_SESSION_ID },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: CLAUDE_SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'text', text: 'APOLLO_CLI_PROTOCOL_OK' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    result: 'APOLLO_CLI_PROTOCOL_OK',
    session_id: CLAUDE_SESSION_ID,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 49186,
      cache_read_input_tokens: 0,
      output_tokens: 104,
      output_tokens_details: { thinking_tokens: 0 },
    },
  },
]

test('claude parser: 真实事件序列的每个语义动作', () => {
  const parser = createClaudeParser()
  // remoteId 在第一个带 session_id 的 system 事件（hook_started，早于 init）就回报。
  assert.deepEqual(parser.push(CLAUDE_RUN[0]), { remoteId: CLAUDE_SESSION_ID })
  assert.equal(parser.push(CLAUDE_RUN[1]), undefined)
  assert.equal(parser.push(CLAUDE_RUN[2]), undefined)
  assert.deepEqual(parser.push(CLAUDE_RUN[3]), { text: 'APOLLO_CLI_PROTOCOL_OK' })
  assert.deepEqual(parser.push(CLAUDE_RUN[4]), {
    usage: { inputTokens: 2, outputTokens: 104, totalTokens: 49292, cacheWriteTokens: 49186 },
    completed: true,
    text: 'APOLLO_CLI_PROTOCOL_OK',
  })
  assert.deepEqual(parser.finish(), {
    text: 'APOLLO_CLI_PROTOCOL_OK',
    remoteId: CLAUDE_SESSION_ID,
    usage: { inputTokens: 2, outputTokens: 104, totalTokens: 49292, cacheWriteTokens: 49186 },
  })
  assert.deepEqual(parser.finish(), parser.finish())
})

test('claude parser: tool_use/thinking/子代理消息都不计入正文', () => {
  const parser = createClaudeParser()
  const cases = [
    { message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] } },
    { message: { content: [{ type: 'thinking', thinking: '思考中' }] } },
    { parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: '子代理的话' }] } },
    { message: { content: [] } },
    { message: {} },
    { message: null },
  ]
  for (const extra of cases) {
    assert.equal(parser.push({ type: 'assistant', parent_tool_use_id: null, ...extra }), undefined)
  }
  // 混合内容只取 text 块；user（工具结果）事件也忽略。
  assert.deepEqual(
    parser.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '答复' }, { type: 'tool_use', name: 'Read' }] },
    }),
    { text: '答复' },
  )
  assert.equal(parser.push({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), undefined)

  parser.push({ type: 'result', subtype: 'success', is_error: false, result: '答复' })
  assert.equal(parser.finish().text, '答复')
})

test('claude parser: 多段 assistant 文本取最后一条，result 为权威值', () => {
  const parser = createClaudeParser()
  parser.push({ type: 'assistant', message: { content: [{ type: 'text', text: '我先看看文件' }] } })
  parser.push({ type: 'assistant', message: { content: [{ type: 'text', text: '结论：没问题' }] } })
  // result 文本优先于累积值（provider 的权威收尾）。
  parser.push({ type: 'result', subtype: 'success', is_error: false, result: '结论：没问题。', usage: { input_tokens: 1, output_tokens: 1 } })
  assert.equal(parser.finish().text, '结论：没问题。')
})

test('claude parser: 失败 result 与缺 result 都让 finish 抛错', () => {
  const failed = createClaudeParser()
  failed.push({ type: 'system', subtype: 'init', session_id: CLAUDE_SESSION_ID })
  const action = failed.push({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'hit max turns', usage: { input_tokens: 5, output_tokens: 5 } })
  assert.match(action.error, /error_max_turns/)
  assert.equal(action.completed, undefined)
  assert.throws(() => failed.finish(), /claude 回合失败/)

  // subtype 为 success 但 is_error 为真：不能算成功。
  const contradictory = createClaudeParser()
  contradictory.push({ type: 'result', subtype: 'success', is_error: true, result: 'boom' })
  assert.throws(() => contradictory.finish(), /claude 回合失败/)

  const quota = createClaudeParser()
  quota.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 403 credit allowance exhausted'] })
  assert.throws(() => quota.finish(), /403 credit allowance exhausted/)

  // 完全没有 result（进程被杀/管道断了）也必须抛。
  const truncated = createClaudeParser()
  truncated.push({ type: 'assistant', message: { content: [{ type: 'text', text: '半截' }] } })
  assert.throws(() => truncated.finish(), /result/)
})

test('claude parser: 非事件输入被忽略，失败错误文本有界且去敏', () => {
  const parser = createClaudeParser()
  for (const value of [undefined, null, 'string', 42]) assert.equal(parser.push(value), undefined)
  const action = parser.push({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    api_error_status: 401,
    result: `invalid api key sk-abcdefghijklmnopqrstuv ${'z'.repeat(1200)}`,
  })
  assert.ok(action.error.length <= MAX_ERROR_CHARS + 1)
  assert.ok(!action.error.includes('sk-abcdefghijklmnopqrstuv'))
  assert.match(action.error, /api_error_status=401/)
})

/**
 * CLI 适配层的公共底座：JSONL 切行 + 事件校验/去敏/用量归一。
 *
 * 为什么需要：两个 CLI 都按「一行一个 JSON 事件」输出，而 stdout 的分块边界与行边界
 * 毫无关系——一个 chunk 可能含半行、多行，或正好切在某个 UTF-8 多字节字符中间。
 * 切行只在这里做一次，两个 backend 就只需关心事件语义。
 *
 * 契约：
 * - 只跳过**空白行**（CLI 收尾换行必然切出一个空串）；非空但非法 JSON 一律抛
 *   SyntaxError——静默丢弃会让调用方把「畸形流」误判成「回合正常结束」。
 * - Buffer 走 StringDecoder，跨 chunk 多字节字符不乱码；单行超 `maxLineBytes` 抛 RangeError。
 * - 只读一个流：stderr 由父 adapter 自己收集。
 *
 * 顶层只依赖 node 内置模块，不 import 任何 DSH 包——子进程生命周期归父 adapter。
 */

import { StringDecoder } from 'node:string_decoder'

/** 单行上限 1 MiB：CLI 事件远小于此，超过即视为协议被破坏。 */
export const DEFAULT_MAX_LINE_BYTES = 1048576

/** 错误文本上限：既保证日志有界，也避免把大段原始输出回灌进会话。 */
export const MAX_ERROR_CHARS = 400

/** 空白行没有 JSON 值可产出，用哨兵与「合法的 null 事件」区分。 */
const SKIP = Symbol('jsonl.skip')

/**
 * 把可读流切成 JSON 行并逐个产出解析后的值。
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>} readable - 子进程 stdout（或任意异步可迭代）。
 * @param {{maxLineBytes?: number}} [options] - 单行字节上限。
 * @returns {AsyncGenerator<unknown>} 解析后的事件，按流序产出。
 */
export async function* readJsonLines(readable, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new TypeError(`readJsonLines: maxLineBytes 必须是正的安全整数，收到 ${maxLineBytes}`)
  }
  if (readable === null || typeof readable !== 'object' || typeof readable[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('readJsonLines: readable 必须是产出 Buffer 或 string 的异步可迭代对象')
  }
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let lineNumber = 0
  for await (const chunk of readable) {
    // string chunk 说明上游已解码：先冲掉解码器里的残余字节，再直接拼接。
    pending += typeof chunk === 'string' ? decoder.end() + chunk : decoder.write(chunk)
    let index = pending.indexOf('\n')
    while (index !== -1) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      lineNumber += 1
      const value = parseLine(line, lineNumber, maxLineBytes)
      if (value !== SKIP) yield value
      index = pending.indexOf('\n')
    }
    // 还没等到换行就已经超限：不必等到整行结束才报错。
    if (Buffer.byteLength(pending) > maxLineBytes) {
      throw new RangeError(`readJsonLines: 第 ${lineNumber + 1} 行超过 maxLineBytes（${maxLineBytes}）`)
    }
  }
  // 尾行：流结束时最后一行可能没有换行符，仍需产出。
  pending += decoder.end()
  if (pending !== '') {
    lineNumber += 1
    const value = parseLine(pending, lineNumber, maxLineBytes)
    if (value !== SKIP) yield value
  }
}

/** 解析一行：空白行返回哨兵，非法 JSON 抛 SyntaxError（带行号）。 */
function parseLine(line, lineNumber, maxLineBytes) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.trim() === '') return SKIP
  if (Buffer.byteLength(text) > maxLineBytes) {
    throw new RangeError(`readJsonLines: 第 ${lineNumber} 行超过 maxLineBytes（${maxLineBytes}）`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new SyntaxError(`readJsonLines: 第 ${lineNumber} 行不是合法 JSON：${error.message}`)
  }
}

/**
 * 归一成 DSH TokenUsage（契约见 dsh-llm 的 `TokenUsage`：`inputTokens` / `outputTokens` /
 * `totalTokens?` / `cacheReadTokens?` / `cacheWriteTokens?` / `reasoningTokens?`）。
 *
 * 与 dsh-llm-pi-ai 同约定：`inputTokens` **不含**缓存命中/写入；
 * `totalTokens = input + output + cacheRead + cacheWrite`；为 0 的可选字段省略。
 * 非法数字按 0 处理而不抛错——用量异常不该毁掉一整轮。
 *
 * @param {{inputTokens?: unknown, outputTokens?: unknown, cacheReadTokens?: unknown, cacheWriteTokens?: unknown, reasoningTokens?: unknown}} raw
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number}}
 */
export function normalizeUsage({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = {}) {
  const input = count(inputTokens)
  const output = count(outputTokens)
  const cacheRead = count(cacheReadTokens)
  const cacheWrite = count(cacheWriteTokens)
  const reasoning = count(reasoningTokens)
  const usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
  }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/** 取一个非负有限数；其余（undefined/NaN/负数/字符串）一律折成 0。 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 去敏 + 有界的错误文本：抹掉凭据形状、压掉控制字符/换行、按字符数截断。 */
const REDACTIONS = [
  // Bearer / Authorization 头
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // 显式键名后的取值（api_key=、token:、password 等）
  [/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|token)(\s*[":=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, '$1$2[redacted]'],
  // 常见前缀凭据
  [/\b(sk|rk|pk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|xapp|glpat|AIza|AKIA)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]'],
  // 通用长随机串（JWT / 裸密钥 / 长 base64）
  [/[A-Za-z0-9+/=_-]{64,}/g, '[redacted]'],
]

/** 去掉 NUL 与其余 C0/C1 控制字符（含换行），保证错误是单行文本。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g

/**
 * 把任意错误载荷压成一条可直接进日志/会话文本的安全字符串。
 * @param {unknown} value - 原始错误（字符串、Error、事件字段……）。
 * @returns {string} 去敏且不超过 {@link MAX_ERROR_CHARS} 的单行文本。
 */
export function sanitizeError(value) {
  let text = typeof value === 'string' ? value : value instanceof Error ? value.message : safeStringify(value)
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return '未知错误'
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

/**
 * 兜底序列化：循环引用、undefined、函数等都不该让解析器崩掉，
 * 也绝不能让 `undefined` 变成字面量字符串 "undefined" 混进错误文本。
 */
function safeStringify(value) {
  if (value === undefined || value === null) return ''
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** 校验「非空字符串且不含控制字符」的 argv 取值。argv 不经 shell 解释，只需拦空值与换行。 */
export function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} 必须是非空字符串，收到 ${describe(value)}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} 不能包含控制字符`)
  }
  return value
}

/**
 * 校验**位置参数**取值（如 `codex exec resume <id>`）。
 * 额外拒绝前导 `-`：否则一个形如 `--json` 的 id 会被 CLI 当成选项解析。
 */
export function requireId(value, name) {
  const text = requireText(value, name)
  if (text.startsWith('-')) {
    throw new TypeError(`${name} 不能以 "-" 开头（会被 CLI 当作选项），收到 ${JSON.stringify(text)}`)
  }
  return text
}

/**
 * 校验 reasoning effort 档位。刻意用严格 token 正则：codex 侧它会被拼进
 * `-c model_reasoning_effort="…"`，绝不能含 `"`、`\` 或空白（等于往 TOML 注入）。
 * 实测取值 codex = minimal/low/medium/high，claude = low/medium/high/xhigh/max；
 * 不做枚举硬编码，以免上游加档位就炸。
 */
export function requireEffort(value, name = 'effort') {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new TypeError(`${name} 必须是形如 low/medium/high/xhigh/max 的档位标识，收到 ${describe(value)}`)
  }
  return value
}

/** 校验枚举型取值，把「CLI 后期才报错」提前成构造期的清晰 TypeError。 */
export function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${name} 必须是 ${allowed.join(' / ')} 之一，收到 ${describe(value)}`)
  }
  return value
}

/** 校验 stdin 正文：只要求是字符串，内容原样透传（可以含换行，空串也合法）。 */
export function requirePrompt(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`prompt 必须是字符串（作为子进程 stdin 正文），收到 ${describe(value)}`)
  }
  return value
}

/** 给报错用的短描述，避免把整个超长 prompt 打进错误里。 */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  return String(value)
}

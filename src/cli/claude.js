/**
 * Claude Code CLI 适配：纯命令构造 + `--print --output-format stream-json` 事件流解析。
 * 只产出 argv 与 stdin 正文并翻译事件；spawn/管道/stderr/中断由父 adapter 的
 * `ctx.subprocess` 掌握（stdin 取 `{data: input}`）。不 import 任何 DSH 包。
 *
 * 实测依据（Claude Code 2.1.300，新建 + `--resume` 各一轮真实跑通）：
 * - `--print` 不给位置参数 prompt 时正文从 stdin 读，所以 argv 里没有 prompt；
 * - `stream-json` 必须配 `--verbose` 才是完整事件流；
 * - `--permission-prompts none` = 没人回答权限提问、会被提问的一律自动拒绝，
 *   正是无人值守管道要的语义（`--permission-mode` 仍决定其余判定）；
 * - 续接用 `--resume <SESSION_ID>`；**不传** `--no-session-persistence`，否则会话
 *   不落盘、下一轮无法续接；
 * - claude **没有** cwd 选项（`--add-dir` 只是追加可写目录），工作目录由进程 cwd
 *   决定，故本模块接受并忽略 `cwd`，交给父 adapter 的 spawn `cwd`；`profile` 是
 *   codex 专属概念，同样忽略。
 *
 * 事件语义：
 * - `system`（hook_started / hook_response / init）都带 `session_id`，且前两者出现在
 *   `init` **之前**——故 remoteId 在「第一个带 session_id 的 system 事件」就回报；
 * - `assistant` → `message.content[]` 里 `type === 'text'` 的块拼成正文；`tool_use` /
 *   `thinking` 块**绝不**当作正文；带 `parent_tool_use_id` 的是子代理消息，也不计入；
 * - `result` → 唯一权威收尾：`subtype === 'success' && is_error !== true` 才算成功；
 *   `result` 字段是最终答复文本（覆盖累积值），`usage` 是整轮用量。
 */

import { normalizeUsage, requireEnum, requireEffort, requireId, requirePrompt, requireText, sanitizeError } from './jsonl.js'

/** `claude --permission-mode` 的实测取值（`claude --help`）。 */
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']

/**
 * 构造一轮 `claude --print` 调用。
 *
 * @param {object} spec
 * @param {string} [spec.executable='claude'] - 可执行名或绝对路径。
 * @param {string} [spec.cwd] - 接受但忽略：claude 无 cwd 选项，请用 spawn 的 cwd。
 * @param {string} [spec.model] - `--model`，别名（sonnet/opus…）或全名。
 * @param {string} [spec.effort] - `--effort`，实测取值 low/medium/high/xhigh/max。
 * @param {string} [spec.profile] - 接受但忽略：codex 专属概念。
 * @param {string} [spec.permissionMode] - `--permission-mode`。
 * @param {string} [spec.remoteId] - 已有 session id 时走 `--resume <id>`。
 * @param {string} spec.prompt - 正文，经 stdin 送入。
 * @returns {{argv: string[], input: string}}
 */
export function buildCommand({ executable = 'claude', model, effort, permissionMode, remoteId, prompt } = {}) {
  const argv = [requireText(executable, 'executable'), '--print', '--output-format', 'stream-json', '--verbose']
  if (model !== undefined) argv.push('--model', requireText(model, 'model'))
  if (effort !== undefined) argv.push('--effort', requireEffort(effort))
  if (permissionMode !== undefined) argv.push('--permission-mode', requireEnum(permissionMode, PERMISSION_MODES, 'permissionMode'))
  // 无人值守：任何权限提问都自动拒绝，而不是挂起等一个永远不会来的回答。
  argv.push('--permission-prompts', 'none')
  if (remoteId !== undefined) argv.push('--resume', requireId(remoteId, 'remoteId'))
  // 正文走 stdin（`--print` 无位置参数时读 stdin），argv 里不出现 prompt。
  return { argv, input: requirePrompt(prompt) }
}

/**
 * 创建一个有状态的 claude 事件解析器（一轮子进程一个）。
 *
 * @returns {{push: (event: unknown) => ({remoteId?: string, text?: string, usage?: object, completed?: boolean, error?: string}|undefined), finish: () => {text: string, remoteId?: string, usage?: object}}}
 */
export function createParser() {
  let remoteId
  let text = ''
  let usage
  let completed = false
  let failure

  /** 失败时优先用 provider 给的错误正文，否则退化成 subtype/api_error_status。 */
  function describeResultFailure(event) {
    const label = typeof event.subtype === 'string' && event.subtype !== '' ? event.subtype : 'error'
    const detail = typeof event.result === 'string' && event.result !== '' ? event.result
      : Array.isArray(event.errors) ? event.errors.filter((item) => typeof item === 'string').slice(0, 3).join('; ') : ''
    const status = event.api_error_status === undefined ? '' : ` (api_error_status=${event.api_error_status})`
    return sanitizeError(detail === '' ? `claude result ${label}${status}` : `claude result ${label}${status}: ${detail}`)
  }

  return {
    /**
     * 投喂一个已解析的事件。
     * @param {unknown} event - `readJsonLines` 产出的单个事件。
     * @returns {{remoteId?: string, text?: string, usage?: object, completed?: boolean, error?: string}|undefined}
     *   本次事件产生的动作；无动作返回 undefined。
     *   `error` 是**信息性**的：只有 `finish()` 抛错才代表这一轮失败。
     */
    push(event) {
      if (event === null || typeof event !== 'object') return undefined
      switch (event.type) {
        case 'system': {
          if (typeof event.session_id !== 'string' || event.session_id === '') return undefined
          // 只回报一次；实测 hook_started 早于 init，因此这里通常是最早的时机。
          if (remoteId !== undefined) return undefined
          remoteId = event.session_id
          return { remoteId }
        }
        case 'assistant': {
          // 子代理（Task 工具）的消息带 parent_tool_use_id，不能混进主答复。
          if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id !== '') return undefined
          const message = event.message
          if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return undefined
          const chunk = message.content
            .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('')
          if (chunk === '') return undefined
          // 覆盖式：一条 assistant 事件就是一条完整消息，最后一条才是最终答复。
          text = chunk
          return { text }
        }
        case 'result': {
          const mapped = mapClaudeUsage(event.usage)
          if (mapped !== undefined) usage = mapped
          const succeeded = event.subtype === 'success' && event.is_error !== true
          if (succeeded) {
            completed = true
            if (typeof event.result === 'string' && event.result !== '') text = event.result
          } else {
            failure ??= describeResultFailure(event)
          }
          return {
            ...(mapped === undefined ? {} : { usage: mapped }),
            ...(succeeded ? { completed: true } : { error: failure }),
            ...(succeeded && typeof event.result === 'string' && event.result !== '' ? { text: event.result } : {}),
          }
        }
        default:
          // user（工具结果）/ stream_event / 未来新增事件：无语义动作。
          return undefined
      }
    },

    /**
     * 收流。失败或缺少 `result` 都抛错——「流结束了」不等于「回合成功了」。
     * 幂等：可重复调用，不改变状态。
     * @returns {{text: string, remoteId?: string, usage?: object}}
     */
    finish() {
      if (failure !== undefined) throw new Error(`claude 回合失败：${failure}`)
      if (!completed) throw new Error('claude 流在收到成功的 result 事件之前结束')
      return {
        text,
        ...(remoteId === undefined ? {} : { remoteId }),
        ...(usage === undefined ? {} : { usage }),
      }
    },
  }
}

/**
 * 把 claude 的整轮用量映射成 DSH TokenUsage。
 *
 * Anthropic 的 `input_tokens` 本来就**不含**缓存（另给 `cache_read_input_tokens` /
 * `cache_creation_input_tokens`），与 DSH 约定一致，无需扣减；
 * `output_tokens_details.thinking_tokens` 映射为 reasoning。
 */
function mapClaudeUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const details = raw.output_tokens_details
  return normalizeUsage({
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheReadTokens: raw.cache_read_input_tokens,
    cacheWriteTokens: raw.cache_creation_input_tokens,
    reasoningTokens: details !== null && typeof details === 'object' ? details.thinking_tokens : undefined,
  })
}

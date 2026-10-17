/**
 * Codex CLI 适配：纯命令构造 + `codex exec --json` 事件流解析。
 * 只产出 argv 与 stdin 正文并翻译事件；spawn/管道/stderr/中断由父 adapter 的
 * `ctx.subprocess` 掌握（stdin 取 `{data: input}`）。不 import 任何 DSH 包。
 *
 * 实测依据（codex-cli 0.162.1，新建 + 续接各一轮真实跑通）：
 * - 根选项 `-p/-s/-a/-C` 必须在 `exec` **之前**：`codex exec resume` 自己不接受
 *   这四项，续接时只有根位置能让权限与 cwd 生效。
 * - `resume <SESSION_ID>` 紧跟 `exec`，其余选项随后（clap 允许选项交错）。
 * - 正文走 stdin：末尾 `-` 表示从 stdin 读；argv 不经 shell 解释，所以
 *   `-c model_reasoning_effort="high"` 里的双引号是**字面量**。
 *
 * 事件语义：
 * - `thread.started` 的 `thread_id` 即 remoteId，立刻回报给父落 KV；
 * - `item.completed` 且 `item.type === 'agent_message'` → 最终助手文本（覆盖式）；
 * - `item.type === 'reasoning'` / 工具类 item → **绝不**当作正文；
 * - `item.type === 'error'` → 实测是配置告警（"ignoring N unrecognized configuration
 *   settings"），**非致命**，只作信息回报；
 * - `turn.completed` → 唯一成功完成标志，带 turn 用量；
 * - `turn.failed` / 顶层 `error` → 致命，`finish()` 抛错。
 */

import { normalizeUsage, requireEffort, requireEnum, requireId, requirePrompt, requireText, sanitizeError } from './jsonl.js'

/** `codex -s/--sandbox` 的实测取值（`codex --help`）。 */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 构造一轮 `codex exec` 调用。
 *
 * @param {object} spec
 * @param {string} [spec.executable='codex'] - 可执行名或绝对路径。
 * @param {string} [spec.cwd] - 工作根，落到根选项 `-C`。
 * @param {string} [spec.model] - `-m` 模型 id。
 * @param {string} [spec.effort] - 拼进 `-c model_reasoning_effort="…"`。
 * @param {string} [spec.profile] - 根选项 `-p`；留空请传 undefined。
 * @param {string} [spec.permissionMode] - 根选项 `-s`，只接受三种 sandbox 模式。
 * @param {string} [spec.remoteId] - 已有 thread id 时走 `exec resume <id>`。
 * @param {string} spec.prompt - 正文，经 stdin 送入。
 * @returns {{argv: string[], input: string}}
 */
export function buildCommand({ executable = 'codex', cwd, model, effort, profile, permissionMode, remoteId, prompt } = {}) {
  const argv = [requireText(executable, 'executable')]
  // —— 根选项：必须在 `exec` 之前，否则续接时 `exec resume` 会拒绝它们 ——
  if (profile !== undefined) argv.push('-p', requireText(profile, 'profile'))
  if (permissionMode !== undefined) argv.push('-s', requireEnum(permissionMode, SANDBOX_MODES, 'permissionMode'))
  // 非交互：任何审批请求都会挂住管道，所以恒定 never。
  argv.push('-a', 'never')
  if (cwd !== undefined) argv.push('-C', requireText(cwd, 'cwd'))
  argv.push('exec')
  if (remoteId !== undefined) argv.push('resume', requireId(remoteId, 'remoteId'))
  argv.push('--json', '--skip-git-repo-check')
  if (model !== undefined) argv.push('-m', requireText(model, 'model'))
  if (effort !== undefined) argv.push('-c', `model_reasoning_effort="${requireEffort(effort)}"`)
  // 位置参数 `-`：正文从 stdin 读，避免超长 prompt 撑爆 argv/命令行长度上限。
  argv.push('-')
  return { argv, input: requirePrompt(prompt) }
}

/**
 * 创建一个有状态的 codex 事件解析器（一轮子进程一个）。
 *
 * @returns {{push: (event: unknown) => ({remoteId?: string, text?: string, usage?: object, completed?: boolean, error?: string}|undefined), finish: () => {text: string, remoteId?: string, usage?: object}}}
 */
export function createParser() {
  let remoteId
  let text = ''
  let usage
  let completed = false
  let failure

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
        case 'thread.started': {
          if (typeof event.thread_id !== 'string' || event.thread_id === '') return undefined
          // 只回报一次：父 adapter 在第一次拿到时就落到自己的 KV。
          if (remoteId !== undefined) return undefined
          remoteId = event.thread_id
          return { remoteId }
        }
        case 'item.completed':
        case 'item.updated': {
          const item = event.item
          if (item === null || typeof item !== 'object') return undefined
          if (item.type === 'agent_message') {
            if (typeof item.text !== 'string' || item.text === '') return undefined
            // 覆盖式：一轮里可能有多条 agent_message，最后一条才是最终答复。
            text = item.text
            return { text }
          }
          if (item.type === 'error') {
            // 实测这里是配置告警，不是回合失败，所以不设置 failure。
            return { error: sanitizeError(item.message) }
          }
          // reasoning / command_execution / file_change / mcp_tool_call … 都不是正文。
          return undefined
        }
        case 'turn.completed': {
          completed = true
          usage = mapCodexUsage(event.usage)
          return usage === undefined ? { completed: true } : { usage, completed: true }
        }
        case 'turn.failed': {
          failure ??= sanitizeError(event.error ?? event)
          return { error: failure }
        }
        case 'error': {
          failure ??= sanitizeError(event.message ?? event)
          return { error: failure }
        }
        default:
          // turn.started / item.started / 未来新增事件：无语义动作。
          return undefined
      }
    },

    /**
     * 收流。失败或缺少完成标志都抛错——「流结束了」不等于「回合成功了」。
     * 幂等：可重复调用，不改变状态。
     * @returns {{text: string, remoteId?: string, usage?: object}}
     */
    finish() {
      if (failure !== undefined) throw new Error(`codex 回合失败：${failure}`)
      if (!completed) throw new Error('codex 流在收到 turn.completed 之前结束')
      return {
        text,
        ...(remoteId === undefined ? {} : { remoteId }),
        ...(usage === undefined ? {} : { usage }),
      }
    },
  }
}

/**
 * 把 codex 的 turn 用量映射成 DSH TokenUsage。
 *
 * codex 沿用 OpenAI 语义：`input_tokens` **已含**缓存命中的 prompt token，而 DSH 约定
 * `inputTokens` 不含缓存（见 dsh-llm-pi-ai），故这里做同样扣减；`totalTokens` 由
 * normalizeUsage 按 `input + output + cacheRead + cacheWrite` 还原成完整调用量。
 */
function mapCodexUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const cacheRead = raw.cached_input_tokens
  const cacheWrite = raw.cache_write_input_tokens
  const prompt = typeof raw.input_tokens === 'number' && Number.isFinite(raw.input_tokens) ? raw.input_tokens : 0
  const cacheReadCount = typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0
  const cacheWriteCount = typeof cacheWrite === 'number' && Number.isFinite(cacheWrite) && cacheWrite > 0 ? cacheWrite : 0
  return normalizeUsage({
    inputTokens: Math.max(0, prompt - cacheReadCount - cacheWriteCount),
    outputTokens: raw.output_tokens,
    cacheReadTokens: cacheReadCount,
    cacheWriteTokens: cacheWriteCount,
    reasoningTokens: raw.reasoning_output_tokens,
  })
}

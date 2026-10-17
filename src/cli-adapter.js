import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { normalizeConfig } from './config.js'
import * as codex from './cli/codex.js'
import * as claude from './cli/claude.js'
import { readJsonLines, sanitizeError } from './cli/jsonl.js'

export const CLI_ROUTES = Object.freeze({ codex: 'apollo-cli-codex', claude: 'apollo-cli-claude' })
const protocols = { codex, claude }
const NO_RETRIES = Object.freeze({ mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 })

export function enabledIn(config, agent) {
  const scope = normalizeConfig(config).subagents
  let preset = agent?.session.header.agentPreset
  try {
    const projections = agent?.ctx?.get?.('sessionProjections')
    if (projections) preset = projections.stateOf(agent.session, 'agentPreset') ?? preset
  } catch { /* Compositions without the optional preset registry use the header. */ }
  return scope.global || (scope.eng && ['eng', 'eng-noask'].includes(preset))
}

/** Exact checks are repeated before every CLI turn, including cold resume. */
export function selectCli(config, cli, model, effort) {
  const backend = normalizeConfig(config).subagents[cli]
  if (!backend?.enabled) throw new Error(`Apollo ${cli} backend is disabled; enable it in Plugins → Apollo`)
  const modelId = model ?? backend.defaultModel
  const selected = backend.models.find((candidate) => candidate.id === modelId)
  if (!selected) throw new Error(`Apollo ${cli} model "${modelId}" is not allowed; check the backend model list`)
  const selectedEffort = effort ?? selected.defaultEffort
  if (!selectedEffort || !selected.efforts.includes(selectedEffort)) {
    throw new Error(`Apollo ${cli} effort "${selectedEffort ?? ''}" is not allowed for model "${modelId}"`)
  }
  return { ...backend, model: modelId, effort: selectedEffort }
}

/** Only new user deliveries go to a native CLI that already owns its history. */
export function pendingMessages(messages, delivered) {
  const seen = new Set(delivered)
  const pending = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const id = message.id ?? createHash('sha256').update(JSON.stringify(message.content)).digest('hex')
    if (seen.has(id)) continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(blocks) || blocks.some((block) => block.type !== 'text')) {
      throw new Error('Apollo CLI subagents currently accept text messages only')
    }
    const text = blocks.map((block) => block.text).join('\n')
    pending.push({ id, text })
    seen.add(id)
  }
  return pending
}

/** One adapter instance owns only one CLI; DSH owns the containing Agent loop. */
export function createCliAdapter(ctx, config, sessions, cli) {
  const route = CLI_ROUTES[cli]
  const active = new Set()
  const running = new Set()
  const settling = new Set()
  const lifetime = new AbortController()
  let disposed = false
  const adapter = {
    providerInfo: () => ({ id: route, name: `Apollo ${cli === 'codex' ? 'Codex' : 'Claude'} CLI (subagents)` }),
    providerRetryPolicy: () => NO_RETRIES,
    imageRequestPricing: () => undefined,
    async listModels() {
      const backend = normalizeConfig(config).subagents[cli]
      return backend.enabled ? backend.models.map((model) => ({ provider: route, id: model.id, name: model.id, inputModalities: ['text'] })) : []
    },
    async resolveModel(provider, model) {
      const backend = normalizeConfig(config).subagents[cli]
      const selected = backend.models.find((candidate) => candidate.id === model)
      if (provider !== route || !backend.enabled || !selected) throw new Error(`Apollo ${cli} model "${model}" is unavailable`)
      if (selected.efforts.length === 0) throw new Error(`Apollo ${cli} model "${model}" has no allowed reasoning efforts; configure them in Plugins → Apollo`)
      return {
        provider: route, id: model, name: model, inputModalities: ['text'],
        reasoning: { efforts: selected.efforts.map((id) => ({ id, name: id })), ...(selected.defaultEffort ? { defaultEffort: selected.defaultEffort } : {}) },
      }
    },
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted()
      return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) }
    },
    async *stream(options) {
      if (disposed) throw new Error('Apollo CLI adapter has been unloaded')
      const id = options.sessionId
      const agent = id === undefined ? undefined : ctx.agents.get(id)
      let state = id === undefined ? undefined : sessions.get(id)
      if (!agent || !state || state.cli !== cli || agent.session.header.parentSession !== state.parentId
        || agent.session.header.origin !== 'subagent' || agent.session.header.isSeeded) {
        throw new Error('Apollo CLI routes are reserved for subagent-created continuable sessions')
      }
      if (options.provider !== route || options.model !== state.model || options.reasoningEffort !== state.effort) {
        throw new Error('Apollo CLI session model and effort are fixed at creation')
      }
      if (running.has(id)) throw new Error('Apollo CLI session already has an active turn')
      const current = selectCli(config, cli, state.model, state.effort)
      const pending = pendingMessages(options.messages, state.delivered)
      if (pending.length === 0) throw new Error('Apollo CLI turn has no new user message to deliver')
      if (state.started && !state.remoteId) throw new Error('Apollo CLI session creation was interrupted before its identity was saved; create a new subagent')
      const signal = AbortSignal.any([lifetime.signal, ...options.signal ? [options.signal] : []])
      signal.throwIfAborted()
      running.add(id)
      let settled
      const completion = new Promise((resolve) => { settled = resolve })
      settling.add(completion)
      const prior = structuredClone(state)
      let stateWritten = false
      let handle
      let done
      try {
        const prompt = [
          ...pending.map((message) => message.text),
          `Apollo CLI bridge: return your answer as text; DSH forwards the final output automatically. Harness-only messaging tools are unavailable here. This turn uses ${cli} permission mode "${current.permissionMode}" from Apollo settings. Embedded DSH runtime snapshots describe the host tools; CLI permissions are controlled by these CLI settings.`,
        ].join('\n\n')
        const { argv, input } = protocols[cli].buildCommand({
          ...state, profile: state.profile || undefined, remoteId: state.remoteId, prompt, permissionMode: current.permissionMode,
        })
        // Record attempted delivery before I/O. CLI turns are never retried automatically.
        state = { ...state, started: true, delivered: [...state.delivered, ...pending.map((message) => message.id)] }
        await sessions.put(state)
        stateWritten = true
        signal.throwIfAborted()
        const subprocess = agent.ctx.get('subprocess')
        if (!subprocess) throw new Error('Apollo CLI subagents require the managed subprocess service')
        const env = state.cliHome ? { [cli === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: state.cliHome } : undefined
        if (cli === 'claude' && state.claudeDefaultHome && env) {
          env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = dirname(state.cliHome)
          env.CLAUDE_CONFIG_DIR = undefined // Managed subprocess tombstone preserves native default/keychain lookup.
        }
        handle = subprocess.spawn({
          argv, cwd: state.cwd,
          stdio: { stdin: { data: input }, stdout: 'pipe', stderr: { maxBytes: 4096 } },
          graceMs: 1500, signal,
          ...(env === undefined ? {} : { env }),
        })
        active.add(handle)
        // Observe spawn errors immediately while stdout is being consumed.
        done = handle.done.then((outcome) => ({ outcome }), (error) => ({ error }))
        if (!handle.stdout) throw new Error('Apollo CLI did not expose its JSON event stream')
        const parser = protocols[cli].createParser()
        let protocolError
        for await (const event of readJsonLines(handle.stdout)) {
          const update = parser.push(event)
          if (update?.error) protocolError = update.error
          if (update?.remoteId) {
            if (state.remoteId && state.remoteId !== update.remoteId) throw new Error('CLI resumed a different session; refusing to replace its identity')
            if (!state.remoteId) {
              state = { ...state, remoteId: update.remoteId }
              await sessions.put(state)
            }
          }
          signal.throwIfAborted()
        }
        const result = await done
        signal.throwIfAborted()
        if (result.error) throw new Error(`Apollo ${cli} process could not start: ${result.error.code ?? result.error.name ?? 'spawn error'}`)
        if (result.outcome.exitCode !== 0) {
          const detail = protocolError || handle.collected?.stderr?.readFrom(0).text
          throw new Error(`Apollo ${cli} exited with ${result.outcome.exitCode ?? result.outcome.signal}; check CLI authentication, profile and permissions${detail ? `: ${sanitizeError(detail)}` : ''}`)
        }
        const output = parser.finish()
        if (!state.remoteId) throw new Error(`Apollo ${cli} completed without a resumable session id`)
        if (output.text) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: output.text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: output.text } }
        }
        if (output.usage) yield { type: 'usage', usage: output.usage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        try {
          if (handle) {
            handle.terminate()
            await done
            await handle.waitForExit()
          } else if (stateWritten) {
            // No process was published, so no native CLI consumed this delivery.
            await sessions.put(prior)
          }
        } finally {
          if (handle) active.delete(handle)
          running.delete(id)
          settling.delete(completion)
          settled()
        }
      }
    },
    async dispose() {
      disposed = true
      lifetime.abort(new Error('Apollo CLI adapter unloaded'))
      for (const handle of active) handle.terminate()
      await Promise.allSettled([...settling])
    },
  }
  return adapter
}

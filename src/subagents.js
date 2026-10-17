import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { normalizeConfig } from './config.js'
import { CLI_ROUTES, createCliAdapter, enabledIn, selectCli } from './cli-adapter.js'
import { openCliSessions } from './cli-sessions.js'

const CLI_NAMES = Object.keys(CLI_ROUTES)
const cliName = (provider) => CLI_NAMES.includes(provider) ? provider : undefined
const internalRoute = (provider) => Object.values(CLI_ROUTES).includes(provider)
const success = (value) => ({ isError: false, value, content: [] })

export function cliCatalog(config, request = {}) {
  const providers = CLI_NAMES.filter((cli) => normalizeConfig(config).subagents[cli].enabled)
  if (request.provider === undefined) return providers.map((cli) => `${cli} — ${cli === 'codex' ? 'Codex' : 'Claude'} CLI (background continuable subagents)`).join('\n')
  const cli = cliName(request.provider)
  if (!cli) return ''
  const backend = normalizeConfig(config).subagents[cli]
  if (!backend.enabled) throw new Error(`Apollo ${cli} backend is disabled`)
  if (request.model === undefined) return backend.models.map((model) => `${cli}/${model.id}${model.id === backend.defaultModel ? ' (default)' : ''}`).join('\n') || '(no allowed models)'
  const model = backend.models.find((item) => item.id === request.model)
  if (!model) throw new Error(`Apollo ${cli} model "${request.model}" is not allowed`)
  return `${cli}/${model.id}\nReasoning efforts:\n${model.efforts.map((effort) => `${effort}${effort === model.defaultEffort ? ' (default)' : ''}`).join('\n')}`
}

/**
 * Resolve the child's initial absolute directory from the parent's effective one.
 *
 * The Session header keeps the original project directory, so it can be stale
 * after a working-directory change; the working-directory service is the only
 * authority for the parent's current directory. An absolute explicit `cwd`
 * needs no such lookup, a relative one resolves against that current directory,
 * and omission inherits it. Resolving here keeps the KV record and the
 * manager's pinned initial directory identical.
 * @param {object} ctx - runtime owning the working-directory service.
 * @param {object} parent - calling Agent whose directory is inherited.
 * @param {unknown} requested - explicit tool `cwd`, already schema-validated upstream.
 * @param {AbortSignal} signal - cancellation for the directory inspection.
 * @returns {Promise<string>} absolute child directory.
 */
async function childCwd(ctx, parent, requested, signal) {
  if (requested !== undefined && typeof requested !== 'string') throw new Error('cwd must be a string')
  signal.throwIfAborted()
  if (requested !== undefined && isAbsolute(requested)) return requested
  const current = await ctx.workingDirectory.ensure(parent, signal)
  signal.throwIfAborted()
  if (!current || !isAbsolute(current)) throw new Error('Apollo CLI subagent requires an absolute session working directory')
  return requested === undefined ? current : resolve(current, requested)
}

export async function startCliSubagent(ctx, config, sessions, args, exec) {
  const cli = cliName(args.provider)
  if (!cli) throw new Error('Unknown Apollo CLI provider')
  const parent = exec.agent
  if (!parent) throw new Error('Apollo subagent requires a calling Agent')
  if (!enabledIn(config, parent)) throw new Error('Apollo CLI subagents are disabled for this preset')
  if (args.run_in_background !== undefined) throw new Error('run_in_background was removed for CLI subagents; they always run in the background and are continued with send_message')
  if (args.agent_preset !== undefined) throw new Error('agent_preset is not supported for CLI subagents yet')
  if (typeof args.prompt !== 'string' || typeof args.description !== 'string') throw new Error('subagent requires a prompt and description')
  const selected = selectCli(config, cli, args.model, args.reasoning_effort)
  const cwd = await childCwd(ctx, parent, args.cwd, exec.signal)
  let executable
  try {
    const command = selected.executable.startsWith('~/') ? join(homedir(), selected.executable.slice(2)) : selected.executable
    executable = await ctx.subprocess.resolveExecutable(command, undefined, exec.signal)
  } catch (error) {
    exec.signal.throwIfAborted()
    throw new Error(`Apollo ${cli} executable is unavailable; set its absolute path in Plugins → Apollo`, { cause: error })
  }
  const id = randomUUID()
  const record = {
    version: 1, id, parentId: parent.id, cli, cwd,
    executable, profile: cli === 'codex' ? selected.profile : '',
    cliHome: cli === 'codex' ? process.env.CODEX_HOME ?? join(homedir(), '.codex')
      : process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    // Explicit CLAUDE_CONFIG_DIR changes config and keychain lookup, even for ~/.claude.
    ...(cli === 'claude' && process.env.CLAUDE_CONFIG_DIR === undefined ? { claudeDefaultHome: true } : {}),
    model: selected.model, effort: selected.effort, delivered: [], started: false,
  }
  await sessions.put(record)
  try {
    exec.signal.throwIfAborted()
    const maxDepth = ctx.subagents.resolveMaxDepth()
    const created = await ctx.subagents.startActivation({
      provider: 'spawn', label: args.description, childId: id, signal: exec.signal,
      delivery: 'parent',
      request: {
        parent, prompt: [{ type: 'text', text: args.prompt }], cwd,
        agentOptions: { provider: CLI_ROUTES[cli], model: selected.model, reasoningEffort: selected.effort },
        ...(maxDepth === undefined ? {} : { maxDepth }),
      },
    })
    exec.signal.throwIfAborted()
    return { kind: 'activation', subagentId: created.childId }
  } catch (error) {
    // The manager rolls back pre-admission failure; drain also covers the final
    // acceptance/cancellation race before this tool could hand the id back.
    await ctx.subagents.drainChildren(parent, [id])
    await sessions.delete(id)
    throw error
  }
}

/** Host-level interception extends existing tools without replacing registrations. */
export function installCliRouting(ctx, config, sessions) {
  const unpublished = new Map()
  const cleanups = new Set()
  const creating = new Set()
  const lifetime = new AbortController()
  const reclaim = (entry) => {
    if (entry.cleanup) return entry.cleanup
    const task = (async () => {
      await ctx.subagents.drainChildren(entry.parent, [entry.id])
      await sessions.delete(entry.id)
    })()
    entry.cleanup = task
    cleanups.add(task)
    task.catch((error) => ctx.logger?.warn?.(`Apollo could not reclaim unreported CLI child ${entry.id}: ${error.message}`))
      .finally(() => cleanups.delete(task))
    return task
  }
  ctx.on('tools/result', (exec, result) => {
    const key = exec.token ?? exec
    const entry = unpublished.get(key)
    if (!entry) return
    unpublished.delete(key)
    if (!result.isError && result.value?.kind === 'activation' && result.value.subagentId === entry.id) return
    void reclaim(entry)
  })
  ctx.tools.guard((exec) => {
    const args = exec.arguments ?? {}
    if (!['subagent', 'subagent_fork'].includes(exec.name)) return
    if (internalRoute(args.provider)) return 'Use provider="codex" or provider="claude" with subagent; internal CLI routes are reserved'
    const selected = cliName(args.provider)
    if (selected && !enabledIn(config, exec.agent)) return 'Apollo CLI subagents are disabled for this preset'
    if (exec.name === 'subagent_fork' && (selected || (args.provider === undefined && internalRoute(exec.agent?.options.provider)))) {
      return 'Codex/Claude support background subagent creation only; subagent_fork cannot create a CLI child'
    }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const args = exec.arguments ?? {}
    if (!enabledIn(config, exec.agent)) return next()
    if (exec.name === 'subagent' && cliName(args.provider)) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const creation = (async () => {
        const value = await startCliSubagent(ctx, config, sessions, args, { ...exec, signal })
        unpublished.set(exec.token ?? exec, { parent: exec.agent, id: value.subagentId })
        return success(value)
      })()
      creating.add(creation)
      try { return await creation } finally { creating.delete(creation) }
    }
    if (exec.name !== 'list_subagent_models') return next()
    if (cliName(args.provider)) return success(cliCatalog(config, args))
    if (args.provider !== undefined || args.model !== undefined) return next()
    const base = await next()
    const extra = cliCatalog(config)
    if (base.isError || !extra) return base
    return success([base.value, extra].filter(Boolean).join('\n'))
  })
  ctx.systemPrompt.section({
    name: 'apollo:cli-subagents', order: 80,
    text: (context) => {
      const agent = context.agent ?? ctx.agents.get(context.session?.id ?? context.scope?.id)
      if (!enabledIn(config, agent)) return ''
      const catalog = cliCatalog(config)
      if (!catalog) return ''
      return [
        'Apollo CLI subagents: existing subagent also accepts provider="codex" or provider="claude".',
        'Call list_subagent_models with that provider to inspect allowed models and reasoning efforts. Model and reasoning_effort may be omitted to use configured defaults.',
        'CLI children always run in the background; run_in_background was removed. Pass cwd to choose their initial directory. subagent_fork and agent_preset are unsupported.',
        'Use send_message, list_agents, interrupt_agent and wait_subagent when available to control their stable child ids. Their CLI permissions come from Apollo settings.',
        catalog,
      ].join('\n')
    },
  })
  return async () => {
    lifetime.abort(new Error('Apollo CLI routing unloaded'))
    await Promise.allSettled([...creating])
    await Promise.allSettled([...unpublished.values()].map(reclaim))
    unpublished.clear()
    await Promise.allSettled([...cleanups])
  }
}

export function mountSubagents(ctx, config) {
  ctx.inject(['tools', 'subagents', 'agents', 'llm', 'storage', 'subprocess', 'systemPrompt', 'workingDirectory'], async (runtime) => {
    const sessions = await openCliSessions(runtime)
    const adapters = CLI_NAMES.map((cli) => createCliAdapter(runtime, config, sessions, cli))
    let stopRouting = async () => {}
    runtime.effect(() => async () => {
      await stopRouting()
      await Promise.all(adapters.map((adapter) => adapter.dispose()))
      await sessions.close()
    })
    adapters.forEach((adapter, index) => runtime.llm.registerAdapter([CLI_ROUTES[CLI_NAMES[index]]], adapter))
    stopRouting = installCliRouting(runtime, config, sessions)
  })
}

/**
 * `wait_subagent` tool — explicit wait for continuable children to settle.
 *
 * Preset-local plugin for the eng preset (resolved relative to this preset's
 * directory). Continuable subagents live in the `subagents` registry, not the
 * `jobs` registry, so the only settlement signal is the scoped `subagent/end`
 * event. The tool takes an ARRAY of durable child ids (`subagent_id`), awaits
 * them all concurrently (duplicates deduped, order preserved), and returns one
 * SHORT line per id (done + stopReason).
 *
 * The children's content is none of this tool's business: the subagent manager
 * unconditionally delivers a settlement notice to the parent BEFORE
 * `subagent/end` fires (dispose order: notifySettlement() →
 * observer.settle()), carrying the one-line account and the closing message.
 * A busy parent is steered, so the notice sits in the pending next-step queue
 * and reaches the model right after this tool result — exactly once, per
 * child, by the framework. Earlier designs returned the child's final message
 * here AND spliced the duplicate notice (and any mid-run `report`) out of the
 * parent inbox; that coupled this plugin to `agent.inbox` internals and to
 * the `subagent-report` source kind, which upstream removed in
 * 0.1.2-alpha.4 (bidirectional `send_message` replaced `report`). Returning
 * "done" lines and leaving delivery to the framework has no such coupling.
 * Mid-run messages the child sends (`send_message`, source kind
 * `agent-message`) likewise stay in place.
 *
 * `timeout_ms` is ONE shared window over the whole batch (all timers start at
 * the same instant), matching the semantics same-message parallel calls had.
 * An id that is not a direct child fails the whole call fast — nobody is
 * waited for — keeping the contract the single-id version had. A child
 * dispatched moments ago may not have started its first turn yet: its status
 * is not `running` and no settlement exists. Returning early with a "not
 * running" note there (the pre-grace behavior) ended the turn before the
 * child even started and forced a re-wait on the next turn — session audit
 * 2f5dd618. Instead, a not-yet-started child gets a startup grace window
 * (START_GRACE_MS): the tool keeps waiting while the child spins up,
 * settles, the optional timeout elapses, or the grace expires without the
 * child ever starting (only then a retryable informational line).
 *
 * Zero imports on purpose: the module loads from the preset directory, where
 * Node's upward node_modules walk never reaches the harness install, so bare
 * package imports would fail. Everything needed comes from the context.
 */

export const name = 'tool-wait-subagent'

export const inject = ['tools', 'subagents', 'agents']

/** Grace window for a just-dispatched child that has not started running yet. */
const START_GRACE_MS = 30_000

/** Status polling interval while waiting for a not-yet-started child. */
const POLL_MS = 250

export function apply(ctx) {
  /** childId -> { time, info } — latest settlement observed since mount. */
  const settled = new Map()
  /** childId -> finish(info) callbacks awaiting settlement. */
  const waiters = new Map()

  ctx.on('subagent/end', (info) => {
    const id = info && info.id
    if (typeof id !== 'string') return
    settled.set(id, { time: Date.now(), info })
    const list = waiters.get(id)
    if (list !== undefined) {
      waiters.delete(id)
      for (const finish of [...list]) finish({ kind: 'settled', info })
    }
  })

  ctx.tools.register({
    name: 'wait_subagent',
    description: 'Wait for one or more background continuable subagents (spawned by subagent or subagent_fork) to finish their current turn. Pass their durable ids as an array in subagent_id — all are awaited concurrently and the result carries one short line per id (done + stop reason); a child\'s closing message arrives as the framework settlement notice immediately after this result; do not expect it here. Blocks until every listed child settles, the optional timeout_ms elapses (one shared window over all ids), or the user interrupts — without timeout_ms, until completion. A just-dispatched child that has not started yet is awaited through a brief startup grace rather than reported as not running. Use it when your next step depends on those results; with independent work remaining, prefer background plus completion notices. Do not pass bash job ids — those use job_output.',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'One or more durable subagent ids returned by the subagent or subagent_fork tool call; every id is awaited concurrently.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Optional maximum wait in milliseconds applied as one shared window over all ids; omit to wait until every child settles. On expiry the tool returns while some children are still running.',
        },
      },
      required: ['subagent_id'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Dedupe preserving input order; the schema already enforces a
      // non-empty array, the guard below only covers malformed direct calls.
      const ids = [...new Set(Array.isArray(args.subagent_id) ? args.subagent_id : [])]
      if (ids.length === 0) return 'subagent_id must be a non-empty array of subagent ids.'
      const parent = exec.agent
      if (parent === undefined) throw new Error('wait_subagent requires a calling agent (exec.agent was undefined)')

      // Verify every id is one of this agent's direct children — fail fast,
      // waiting for nobody (the contract the single-id version had).
      let entries
      try {
        entries = await ctx.subagents.listChildren(parent.id, exec.signal)
      } catch (error) {
        return 'listChildren failed: ' + (error && error.message ? error.message : String(error))
      }
      const known = new Set(entries.map((entry) => entry.id))
      const unknown = ids.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        return `unknown subagent ${unknown.map((id) => `"${id}"`).join(', ')}: not a direct child of this agent (list_agents shows your children; only depth-1 children can be awaited).`
      }

      const statusOf = (id) => {
        const agent = ctx.agents.get(id)
        return agent === undefined ? 'ready' : agent.status === 'running' ? 'running' : 'idle'
      }

      /** Settlement line: short done line; content belongs to the framework notice. */
      const doneLine = (id, info) => `subagent ${id} done (${info && info.stopReason ? info.stopReason : 'completed'}); its closing message follows as the settlement notice.`

      const startedAt = Date.now()
      const capMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : undefined

      /**
       * Wait for one child. Resolves with {kind:'settled',info} |
       * {kind:'timedOut'} | {kind:'aborted'} | {kind:'notStarted'}. The
       * per-id machinery (settled fast path, waiter registration, timeout
       * timer, startup-grace poller) is the single-id logic of old,
       * unchanged; Promise.all over ids gives the concurrent batch.
       */
      const waitOne = (id) => {
        // Fast path: the child is not running and a settlement is already on
        // record — resolve immediately (the notice was already delivered when
        // the child settled, so it is in the conversation history).
        if (statusOf(id) !== 'running') {
          const hit = settled.get(id)
          if (hit !== undefined) return Promise.resolve({ kind: 'settled', info: hit.info })
        }

        return new Promise((resolve) => {
          let done = false
          let timer
          let poller
          const finish = (value) => {
            if (done) return
            done = true
            if (poller !== undefined) clearInterval(poller)
            const list = waiters.get(id)
            if (list !== undefined) {
              const index = list.indexOf(finish)
              if (index >= 0) list.splice(index, 1)
              if (list.length === 0) waiters.delete(id)
            }
            if (timer !== undefined) clearTimeout(timer)
            if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onAbort)
            resolve(value)
          }
          const onAbort = () => finish({ kind: 'aborted' })

          const list = waiters.get(id) ?? []
          list.push(finish)
          waiters.set(id, list)
          // All ids share startedAt, so one capMs value is one shared window.
          if (capMs !== undefined) timer = setTimeout(() => finish({ kind: 'timedOut' }), capMs)
          if (exec.signal !== undefined) {
            if (exec.signal.aborted) {
              finish({ kind: 'aborted' })
              return
            }
            exec.signal.addEventListener('abort', onAbort, { once: true })
          }

          // Startup grace: a freshly dispatched child sits between spawn and
          // its first turn (status not `running`, no settlement yet). Keep the
          // wait alive while it spins up; once `running`, only `subagent/end`
          // (the listener above) resolves us. If the grace expires without the
          // child ever starting or settling, fall back to a retryable note
          // instead of the old misleading "is not running" early return.
          poller = setInterval(() => {
            if (done) return
            const hit = settled.get(id)
            if (hit !== undefined) {
              finish({ kind: 'settled', info: hit.info })
              return
            }
            if (statusOf(id) !== 'running' && Date.now() - startedAt >= START_GRACE_MS) {
              finish({ kind: 'notStarted' })
            }
          }, POLL_MS)

          // Re-check: the child may have settled between the fast path above
          // and waiter registration. Only a settlement AFTER this wait started
          // counts as a live result.
          const hit = settled.get(id)
          if (hit !== undefined && hit.time >= startedAt) finish({ kind: 'settled', info: hit.info })
        })
      }

      const outcomes = await Promise.all(ids.map((id) => waitOne(id)))

      // Every waiter shares one abort signal, so an interruption either
      // aborts the whole batch or lands after some children already settled.
      // Collapse the all-aborted case into one line; mixed cases keep
      // per-id lines so the settled ones are not lost.
      if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === 'aborted')) {
        return `wait for ${ids.length} subagent${ids.length === 1 ? '' : 's'} was aborted by user interruption; the children may still be running.`
      }

      const lines = outcomes.map((outcome, index) => {
        const id = ids[index]
        if (outcome.kind === 'aborted') return `wait for subagent ${id} was aborted by user interruption; the child may still be running.`
        if (outcome.kind === 'timedOut') return `timed out waiting for subagent ${id}; it is still running. You will be notified when it finishes — you can wait_subagent it again or continue with other work.`
        if (outcome.kind === 'notStarted') {
          return `subagent ${id} has not started after ${Math.round(START_GRACE_MS / 1000)}s (status: ${statusOf(id)}). It may still be spinning up — call wait_subagent again, or continue with other work; you will be notified when it finishes.`
        }
        // Real settlement: short done line; the framework's settlement notice
        // (already delivered to the parent inbox before `subagent/end`)
        // carries the closing message — nothing to consume or deduplicate.
        return doneLine(id, outcome.info)
      })
      return lines.join('\n')
    },
  })
}

/**
 * `eng-mode-instructions` — preset-scoped prompt section for 工程模式
 * (`eng`) and 工程(PTC)模式 (`eng-ptc`).
 *
 * Carries what no other surface states: the general engineering discipline
 * (moved out of the user-global ~/.dsh/AGENTS.md, which keeps only
 * machine-local conventions), the delegation policy, the subagent model tiers
 * rendered from Apollo settings (`tiers.*`), and the exit guard contract while
 * that switch is on. Tool mechanics, background-job etiquette and run_code
 * syntax live in the harness prompt and tool descriptions and are NOT
 * repeated here.
 *
 * The text is a function re-rendered per request from the live Apollo config,
 * so settings edits apply without remounting; an edit costs the prefix cache
 * once, which is acceptable for rarely changed settings. The row config
 * `ptc: true` (set by eng-ptc) adds a rule for fanning out subagents inside
 * one run_code program (workflow usage is left to the harness tool guidance); run_code mechanics themselves
 * come from the harness `tools:sdk` / `tools:ptc-only` sections.
 */

import z from '@deepseek-ai/schemastery'
import { currentConfig } from '../../../../src/config.js'

export const name = 'eng-mode-instructions'

export const inject = ['systemPrompt']

export const Config = z.object({
  /** Render the PTC variant (eng-ptc). */
  ptc: z.boolean().default(false),
})

const PRINCIPLES = `# Engineering mode

For coding and infrastructure work. These are defaults; explicit user instructions take precedence.

## Principles
- KISS / YAGNI: use the simplest approach that works. Do not add abstractions, indirection, or options the task does not need.
- Inspect first: read the actual files, run the actual commands, check the actual state, then judge. When evidence and judgment disagree, evidence wins. Look up unfamiliar library/API behavior instead of relying on memory.
- Fix the root cause: trace a bad value back to the violated assumption; no workarounds that only hide the symptom.
- One coherent change at a time, each with an observable result and a pass/fail check; do not bundle unrelated edits.
- Follow existing conventions: match surrounding naming, style, error handling, and patterns; use the project's own build/test/lint commands; read the repo's coding-standards files (if any) before writing code.
- Think about requirements, approach, and verification; do not draft whole implementations in your reasoning. If your reasoning starts repeating, stop, change angle, or go gather evidence.

## Avoid over-engineering and over-defending
- Do not add complexity for speculative needs or vanishingly unlikely race/security edge cases. If one seems necessary, first explain the concrete failure mode, its likelihood, and the complexity cost to the user and get agreement; never silently expand scope for theoretical robustness.
- Validate unknown input once, at the boundary that owns it, and pass settled values inward; do not re-check what a schema, constructor, or type already guarantees.
- Put try/catch only where the error can actually be handled; never use it to swallow errors or hide failures.
- Do not extract single-use helpers unless they name a real concept or isolate a genuinely complex boundary.
- Comment non-obvious constraints and surprising behavior, not what the code already says.
- Test the real implementation; minimize mocks; do not copy implementation logic into tests.

## Verification and reporting
- Claim success only with fresh evidence from the changed state. Passing lint does not prove runtime behavior; unit tests do not prove deployment integration.
- In reports, separate verified, executed-but-unverified, and not executed. Never fake progress.

## Boundaries
- Changing shared branches such as main or dev needs explicit authorization. Within the task, commits and merges on isolated branches are fine; create worktrees for isolation when useful.
- Preserve unrelated changes and keep the main worktree clean; recurring local files can go in .git/info/exclude.
- Commit with the configured global Git identity, never placeholder identities such as bot or agent.
- Tell the user when you install system packages or download dependencies outside the package manager; ask where to install missing unmanaged dependencies; prefer prebuilt packages over compiling.
- No filesystem-wide or whole-home-directory searches without asking first.
- Deviating from these rules needs the user's consent. Before asking, explore the code, tests, and prior decisions yourself; ask only questions whose answers change what you do, each with a recommended answer and why.

## Commands and processes
- One background job per goal: check job_list first; do not run near-duplicate commands in parallel.
- Work on data where it already is (including remote mounts) instead of downloading or copying large files.
- Before killing a process, confirm its full command line and PID with \`pgrep -af <keyword>\`, then \`kill <PID>\`; never pkill / killall.
- Never sleep longer than 60s at once; for longer waits use stepped probes, sentinel files, or completion notices.
- Run services that must outlive the turn (dev servers, watchers) under pm2/nohup outside the job registry, and say which ones are still running when you finish.`

const DELEGATION_HEAD = `## Delegation
- Subagents cannot see this conversation: state the goal, write scope, deliverable, and verification, and give real file paths for prior outputs.
- Opening reconnaissance: when starting non-trivial work in an unfamiliar or large codebase, immediately dispatch fast-tier scouts in parallel (structure, relevant modules, conventions, test entry points), all in one message; the main agent reads only the instruction files that define the task. A scout prompt needs only goal, boundaries, and deliverable.
- Delegate read-only, parallelizable, stateless investigation by default instead of trying it in the main thread first; when a new unknown appears mid-task and 1–2 rounds of digging do not converge, delegate it.
- Implementation chunks with non-overlapping write scopes can run in parallel; keep linear work, tightly coupled changes, and debugging that needs live state in the main thread.`

const FANOUT_PTC = '- For repeated same-shaped work, dispatch all subagents inside one run_code program, then collect them with wait_subagent.'

const DELEGATION_TAIL = `- When you need a subagent's result, wait patiently with wait_subagent. Do not poll or prod it with send_message; send a message only to give it genuinely new information or a correction.
- The main agent owns integration, review, and final verification. Subagent reports are leads, not evidence: check the actual changes yourself.
- When a subagent ends in an error or empty result, read why, fix the cause, and re-dispatch once; take over in the main thread only if it fails again without an external blocker, and say why.`

const EXIT_GUARD = `## Exit guard
- If subagents or background commands are still running when the turn would end, the system injects a reminder and the turn continues. Collect them with wait_subagent / job_output, stop unneeded ones with job_kill, then finish.`

/** One tier as model-facing argument text; an unset tier inherits the parent route. */
export function renderTier(tier) {
  if (!tier?.provider || !tier?.model) return 'omit provider / model / reasoning_effort to inherit the parent route'
  const parts = [`provider: \`${tier.provider}\``, `model: \`${tier.model}\``]
  if (tier.reasoningEffort) parts.push(`reasoning_effort: \`${tier.reasoningEffort}\``)
  return parts.join(' · ')
}

/**
 * Render the full section text.
 * @param config - normalized Apollo config (`exitGuard`, `tiers`).
 * @param options - `{ ptc }` from this row's config.
 * @returns the section markdown.
 */
export function renderInstructions(config, options = {}) {
  const tiers = `## Subagent model tiers
- Fast tier (exploration, reconnaissance, mechanical analysis, batch triage): ${renderTier(config.tiers?.fast)}
- Quality tier (complex implementation, debugging, review, design): ${renderTier(config.tiers?.quality)}
- Start exploration on the fast tier; when coverage falls short or key questions remain, re-dispatch the unresolved part on the quality tier. Escalating means re-dispatching, not modifying an existing subagent.
- subagent_fork takes no model choice: it keeps the parent route to reuse the prefix cache.`
  const blocks = [
    PRINCIPLES,
    [DELEGATION_HEAD, ...(options.ptc ? [FANOUT_PTC] : []), DELEGATION_TAIL].join('\n'),
    tiers,
  ]
  if (config.exitGuard) blocks.push(EXIT_GUARD)
  return blocks.join('\n\n')
}

export function apply(ctx, config) {
  const options = { ptc: config?.ptc === true }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'eng:mode-instructions',
    order: 1,
    interpolate: false,
    text: () => renderInstructions(currentConfig(ctx), options),
  }), 'eng-mode-instructions.section()')
}

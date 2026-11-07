---
name: exec
description: "Use when the user invokes /exec with an approved master Spec. Orchestrates per-Spec worktrees, wave-parallel subagent execution, merging, verification, and final review."
---

# Execute multi-Spec tasks

Run approved sub-Specs in isolated worktrees under `.worktrees/` in the target repo. The main workspace is always the merge target; orchestration state lives only in the current session context.

## Prerequisites

- The master Spec indexes at least two sub-Specs.
- Confirm a single target repo; the main workspace is on a named branch and its working tree is clean.
- `.worktrees/` is covered by the target repo's `.gitignore`; if not, ask the user to add it first.

## Execution mode

Before dispatching the first node, ask once with `ask_user_question` (single-select), unless the user already specified the mode for this run. Explain that the choice applies to implementation and fixes; **all code reviews use the quality tier**. Offer these options in order:

1. **Automatic (Recommended)** — use the fast tier by default; reserve the quality tier for particularly difficult tasks.
2. **Quality only** — use the quality tier for every implementation and fix.
3. **Fast only** — use the fast tier for every implementation and fix, without automatic escalation.

Put Automatic first so the host's default answer selects it. State in the question that a timeout or skipped choice defaults to Automatic. If the host returns `autoSelected` or a timeout `pending`, continue in Automatic under this declared preference default; do not treat it as new task authorization. Use the host-configured wait duration (including unlimited waiting); omit the tool's `timeout` argument and do not change global settings. A later explicit answer applies to future implementation/fix turns; let running turns finish. If the next fix requires a different tier, use the stopped-node handoff below instead of resuming the old route.

Keep the mode in session context and pass it to implementation/fix nodes and any further implementation delegations. In Automatic, ordinary implementation and routine fixes use fast; use quality only when the task demands unusually difficult reasoning or evidence shows the fast node cannot converge. Implementation work alone is not a reason to choose quality.

Resolve fast/quality from the current system prompt's configured routes and pass their `provider` / `model` / `reasoning_effort` to `subagent`; do not hardcode model IDs or use `subagent_fork` to select a tier. If a tier is unconfigured, follow its documented parent-route inheritance and disclose that distinct tiers are not configured. If a selected route is unavailable, report the blocker rather than silently switching tiers.

## Execution

1. Read the master Spec and all sub-Specs; confirm shared contracts, dependency DAG, and verification commands.
2. Build the task list by dependency wave.
3. Per wave: create a branch from the main workspace HEAD, create a worktree at `<repo>/.worktrees/exec-<task>/<subtask>`, then dispatch the whole wave of nodes. Create the next wave's worktrees only after every prior wave has merged.

## Wave execution: subagent + wait_subagent

The main agent orchestrates each wave; node contracts (prompt elements, report format, failure semantics) are in the `dev` skill.

1. **Dispatch**: in a single message, call `subagent` once per sub-Spec in this wave using the execution mode, and record "Spec → active subagent id and tier". Implementation-node prompt template:

   ```
   You work in the isolated worktree <worktree absolute path>: always run bash with workdir=<worktree>, and use absolute paths for file tools.
   Execution mode: <Automatic / Quality only / Fast only>; assigned tier: <fast / quality>. Carry the mode into any implementation/fix delegations.
   Follow the main-agent-driven-development skill in prebuilt-worktree mode (skip its internal review step; /exec decides whether and when to request a sub-Spec review).
   Implement only <sub-Spec path> and obey the shared contracts: <contracts>. Run verification: <verification command>.
   After committing, report in the dev skill's implementation-node format. Do not merge or delete the worktree; if blocked, set status=blocked and fill in blocker.
   ```

2. **Collect**: pass every id in this wave to `wait_subagent` in one call; reports arrive with the settlement notice. A Spec with a missing report, `blocked`, or no commit is recorded as `node-failed` and does not affect the other Specs in the wave.
3. **Choose sub-Spec reviews**: the orchestrator decides whether and when each completed Spec needs an independent code review, based on complexity, shared-contract impact, risk, and verification evidence. Ordinary low-risk changes can rely on the mandatory final integrated review. Briefly record the decision and reason in session context. For a selected review:
   - Dispatch a brand-new read-only reviewer (quality tier): `Read-only review of the full diff of worktree <worktree> against the baseline (always run bash with workdir=<worktree>). Spec: <path>. Implementation summary: <summary>. Verification already run: <verification>. List issues by severity, each with file and line number; judge with the dev skill's four-state format. Do not edit, commit, or merge.`
   - `CHANGES_REQUIRED` → send the findings to the active implementation subagent with `send_message` (preserving its context), and require it to fix each real issue, explain false positives, rerun verification, commit, and report again; then wait and dispatch a brand-new quality reviewer. Apply the execution mode and escalation rules to fixes.
   - At most 5 rounds; if still failing, record `review-exhausted`.
4. **Merge eligibility**: committed, verified, in-scope Specs may proceed without a separate sub-Spec review when the orchestrator chose to omit it. A selected review must reach `APPROVED` / `APPROVED_WITH_NOTES`; never bypass required findings or a `BLOCKED` / exhausted review by changing the review decision.

Key points:

- Every review round uses a brand-new quality subagent; fixes normally reuse the active implementation subagent.
- Report any node question as blocked for the main agent to handle; do not ask the user within a wave.
- In PTC mode, a whole wave's dispatch and collection can be done in one `run_code`.

## Waiting and escalation

For every implementation, review, fix, and handoff wait in this workflow, call `wait_subagent` with all needed ids and `timeout_ms: 1800000` (30 minutes) or longer. Early completion returns immediately. Do independent work first; when blocked on results, wait patiently. If a wait expires while a node is still running, wait again with the same long window or continue independent work. A wait timeout is not a node failure or evidence that the task is particularly difficult. Do not send status nudges, repeatedly poll agent lists, or interrupt/replace a normally running node because it is taking time.

In Automatic only, an actual blocker, repeated failed attempts, or evidence of exceptional difficulty can justify a fast-to-quality handoff. A later explicit mode change can also require a handoff for the next implementation/fix turn. Reuse the existing node otherwise. Confirm the old node has stopped writing before dispatching its replacement; if interruption is needed, request it and wait for the node to stop. Inspect the actual worktree state and hand off the Spec, contracts, existing commits, any uncommitted changes, verification results, and unresolved issues to a new implementation node in the same worktree at the required tier (quality for automatic escalation). Update the active-node mapping; only one implementation node may write to a Spec at a time. After escalation, keep that quality node for subsequent fixes unless the user explicitly changes the mode.

## Merge

For each eligible node: confirm it is committed and verification passed → check the changed files for out-of-scope edits → merge into the main workspace → verify after merging → delete the worktree and sub-branch.

Resolve conflicts through an implementation/fix node under the execution mode; use a new fix worktree under `.worktrees/` for complex conflicts. Never merge failed or blocked nodes.

## Final review

Once all sub-Specs are merged, run the full integration verification, then always dispatch a brand-new read-only reviewer subagent (quality tier) to review the whole integrated result, even when sub-Spec reviews were omitted:

```
subagent(
  prompt="Read-only review of the <base>..HEAD diff in <workspace> (always run bash with workdir=<workspace>).
         Master Spec: <path> | all sub-Specs | shared contracts | changed files | implementation summary | verification results.
         List issues by severity, each with file and line number.
         Return APPROVED / APPROVED_WITH_NOTES / CHANGES_REQUIRED / BLOCKED. Do not edit, commit, or merge."
)
```

Wait using the long window above. On `CHANGES_REQUIRED` there is no need to ask the user — the main agent classifies findings and briefly explains false positives and existing behavior in context. Delegate real fixes to an implementation/fix node in an isolated worktree under the execution mode, integrate the committed fixes, verify again, and dispatch a brand-new quality reviewer for re-review. If serious or blocking issues remain after a soft cap of 3 rounds, stop the fix loop and truthfully report the remaining issues to the user. A blocked review is not approval.

## Wrap-up

Run the full verification, check the Specs, report the execution mode, actual tier use and escalations, sub-Spec review decisions, branches, commits, verification results, and open issues, and ask the user what to do next. Do not create a PR or delete branches without the user's choice.

## KISS

- One sub-Spec, one worktree, at most one active implementation node.
- The main agent holds repo topology (branches/worktrees/merges/cleanup) and scheduling; implementation, fixes, and selected reviews go to subagents.
- State lives only in session context; add no integration branch, scheduler scripts, or state files.
- Completion notices arrive automatically; wait only when you need results to proceed. Never poll with `sleep`.

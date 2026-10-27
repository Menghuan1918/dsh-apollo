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

## Execution

1. Read the master Spec and all sub-Specs; confirm shared contracts, dependency DAG, and verification commands.
2. Build the task list by dependency wave.
3. Per wave: create a branch from the main workspace HEAD, create a worktree at `<repo>/.worktrees/exec-<task>/<subtask>`, then dispatch the whole wave of nodes. Create the next wave's worktrees only after every prior wave has merged.

## Wave execution: subagent + wait_subagent

The main agent orchestrates each wave; node contracts (prompt elements, report format, failure semantics) are in the `dev` skill.

1. **Dispatch**: in a single message, call `subagent` once per sub-Spec in this wave (quality tier), and record "Spec → subagent id". Implementation-node prompt template:

   ```
   You work in the isolated worktree <worktree absolute path>: always run bash with workdir=<worktree>, and use absolute paths for file tools.
   Follow the main-agent-driven-development skill in prebuilt-worktree mode (skip its internal review step; the review loop is run by /exec).
   Implement only <sub-Spec path> and obey the shared contracts: <contracts>. Run verification: <verification command>.
   After committing, report in the dev skill's implementation-node format. Do not merge or delete the worktree; if blocked, set status=blocked and fill in blocker.
   ```

2. **Collect**: pass every id in this wave to `wait_subagent` in one call; reports arrive with the settlement notice. A Spec with a missing report, `blocked`, or no commit is recorded as `node-failed` and does not affect the other Specs in the wave.
3. **Review loop** (each completed Spec advances independently; batches may be dispatched in parallel):
   - Dispatch a brand-new read-only reviewer (quality tier): `Read-only review of the full diff of worktree <worktree> against the baseline (always run bash with workdir=<worktree>). Spec: <path>. Implementation summary: <summary>. Verification already run: <verification>. List issues by severity, each with file and line number; judge with the dev skill's four-state format. Do not edit, commit, or merge.`
   - `CHANGES_REQUIRED` → send the findings to the original implementation subagent with `send_message` (preserving its context), and require it to fix each real issue, explain false positives, rerun verification, commit, and report again; then `wait_subagent` and dispatch a brand-new reviewer.
   - At most 5 rounds; if still failing, record `review-exhausted`.
4. Only Specs judged `APPROVED` / `APPROVED_WITH_NOTES` proceed to merge.

Key points:

- Every review round uses a brand-new subagent; fixes reuse the original implementation subagent — never start another implementation node for the same Spec.
- Report any node question as blocked for the main agent to handle; do not ask the user within a wave.
- In PTC mode, a whole wave's dispatch and collection can be done in one `run_code`.

## Merge

For each completed node: confirm it is committed and verification passed → check the changed files for out-of-scope edits → merge into the main workspace → verify after merging → delete the worktree and sub-branch.

Small, well-defined conflicts are resolved directly by the main agent. For complex conflicts, use a new fix worktree under `.worktrees/` and a development node. Never merge failed or blocked nodes.

## Final review

Once all sub-Specs are merged, run the full integration verification, then dispatch a brand-new read-only reviewer subagent (quality tier) to review the whole integrated result:

```
subagent(
  prompt="Read-only review of the <base>..HEAD diff in <workspace> (always run bash with workdir=<workspace>).
         Master Spec: <path> | all sub-Specs | shared contracts | changed files | implementation summary | verification results.
         List issues by severity, each with file and line number.
         Return APPROVED / APPROVED_WITH_NOTES / CHANGES_REQUIRED / BLOCKED. Do not edit, commit, or merge."
)
```

Wait with `wait_subagent`. On `CHANGES_REQUIRED` there is no need to ask the user — the main agent classifies and fixes all real bugs directly, and briefly explains false positives and existing behavior in context; after fixing, verify again and dispatch a brand-new reviewer for re-review. If serious or blocking issues remain after a soft cap of 3 rounds, stop the fix loop and truthfully report the remaining issues to the user.

## Wrap-up

Run the full verification, check the Specs, report branches, commits, verification results, and open issues, and ask the user what to do next. Do not create a PR or delete branches without the user's choice.

## KISS

- One sub-Spec, one worktree, one development node.
- The main agent holds repo topology (branches/worktrees/merges/cleanup) and in-wave scheduling; implementation and review go to subagents.
- State lives only in session context; add no integration branch, scheduler scripts, or state files.
- Completion notices arrive automatically; wait only when you need results to proceed. Never poll with `sleep`.

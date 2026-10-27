---
name: main-agent-driven-development
description: "Use only when the user or an orchestration skill explicitly invokes /main-agent-driven-development to complete a well-bounded implementation task."
---

# Main-agent-driven development

The current agent session implements a well-bounded Spec directly. The outer `/exec` orchestrator owns the worktree and merge lifecycle.

## Worktree modes

Choose exactly one:

- **Prebuilt mode** — when the caller already provided an isolated worktree and owns its lifecycle, use it directly; do not create, merge, or delete worktrees.
- **Standalone mode** — otherwise, identify the target repo, require the baseline to be on a named branch, record the starting SHA, and create a worktree under the repo's `.worktrees/`.

All operations must happen inside the chosen worktree. After isolation, do not edit the original checkout.

## Flow

1. Read the assigned Spec and the relevant repo instructions.
2. Confirm task boundaries, dependencies, acceptance criteria, and required verification. Ask questions only when a missing decision truly blocks implementation.
3. Initialize the task list from the Spec.
4. Project setup + baseline verification. Report first if the baseline fails; continue only when the failure is clearly unrelated and documented.
5. Implement directly, limited to the Spec's scope. Follow the `tdd` skill (bundled in this package): write a failing test first, then the minimal implementation.
6. After each logical step, run focused verification, self-review the diff, and commit when it is complete. Verification standard: run the command this round and confirm the output; never replace it with "it should pass".
7. After implementation, run all required verification.
8. When verification fails or review finds a bug, follow the `diagnosing-bugs` skill (bundled in this package): build a feedback loop to find the root cause first, then fix.
9. Run the internal review loop (see below). Exception: when acting as an implementation node in an `/exec` wave, **skip this step** — the review loop is run by `/exec`, and the node only implements, verifies, commits, and reports.
10. Commit all approved fixes and report to the caller.

Keep it KISS. Prefer reusing existing patterns, small and complete changes, and only the targeted refactoring the Spec requires.

## Internal review loop

After full verification, dispatch exactly one brand-new read-only reviewer subagent (quality tier):

```
subagent(
  prompt="Review <worktree-abs-path> from <base_sha> to HEAD.
         Spec: <path>
         Implementation summary: <brief>
         Changed files: <list>
         Verification already run: <commands and results>"
)
```

Require file and line numbers, and one status: `APPROVED` / `APPROVED_WITH_NOTES` / `CHANGES_REQUIRED` / `BLOCKED`.

Wait for the review with `wait_subagent`. Once results arrive, fix all necessary correctness errors, Spec gaps, security issues, integration risks, and verification gaps directly — no need to ask the user. After verifying and committing the fixes, dispatch a brand-new reviewer with `subagent` again. Repeat until `APPROVED` or only non-blocking suggestions remain.

Never self-approve, and never reuse an old reviewer.

## Completion contract

Before reporting completion, all of the following must hold:

- All assigned acceptance criteria are implemented
- Required verification ran and passed this round (backed by command output)
- No uncommitted implementation changes
- Internal review passed with no required fixes
- The final commit SHA is available

Report blockers truthfully. Do not merge on your own; the caller owns integration and cleanup.

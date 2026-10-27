---
name: dev
description: "Node contract for the DSH execution backend: prompt requirements, report formats, and failure semantics for implementation and review nodes."
---

# Built-in development backend (node contracts)

This skill defines the execution backend's two node types. Wave orchestration (worktrees, merging, cleanup, review-loop scheduling) belongs to `/exec`; this skill must not create, merge, or delete worktrees. Subagents have no independent working directory and cannot see the orchestration session: every node input must come with the prompt (absolute worktree path, Spec path, shared contracts, verification commands), with bash always using `workdir` and file tools always using absolute paths.

## Implementation node (develop)

One brand-new subagent (quality tier) handles exactly one sub-Spec, following `main-agent-driven-development` in prebuilt-worktree mode (in an `/exec` wave, skip its internal review step — the review loop is run by `/exec`, and nodes do not dispatch reviewers themselves).

Report format (JSON code block at the end of the closing message):

```js
{
  status: 'complete' | 'blocked',
  commit: '<final commit SHA>',
  verification: '<verification commands run this round and their results>',
  summary: '<implementation summary for the reviewer and orchestrator>',
  blocker: '<required when status=blocked>'
}
```

## Review node (review-only)

A brand-new read-only subagent (quality tier). The prompt supplies: absolute worktree path, diff range, Spec path, implementation summary, and verification already run. Four-state verdict format (JSON code block at the end of the closing message):

```js
{
  status: 'APPROVED' | 'APPROVED_WITH_NOTES' | 'CHANGES_REQUIRED' | 'BLOCKED',
  findings: ['<issue, with file and line number>']
}
```

Serious correctness errors, Spec gaps, integration risks, security issues, or missing verification must yield `CHANGES_REQUIRED`. Do not edit, commit, or merge.

## Failure semantics

A subagent failure (error / empty return) = `node-failed`; `blocked`, timeouts, partial replies, or uncommitted results never count as complete. The caller decides whether to redispatch, or to continue via `send_message` only when unblocking the same sub-Spec. Never reuse a node for another sub-Spec.

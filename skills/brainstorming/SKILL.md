---
name: brainstorming
description: "Design large requirements as multiple cooperating Specs. Use only when the user explicitly invokes /brainstorming, or asks to split a large task into executable Specs."
---

# Brainstorming Large Tasks

Turn a large requirement into one approved master Spec and at least two executable sub-Specs. Stay KISS: split only along real responsibility, dependency, or verification boundaries.

**The end state is a handoff to `/exec`.** Do not implement features, create worktrees, or invoke development skills. Stop once the user approves the written Specs.

## Process

1. **Explore project context** — inspect files, docs, and current project state. Look up facts yourself; do not ask the user.
2. **Ask one question at a time** — one decision question per message, walking the design tree systematically, each question led by a recommended answer. Separate facts (look up yourself) from decisions (the user's call). See the question rules below.
3. **Offer 2-3 options** — with tradeoffs and a recommendation, leading with the recommended option.
4. **Present the design in sections** — scale each section's length to its complexity, and get the user's confirmation on each. When a split is needed, present it (master Spec + sub-Specs, dependency order, shared contracts, integration acceptance).
5. **Write all Specs** — self-review after writing (placeholders, contradictions, ambiguity, over-detail) and fix inline. See self-review below.
6. **Dispatch a spec-reviewer** — per [`spec-document-reviewer-prompt.md`](spec-document-reviewer-prompt.md), dispatch a fresh read-only `subagent` (quality tier) to review the master Spec and all sub-Specs; fix blockers and re-dispatch if needed.
7. **Ask the user to review** — revise per feedback until approved.
8. **Hand off to `/exec`** — tell the user to invoke `/exec` with the master Spec path.

Done when: the master Spec and all sub-Specs are on disk, the user has approved them, and the `/exec` invocation has been given.

## Question rules

- **One question per message.** Wait for the answer before continuing. Asking several at once causes confusion.
- **Lead with a recommended answer.** Include the reasoning; the user can accept, reject, or amend it.
- **Facts vs decisions.** Get facts from the codebase or docs; never ask the user. Present decisions to the user and wait for an answer.
- **Prefer multiple choice**, though open-ended questions are fine too.
- **Focus on understanding:** goals, constraints, success criteria, architecture, error handling, testing.

Do not write Specs before consensus. When a later answer changes a premise, go back and fix earlier decisions.

## Design granularity

A sub-Spec defines **what and why**, plus the boundaries needed to implement and verify it independently. It is not an implementation recipe. (The master Spec is exempt — it is just goal + index; see the split guidance.)

- Include goals, scope, key decisions, component responsibilities, interactions, externally observable behavior, error semantics, acceptance criteria, and test scope.
- Leave local coding choices to implementation. No code, pseudocode, private type design, per-file change lists, or step-by-step instructions.
- Write exact public contracts (API routes, shared schemas, config keys) only when compatibility or migration depends on them.

## Split guidance

The master Spec carries only the overall goal + index (see Multi-Spec structure below), never any concrete execution content. **Lean toward more sub-Specs** — split as many as the task has independent units, with two as the floor; finer splits are worth it as long as each sub-Spec can still be implemented and verified independently. Every sub-Spec must be independently implementable and testable, suited to its own Spec → implementation cycle.

**Splitting pays off when:** the task is genuinely complex, with multiple independent subsystems or parallel tracks; each sub-Spec has a clear interface; and the split improves clarity rather than just enabling parallelism.

**Signals of over-splitting:** circular dependencies between sub-Specs; nothing can be verified independently; shared contracts diverge in several places; sub-Specs carved out with no independent responsibility.

Quality over parallelism — split for clarity, not just for parallel execution.

## Multi-Spec structure

### Master Spec

**Only the overall goal + index, no execution content.** Confined to: overall goal, scope and non-goals, sub-Spec index (one line per sub-Spec: responsibility + path), dependency DAG and parallel groups, and a pointer to overall acceptance. Push all concrete content — key decisions, shared contracts, component responsibilities, interactions, error semantics — down to the sub-Specs; the master Spec only names which sub-Spec defines/owns each contract. Never implement anything in the master Spec.

### Sub-Spec

What independent implementation, review, testing, and commit need: a boundary-clear goal, in-scope/out-of-scope behavior, dependencies, inputs/outputs and shared contracts, error semantics, acceptance criteria, a focused verification scope, and a link back to the master Spec. Do not copy the master Spec; carry over only the contracts execution needs.

## File layout

Pick one landing location based on the actual workspace; do not write to both:

```text
<workspace>/.workspace-docs/specs/MM-DD-<topic>-master-design/    # when the workspace has .workspace-docs/
<target-repo>/docs/specs/MM-DD-<topic>-master-design/             # otherwise the target repo's own specs directory
├── MM-DD-<topic>-master-design.md
├── MM-DD-<topic>-<subtask-A>-design.md
└── MM-DD-<topic>-<subtask-B>-design.md
```

- Link master Spec and sub-Specs to each other in both directions.
- When the directory already holds other Specs, follow their file naming and header format; do not introduce a second convention.
- When writing under `.workspace-docs/`, give every file an OKF header (`type: Design Spec`, `title`, `description`, `tags`, `status`, `repos`); committing and pushing follow that repo's own `AGENTS.md`. Where the target repo has no such convention, use its existing doc format and do not invent OKF.

## Self-review

After writing, check with fresh eyes: placeholders (`TODO`/`TBD`), internal consistency, scope focus, ambiguity, over-detail. Fix everything inline. This is your own first pass; a spec-reviewer subagent then does the independent review (process step 6).

## Visual aids

When showing beats telling (mockups, layouts, architecture diagrams, option comparisons), write a self-contained HTML file to the system temp directory (`$TMPDIR`, or `/tmp` when unset), named `brainstorm-<topic>-<n>.html`:

- Write the complete document with the write tool: inline CSS, no external dependencies, no scripts, no server; 2-4 options or variants per page.
- Never reuse a file name; for iterations write a new file (`-2`, `-3`).
- Tell the user the file path (the DSH UI can open it for preview directly) and summarize the page in one or two sentences; the user looks, then answers back in the conversation — clicks are not collected.
- Decide per question whether a visual helps; keep conceptual choices (A/B/C options, tradeoff lists) in the conversation.

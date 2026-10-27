---
name: handoff
description: Compress the current conversation into a handoff document for a fresh agent to continue from.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Compress the current conversation into a handoff document, so a brand-new agent can pick up the work without re-reading the parent session.

## Storage and reuse

- **Rewrite if one exists**: if a handoff document is already in the session context (written earlier in this session, or injected when the session started), rewrite that file in full; do not create a new one.
- **Otherwise create one**: when the workspace has `.workspace-docs/`, write to `.workspace-docs/notes/<repo-or-topic>/` — a handoff is essentially a note; otherwise write to the target repo's existing docs directory. Prefix the file name with the date and follow the naming style already used in that directory.
- When writing under `.workspace-docs/`, new files carry an OKF header (`type: Note` plus `title`/`description`/`tags`/`status`/`repos`), and are not registered in `index.md`; commit/push follows that repo's existing discipline. Where the target repo has no such convention, use its existing doc format.
- If neither location exists, fall back to the OS temp directory.

## Content requirements

- Include a "Suggested skills" section pointing the receiving agent at the skills it should invoke.
- Do not restate content already on disk (spec, plan, ADR, issue, commit, diff); give paths or URLs only.
- Record only objective facts and verification evidence; no self-justifying narrative.
- Redact sensitive content such as API keys, passwords, and personal identity information.
- When the user invokes it with an argument, that argument is the next session's focus; trim the document accordingly.

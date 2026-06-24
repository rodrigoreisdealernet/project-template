# ADR-0129: Separate Copilot PR Plain Merge-Conflict Recovery from Contamination Re-kick

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Copilot (implementation), factory process
- **Supersedes / Superseded by:** none

## Context

`.github/copilot-instructions.md` contained a single bullet under **Clean Session Bootstrap And Contamination Recovery** that grouped ordinary base-branch merge conflicts together with contaminated branch state and mandated closing the PR and re-kicking for both cases:

> "If contamination/conflict evidence appears (for example a contaminated branch state or merge conflicts against base), do **not** recover by rebasing the existing branch. Close the PR and request a clean re-kick from base."

At the same time, the file included a separate **Resolving Merge Conflicts** section describing how to resolve conflicts in place during `git merge` or `git rebase`, and both `.github/agents/project-manager.agent.md` and `.github/agents/pr-handler.agent.md` told factory agents to nudge Copilot to resolve plain `CONFLICTING` PRs in place and only re-kick on contamination or persistent conflict evidence.

This contradiction produced repeated reviewer nudges (`@copilot please rebase this PR on main`) followed by confusion about whether in-place resolution was permitted (PRs #1071, #1072). Reviewers and agents had no single canonical rule.

## Decision

We separate plain merge-conflict recovery from contamination re-kick in `.github/copilot-instructions.md`, making it consistent with the existing guidance in `project-manager.agent.md` and `pr-handler.agent.md`.

**Canonical rule (same across all three files):**

1. **Plain merge conflict** (`mergeable == "CONFLICTING"` with no other branch problems): resolve in place — fetch the base branch, merge or rebase, resolve conflicts while keeping the diff scoped, and push. This is the preferred first response.
2. **Contamination or persistent conflict**: close the PR and re-kick from a fresh base checkout when there is direct contamination evidence (dirty working tree, cross-scope file bleed, unrelated changes carried forward) **or** when the PR is still `CONFLICTING` after one guided in-place resolution attempt.

## Consequences

- Reviewers and factory agents now have one consistent decision rule for `CONFLICTING` Copilot PRs.
- In-place resolution is the first response for plain conflicts, reducing unnecessary re-kicks and preserving PR work.
- The re-kick escalation path is reserved for genuine contamination or unresolvable conflicts, which is the higher-cost action.
- The existing scope-guard requirement (no unrelated changes carried forward during conflict resolution) is preserved.

## Alternatives considered

- **Always re-kick on any conflict**: rejected because it discards PR work unnecessarily for ordinary base-branch divergence and contradicts the existing agent guidance that already correctly distinguished these cases.
- **Always resolve in place**: rejected because contaminated branches can carry cross-scope changes forward, which the scope guard must prevent.

## Evidence

- `.github/copilot-instructions.md` lines 50–54 (before this change): single bullet conflating contamination and plain conflicts.
- `.github/copilot-instructions.md` **Resolving Merge Conflicts** section: existing in-place resolution guidance that contradicted the bootstrap section.
- `.github/agents/project-manager.agent.md` lines 22–27: already separated plain conflict (in-place nudge) from contamination/persistent conflict (re-kick).
- `.github/agents/pr-handler.agent.md` lines 35–36: routing table already separated `conflicting` (in-place) from `conflicting fallback` (re-kick).
- Issue #1082, PRs #1071 and #1072: repeated reviewer nudges caused by the inconsistency.

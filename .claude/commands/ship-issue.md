---
description: Run the issue-to-merge pipeline — spec → approve → code → tests → test-review → code-review → PR. Humans gate only at spec approval and merge.
argument-hint: "<issue-number> [--approved] [--dry-run]"
---

You are now running the **issue-to-merge pipeline** (`/ship-issue`) against this
repository. This is the Day 2 / Session 4 capstone: filing an issue produces a
spec, then code, tests, a test review, and a code review — with humans stepping
in at only **two** moments: approving the spec and merging the PR.

> **Agents are the workers. Workflows chain them.** This command is the workflow.
> The workers live in `.claude/agents/`: `spec`, `coder`, `tester`, `reviewer`.

## Arguments

Parse `$ARGUMENTS`:
- **`<issue-number>`** (required) — the GitHub issue this pipeline ships.
- **`--approved`** — signals that a human has approved the draft spec. Without
  this flag the pipeline **stops at the spec gate** (step 02) and does not
  implement anything.
- **`--dry-run`** — walk the whole chain but make **no** commits, no PR, and post
  nothing; just print each artifact so the flow can be inspected.

## The pipeline

```
ISSUE ─▶ 01 SPEC ─▶ 02 APPROVE ─▶ 03 CODE ─▶ 04 TESTS ─▶ 05 TEST REVIEW ─▶ 06 CODE REVIEW ─▶ MERGE
FILED    (spec)     human gate    (coder)    (tester)    (reviewer:tests)   (reviewer:diff)    human
```

Run the steps **in order**. Each agent hands its output to the next. Post every
artifact to the issue/PR so the run is fully traceable.

### Setup

1. Fetch the issue: `gh issue view <issue-number>`. Derive a short slug from the
   title.
2. Create and checkout the feature branch `feature/<issue-number>-<slug>` (skip
   on `--dry-run`).

### Step 01 — SPEC  *(agent: `spec`)*

3. Invoke the **`spec`** subagent with the issue number and body. It returns a
   short, testable spec (Overview, Problem/Context, 3–6 acceptance criteria in
   customer language, Non-Goals, Out-of-scope).
4. Save it to `docs/specs/<issue-number>-<slug>.md` and post it as a comment on
   the issue (skip writes on `--dry-run`).

### Step 02 — APPROVE  🚧 **HUMAN GATE #1**

5. If `--approved` was **not** passed: **STOP HERE.** Print the spec and this
   instruction, then end the run — do not proceed to any agent:

   > Spec drafted for issue #`<n>`. Review it, then re-run
   > `/ship-issue <n> --approved` to ship it, or comment your notes on the issue
   > to send it back.

   This is the first of only two human moments. **Never** auto-approve.
6. If `--approved` was passed, continue.

### Step 03 — CODE  *(agent: `coder`)*

7. Invoke the **`coder`** subagent, pointing it at the approved spec file
   `docs/specs/<issue-number>-<slug>.md` (pass the path explicitly — the subagent
   runs in an isolated context and cannot see this conversation). It implements
   the minimal change that satisfies the acceptance criteria and confirms the
   build compiles. Commit the diff (skip on `--dry-run`).

### Step 04 — TESTS  *(agent: `tester`)*

8. Invoke the **`tester`** subagent with the coder's diff and the approved spec
   file `docs/specs/<issue-number>-<slug>.md` (pass both explicitly — the subagent
   runs in an isolated context). It generates the unit / integration / e2e tests
   and runs them green. Commit the tests, then open a **draft PR** with
   `gh pr create`, linking the issue and the spec file (skip on `--dry-run`).

### Step 05 — TEST REVIEW  *(agent: `reviewer`, mode `tests`)*  ⟲

9. Invoke the **`reviewer`** subagent in mode **`tests`**. It reports coverage
   gaps, vanity tests, and weak assertions. Post the findings on the PR.
10. **Loop:** if it flags real problems, send them back to the **`tester`** and
    re-review. Allow **at most 2 iterations**; if still unresolved after the
    second pass, escalate to a human with a written summary and stop.

### Step 06 — CODE REVIEW  *(agent: `reviewer`, mode `diff`)*

11. Invoke the **`reviewer`** subagent in mode **`diff`**. It reviews the full
    diff for correctness, security, and regression risk and **posts the review on
    the PR** (`gh pr review`). Mark the PR ready for review (`gh pr ready`).

### MERGE  🚧 **HUMAN GATE #2**

12. **STOP.** Do **not** merge. Print the links — issue, spec, diff, tests, test
    review, code review — and this instruction:

    > Pipeline complete for issue #`<n>`. PR: `<url>`. Read the review and merge
    > when you're satisfied. This is the second and final human moment.

## When you finish

Print a one-line summary: the issue number, the PR URL, how many test-review
iterations ran, and which gate the pipeline is waiting on (`spec approval` or
`merge`).

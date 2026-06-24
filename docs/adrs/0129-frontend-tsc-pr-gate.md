# ADR-0129: Promote frontend `tsc -b` check to PR validation gate

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Copilot (implementation), QA Manager
- **Supersedes / Superseded by:** —

## Context

The nightly code-quality workflow has run `npx tsc -b` in report-only mode and emitted the
result as `ts_errors` in `quality-results.json`. The `qa-targets.json` target is
`tsc_errors_max: 0`, but the check was never wired into PR validation — it was purely
post-merge telemetry.

As of PR #1206 (2026-06-24) all 59 accumulated TypeScript errors were fixed and
`tsc -b` now exits 0 on the `frontend/` project. With the error count at zero the check
is safe to add as a hard gate: a PR cannot regress the type safety of the frontend without
immediately failing CI, preventing future error accumulation of the kind tracked in issue #854.

## Decision

We add a `TypeScript type-check` step (`npx tsc -b`, working-directory: `frontend`) to the
`frontend` job in `.github/workflows/pr-validation.yml`, positioned after `Lint` and before
`Build`. The step is blocking (no `continue-on-error`).

## Consequences

- **Easier:** Type regressions are caught at PR time rather than the following nightly run,
  closing the gap between introduction and detection.
- **Enforced:** The `tsc_errors_max: 0` target in `qa-targets.json` is now backed by a
  hard gate, not just a dashboard metric.
- **Trade-off:** PR CI time increases by the time `tsc -b` takes (typically 5–15 s on a
  cold runner with `npm ci` already done, because the incremental `.tsbuildinfo` is not
  cached between steps).
- **New obligation:** Any PR that introduces TypeScript errors must fix them before merge.

## Alternatives considered

- **Keep check report-only (nightly only)** — rejected because the nightly-only posture
  allowed 59 errors to accumulate undetected. A PR gate provides continuous protection.
- **`tsc --noEmit` instead of `tsc -b`** — `tsc -b` respects project references
  (`tsconfig.json` + `tsconfig.node.json`) and produces the same output the nightly scan
  uses, so the gate matches the metric exactly.

## Evidence

- Issue: Volaris-AI/project-template#854
- Fixing PR: Volaris-AI/project-template#1206 — `f8caa4ab` "Eliminate frontend TypeScript
  build errors across workflow, engine, and config modules"
- Nightly run showing `ts_errors: 59`:
  https://github.com/Volaris-AI/project-template/actions/runs/28077137754
- `qa-targets.json`: `.github/qa-targets.json` line `"tsc_errors_max": 0`
- Gate added in: `.github/workflows/pr-validation.yml` (`frontend` job, step
  "TypeScript type-check")

# ADR-0127: Nightly CodeQL is soft-gated behind GHAS availability

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Copilot coding agent
- **Supersedes / Superseded by:** Extends ADR-0072

## Context
`Code quality (nightly)` runs CodeQL for `javascript-typescript` and `python` in `.github/workflows/code-quality.yml`.

On this private organization billing plan, GitHub Advanced Security (GHAS) code-scanning upload is not available, and CodeQL jobs repeatedly fail with `Resource not accessible by integration`. This creates noisy nightly failures without improving signal from the other non-gating scanners.

## Decision
We keep the CodeQL job in the nightly workflow but run it only when GHAS is available: public repositories run it by default, and private repositories require `ENABLE_GHAS_CODEQL=true`. The job remains `continue-on-error: true` to preserve non-gating behavior.

## Consequences
- Nightly quality runs skip CodeQL gracefully on private repos without GHAS and continue running Semgrep, Trivy, gitleaks, and other scanners.
- When GHAS is enabled later, maintainers can opt back in by setting `ENABLE_GHAS_CODEQL=true` with no workflow restructuring.
- CodeQL findings become best-effort on private repos until GHAS is enabled.

## Alternatives considered
| Option | Reason rejected |
|---|---|
| Remove CodeQL from nightly entirely | Loses a ready path to restore CodeQL quickly when GHAS becomes available |
| Keep CodeQL always-on and failing | Continues known billing-tier failures and obscures useful nightly scanner output |

## Evidence
- `.github/workflows/code-quality.yml`
- Issue: `Volaris-AI/project-template#1194`
- Failing run: `https://github.com/Volaris-AI/project-template/actions/runs/28077137754`

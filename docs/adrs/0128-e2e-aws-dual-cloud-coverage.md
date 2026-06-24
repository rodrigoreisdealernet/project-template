# ADR-0128: Add AWS E2E workflow for dual-cloud coverage

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Copilot (implementation), QA Manager, Platform Engineer
- **Supersedes / Superseded by:** —

## Context

The project targets both Azure (AFD/AKS) and AWS (CloudFront/EKS) deployments. The Azure dev
environment is covered by `e2e-dev.yml`, which runs Playwright hourly against `vars.E2E_BASE_URL`
(Azure Front Door URL). No equivalent workflow existed for the AWS deployment, leaving the AWS
application stack without any automated end-to-end coverage — no proof that the CloudFront
distribution and EKS-hosted app work end-to-end.

The AWS app stack (`terraform/stacks/10x-stack-aws-dev/`) had not been applied yet, so the new
workflow must skip cleanly when `vars.E2E_AWS_BASE_URL` is unset, following the same skip-budget
pattern as `e2e-dev.yml`.

## Decision

We add `.github/workflows/e2e-aws.yml` as a parallel E2E workflow targeting the AWS (CloudFront)
environment. It follows the same structure as `e2e-dev.yml` with these differences:

- **Name:** `Test - E2E AWS`
- **Schedule:** hourly at `:47` (offset from `e2e-dev.yml`'s `:17` to avoid concurrent load)
- **Trigger:** `workflow_run` on `Deploy - Dev (AWS)` (future AWS deploy workflow)
- **Concurrency group:** `e2e-aws`
- **Environment:** `aws-dev` (where `vars.E2E_AWS_BASE_URL` and secrets are configured)
- **History suite names:** `aws-smoke` and `aws-experience` (prefixed to distinguish from Azure
  records in the shared `e2e-history` branch `runs.jsonl`)
- **Incident fingerprint:** `e2e-aws-failure` (separate dedup key from Azure incidents)
- **Workflow health cloud tag:** `WORKFLOW_CLOUD: aws`

We update `e2e-history-render.mjs` to render per-environment panels in the trend SVG and README,
supporting both `smoke`/`experience` (Azure) and `aws-smoke`/`aws-experience` (AWS) suite records
from the same `runs.jsonl` feed.

We add the `E2E AWS` badge to `README.md` and a row in the workflow map.

## Consequences

- AWS E2E coverage is established the moment `E2E_AWS_BASE_URL` is set in the `aws-dev`
  Actions environment after the Terraform stack is applied.
- The single `runs.jsonl` on `e2e-history` holds records from both clouds; suite-name prefixes
  distinguish them without requiring separate branches or files.
- The `e2e-history-render.mjs` dashboard now renders both Azure and AWS rows, making dual-cloud
  pass rates visible in one place.
- A new `aws-dev` GitHub Actions environment must be created (or will be auto-created) before the
  AWS workflow can supply `vars.E2E_AWS_BASE_URL` and the shared secrets.
- The same auth test accounts (`E2E_AUTH_EMAIL` etc.) are reused because the AWS frontend points
  at the same Supabase backend; only the base URL differs.

## Alternatives considered

- **Separate `e2e-history` branch for AWS:** Keeps feeds completely isolated but requires
  duplicate dashboard infrastructure. Rejected in favour of the simpler suite-prefix approach.
- **Single workflow with matrix strategy:** Would couple Azure and AWS runs, complicate skip
  logic, and require a matrix-aware concurrency group. Rejected to keep each cloud's workflow
  independently triggerable and independently skip-able.
- **Reuse `e2e-dev.yml` with a dispatch input:** Would work but adds complexity to `e2e-dev.yml`
  (a control-plane boundary) unnecessarily. Rejected to keep Azure and AWS concerns separate.

## Evidence

- `.github/workflows/e2e-aws.yml` — new workflow file
- `.github/workflows/e2e-dev.yml` — reference implementation (unchanged)
- `.github/scripts/e2e-history-render.mjs` — updated to render Azure + AWS panels
- `README.md` — AWS E2E badge added; workflow map row added
- `terraform/stacks/10x-stack-aws-dev/` — AWS stack (not yet applied; human-only step)

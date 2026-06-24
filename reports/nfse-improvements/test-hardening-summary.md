# NFS-e Ingestion — Test Hardening (Day 2 · Session 3)

_"Harden the Test Suite" — generate → review → act → attack → promote → run & document._
Date: 2026-06-24

## How it's tested

The NFS-e automated ingestion feature is covered at three layers, all with mocked
dependencies (no live Temporal / Supabase / Azure required):

| Layer | File | What it proves |
|-------|------|----------------|
| Workflow orchestration | `temporal/tests/nfse-ingest.integration.test.ts` | Runs the real DSL interpreter in `TestWorkflowEnvironment` with every activity stubbed: happy path (extract + persist per invoice), the `content_filter_blocked` persistence guard, per-invoice `try_catch` resilience, empty listing no-op, low-confidence still persists, and `llm_agent` arg fidelity (model/temperature/schema/prompt). |
| Dedup activity | `temporal/tests/nfse_list_new.test.ts` | Read-side dedup, bounded membership read (`source_url=in.(...)`), chunking >100, plus error paths (source non-2xx, non-JSON, DB read failure, missing service key, malformed rows) and the two red-team regressions below. |
| Persistence contract | `temporal/tests/supabase_query.test.ts` | The exact NFS-e upsert: `on_conflict=source_url`, `Prefer: resolution=merge-duplicates`, body shape (`source_url`/`extracted_fields`/`confidence`/`extracted_at`), and rejection of an empty-match upsert. |
| Definition (structural) | `temporal/tests/nfse-ingest.definition.test.ts` | Navigates the parsed control-flow tree (not substring matching): `nfse_list_new` first, `llm_agent` w/ `gpt-5.4` + `nfse_extraction` schema, upsert keyed on `source_url`, and the content-filter guard wrapping the mutate step. Plus seed-migration drift guard. |
| UI helpers | `frontend/src/routes/nfse/nfse-extractions.test.tsx` | `isLowConfidence`, `needsReview`, `countPendingReview`, `isOutOfRangeConfidence`. |
| UI component | `frontend/src/routes/nfse/nfse-extractions-page.test.tsx` | Renders `<NfseExtractionsPage/>`: row rendering + BRL formatting + confidence badge, review filter, loading/error/empty/review-empty states, and `Scan now` success/error paths. |

## Step 2 — independent review (second AI)

A separate review agent critiqued the whole suite for vanity coverage, weak
assertions, and tests that pass for the wrong reason. Key findings acted on:

- **The NFS-e persistence contract was never executed** (orchestration test stubs
  `supabase_mutate`; generic test only covered another table) → added the exact
  upsert contract test.
- **The entire React component was untested** (only pure helpers) → added 10
  component-render tests.
- **Definition tests were string-match vanity** (`toContain` / `indexOf`) → replaced
  with structural navigation of the parsed tree.
- Strengthened weak assertions (`llm_agent` args, caught-error content).

## Step 4/5 — adversarial attack → fixes → permanent regression tests

A red-team agent attacked the feature. Confirmed defects fixed, each with a
promoted regression test:

| # | Defect | Fix | Regression test |
|---|--------|-----|-----------------|
| 1 | PostgREST `in.()` escaped `"` with `\"` (backslash) instead of `""` (doubled) — could silently drop or re-process invoices with a quote in the URL | `nfse_list_new.ts` — double the quote | `nfse_list_new.test.ts` "escapes embedded double-quotes …" |
| 2 | Stored XSS: a `javascript:` `source_url` rendered as a clickable link (React 19 does not sanitize hrefs) | `index.tsx` — `isSafeHttpUrl` allow-list (http/https only) | `nfse-extractions-page.test.tsx` "does not render a clickable link for a javascript: source_url" |
| 3 | Confidence never range-checked → `1.5` rendered "150%" as **high confidence**, bypassing review | `index.tsx` — `isOutOfRangeConfidence`; `needsReview` flags out-of-range | helper + component tests for `1.5` / `-0.2` |
| 4 | `formatBRL` rendered `NaN`/`Infinity` as currency | `index.tsx` — `Number.isFinite` guard | "renders an em dash for a non-finite valor_total" |
| 5 | Intra-batch duplicate `content_url` → double LLM spend + double upsert | `nfse_list_new.ts` — de-dup the batch by `content_url` before the membership read | "de-duplicates identical content_urls within a single source batch" |

Deliberately **not** changed: adding `minimum/maximum` to the DSL `confidence`
schema. It would churn the drift-guarded definition + seed migration and risks the
model retry-looping on float noise; the UI-layer `needsReview` flag is the safer,
user-protective mitigation.

## Step 6 — full-suite results (2026-06-24)

- **NFS-e temporal tests:** 32 passing (`nfse_list_new`, `nfse-ingest.definition`,
  `nfse-ingest.integration`, `supabase_query`).
- **NFS-e frontend tests:** 24 passing (`nfse-extractions` + `nfse-extractions-page`).

Full-suite runs surface pre-existing failures **unrelated to NFS-e** (verified by
re-running with these changes stashed — identical failures on baseline):
- Frontend: `workflow-trigger-navigation`, `workflow-execution-detail-graph` (flaky).
- Temporal: `validate-definitions-script`, `lint-ontology-script` (Windows
  child-process spawn returns empty stdout/stderr).

These are owned by the `workflows`/tooling areas, not this feature.

# ADR-0152: Automated NFS-e Ingestion as a DSL Workflow on Azure gpt-5.4

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Rodrigo Reis (Dealernet), AI-DLC workflow
- **Supersedes / Superseded by:** —

## Context

The Day 2 Session 2 exercise requires a feature that touches the database, shows up on
screen, and does its real thinking through a model call inside a Temporal workflow —
not a dashboard, not a chatbot. We chose **automated ingestion and field extraction of
Brazilian service invoices (NFS-e)**: the system fetches new invoices from a source,
extracts structured fiscal fields with an LLM, persists them, and presents them — with
no manual paste or upload. In production the source is a real API; for the POC it is a
local mock API.

The 10x template already ships the building blocks: a JSON-DSL workflow engine
(`DSLWorkflow`), a multi-provider LLM activity (`llm_agent`, ADR-0008), a URL-based
document fetch+parse activity (`file_extract`), the only real DB write path
(`supabase_mutate`), an Edge Function trigger path, and an execution-detail screen. A
skeleton `doc-extraction.json` existed but was non-functional (wrong table name,
hardcoded Anthropic provider, a confidence gate that skipped the write, generic schema).

Two design questions had to be settled: **how to shape the workflow** and **how to host
the model** (the Day 2 ADR step), plus **how to deduplicate** already-processed invoices.

## Decision

1. **Workflow shape — a DSL definition, not a dedicated TypeScript workflow.** The
   feature is implemented as `temporal/definitions/nfse-ingest.json`: `nfse_list_new`
   → `for_each` invoice (`try_catch`) → `file_extract` → `llm_agent` → conditional
   `supabase_mutate`. This reuses the entire trigger → tracking → execution-detail path
   bound to `DSLWorkflow`; a dedicated TS workflow would require new `server.ts` wiring
   and forfeit tracking + the detail screen.

2. **Model hosting — Azure OpenAI `gpt-5.4` via pi-ai `azure-openai-responses`.**
   Configured by environment only (no code): `PIAGENT_PROVIDER=azure-openai-responses`,
   `PIAGENT_MODEL_ID=gpt-5.4`, `AZURE_OPENAI_BASE_URL=https://accelerator-foundary.cognitiveservices.azure.com`,
   `AZURE_OPENAI_API_KEY` (gitignored). The adapter uses Azure **Chat Completions**
   (`/openai/v1/chat/completions`) with `api-key` + `api-version` headers. The default
   non-Azure provider remains Anthropic. (Note: `gpt-5.4` is 404 on the older
   `volarisiaisandboxazureopenai` resource; it is deployed and verified on the
   `accelerator-foundary` resource used here.)

3. **Source — a pluggable HTTP source.** The workflow depends only on
   `GET /invoices` + `GET /invoices/:id/content` at `NFSE_SOURCE_API_URL`. The POC ships
   a small `mock-nfse-api` Compose service serving the sample PDFs in `docs/examples/`;
   production swaps the base URL for the real API with no workflow change.

4. **Dedup — a `nfse_list_new` activity that filters before the model call.** Because
   the DSL expression layer's `$env.*` resolves from the workflow variable bag (not the
   worker process env) and `supabase_query` (read) is a stub, the DSL cannot read the DB
   with service credentials. `nfse_list_new` runs worker-side (where `config` exposes the
   Supabase URL + service key), lists the source, and returns only invoices whose
   `content_url` is not already a `source_url` in `workflow_document_extractions`. This
   skips already-processed invoices *before* any model call.

5. **Automatic trigger — a Temporal Schedule (every 15s, overlap=SKIP)** created by
   `scripts/bootstrap-nfse-schedule.ts`, plus a manual "Scan now" on the results screen
   via the existing Edge Function path.

6. **Persistence — unconditional, service-role-only, idempotent.** Successful
   extractions are upserted into `workflow_document_extractions` keyed on `source_url`
   (no confidence gate). Low confidence is flagged in the UI; `content_filter_blocked`
   results are not persisted and are recorded in the trace.

## Consequences

**Positive:**
- Maximum reuse: only one new activity (`nfse_list_new`) and one new tiny service
  (`mock-nfse-api`); everything else is composition + config.
- Production parity: swapping the source is a URL change; the model is env-only.
- Steady-state is cheap: with 15s cadence + dedup, runs become no-ops once all invoices
  are processed (no repeated LLM calls).
- Observable and resilient: per-invoice `try_catch`, full step tracing, Temporal UI.

**Negative:**
- The active definition lives in `workflow_definitions` (seed/migration) **and** as a
  file; the two must be kept in sync. The Schedule also embeds the definition JSON.
  *(Mitigated 2026-06-24 — improvement #1: the file is the single source of truth, the
  seed now mirrors it verbatim, and `temporal/tests/nfse-ingest.definition.test.ts`
  fails on any drift between file ↔ seed and if the bootstrap re-embeds a copy.)*
- A 15s Schedule adds constant (cheap) source-list + DB-read traffic. *(Reduced
  2026-06-24 — improvement #2: dedup is now a bounded `source_url=in.(...)` membership
  read over only the current source list, not a full-table scan, so the per-cycle DB
  cost no longer grows with the number of already-processed invoices.)*
- LLM extraction is non-deterministic; correctness depends on prompt + schema, not on
  unit tests.

**Neutral:**
- All three AI-DLC extensions (security, resiliency, PBT) are disabled (PoC); the
  template's existing security posture (auth lockdown, MFA, service-role-only writes) is
  preserved unchanged.

## Options Considered

- **Dedicated TypeScript workflow** — clearer to read, but breaks reuse of the trigger
  and execution-detail path and needs new `server.ts` code. Rejected.
- **Upsert-only dedup (no pre-read)** — simplest, but re-runs the model for every invoice
  every cycle (cost). Rejected.
- **Per-item PostgREST existence check inside the DSL (`$env` creds)** — blocked: `$env`
  does not expose the worker process env, so the DSL can't authenticate to Supabase.
  Replaced by the `nfse_list_new` activity.
- **Pasted-text input (from the earlier deep-research analysis)** — superseded by the
  explicit requirement that the system fetch automatically (no paste/upload).

## Evidence
- `temporal/definitions/nfse-ingest.json` — the workflow definition.
- `temporal/src/activities/nfse_list_new.ts` — source list + DB dedup.
- `supabase/migrations/20260624160000_seed_nfse_ingest_definition.sql` — activation.
- `supabase/functions/trigger-workflow/index.ts` — `nfse-ingest` whitelisted.
- `scripts/bootstrap-nfse-schedule.ts` + `Makefile` (`nfse-schedule`) — the Schedule.
- `frontend/src/routes/nfse/index.tsx` — results screen + Scan now.
- `mock-nfse-api/` — POC source service.
- ADR-0001 (Temporal DSL), ADR-0006 (Temporal orchestration), ADR-0008 (LLM adapter),
  ADR-0023 (authenticated write path), ADR-0024 (additive migrations).

## Post-Construction Improvements (2026-06-24)

Three additive, unit-tested enhancements applied after construction (no behavior change
to the happy path; verified by unit tests, nothing committed):

1. **Definition single-source-of-truth + drift guard** — the seed migration's embedded
   JSON now mirrors `temporal/definitions/nfse-ingest.json` verbatim, and
   `temporal/tests/nfse-ingest.definition.test.ts` asserts seed↔file deep-equality and
   that the Schedule bootstrap derives from the file (no re-embedded copy). Addresses the
   "Negative" above.
2. **Bounded dedup** — `temporal/src/activities/nfse_list_new.ts` now reads existing
   `source_url`s via a chunked `source_url=in.(...)` membership query over the current
   source list instead of scanning the whole `workflow_document_extractions` table each
   cycle; an empty source list skips the DB read entirely.
3. **Low-confidence review path (UI)** — `frontend/src/routes/nfse/index.tsx` adds a
   pending-review counter, a "show only pending review" filter, and a link to the original
   document (`source_url`), surfacing low-confidence extractions for human verification
   without re-introducing a confidence gate on the write path.

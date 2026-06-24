# Code Generation Summary — nfse-ingestion

All 10 plan steps executed. Files below; application code in the workspace root, docs here.

## Design-risk resolution (Step 3 / Design C)
The functional design proposed per-item dedup via a DSL `condition` + PostgREST `http_request` using `$env` creds. **During generation this proved infeasible**: the DSL expression layer resolves `$env.*` from the workflow variable bag, NOT the worker `process.env`, so a DSL step cannot authenticate to Supabase; and `supabase_query` (read) is a stub. **Resolution:** a small new activity `nfse_list_new` lists the source AND filters already-extracted invoices server-side (where `config` exposes the Supabase URL + service key), returning only new invoices. This is the "minimal helper" the design-risk check anticipated. Design docs back-propagated (business-logic-model.md, frontend-components.md). Captured in ADR-0152.

## Files created
| File | Purpose | Reqs |
|---|---|---|
| `mock-nfse-api/package.json`, `src/server.js`, `Dockerfile` | POC source API: `GET /invoices`, `GET /invoices/:id/content` over `docs/examples/` PDFs | FR-1, BR-3 |
| `temporal/src/activities/nfse_list_new.ts` | Lists source + DB dedup (returns new invoices + `run_at`) | FR-2/6, BR-1/2 |
| `temporal/definitions/nfse-ingest.json` | DSL workflow: list → for_each(try_catch) → file_extract → llm_agent(Azure gpt-5.4) → conditional supabase_mutate | FR-2/3/4/10, BR-4/8/10 |
| `supabase/migrations/20260624160000_seed_nfse_ingest_definition.sql` | Activates the definition (`is_active=true`), idempotent | FR-9, BR-19 |
| `scripts/bootstrap-nfse-schedule.ts` | Creates Temporal Schedule (15s, overlap=SKIP) | FR-7, BR-12/13 |
| `frontend/src/routes/nfse/index.tsx` | Results screen (reads `workflow_document_extractions` via supabase-js) + "Scan now" + low-confidence badge | FR-8, BR-9 |
| `frontend/src/workflows/definitions/nfse-ingest.json` | Frontend trigger registry entry | FR-9 |
| `docs/adrs/0152-nfse-automated-ingestion.md` | Decision record (workflow shape, model hosting, source, dedup) | Day-2 SDD step 4 |
| `temporal/tests/nfse-ingest.definition.test.ts` | Validates the definition (schema, table, provider, dedup, gate) | NFR-TEST |
| `temporal/tests/nfse_list_new.test.ts` | Dedup logic (lists, filters already-extracted) | NFR-TEST, BR-1/6 |
| `frontend/src/routes/nfse/nfse-extractions.test.tsx` | Low-confidence flag rule | NFR-TEST, BR-9 |

## Files modified
| File | Change | Reqs |
|---|---|---|
| `.env.example` | Documented `NFSE_SOURCE_API_URL` + accelerator-foundary gpt-5.4 note | FR-3 |
| `.env` (gitignored, created) | Real Azure creds + provider + source URL (local only; not committed) | BR-17 |
| `docker-compose.yml` | Added `mock-nfse-api` service (+volume mount) + worker `NFSE_SOURCE_API_URL`/`AZURE_OPENAI_API_VERSION` + depends_on | FR-1/3 |
| `temporal/src/config.ts` | Added `nfseSourceApiUrl` getter | FR-3 |
| `temporal/src/worker.ts` | Registered `nfse_list_new` activity | FR-2 |
| `supabase/functions/trigger-workflow/index.ts` + `index.test.ts` | Whitelisted `nfse-ingest` (+ test) | FR-9, BR-18 |
| `Makefile` | Added `nfse-schedule` target + call in `up` | FR-7 |
| `frontend/src/workflows/definitions.ts` | Registered `nfse-ingest` | FR-9 |
| `frontend/src/routes/__root.tsx` | Sidebar link to `/nfse` | FR-8 |

## Not done by design
- No new worker activity beyond `nfse_list_new`; no schema change (reused `workflow_document_extractions`); no PBT (PoC); no cloud/Helm changes.

## Sync caveat
The definition JSON exists in three places that must agree: `temporal/definitions/nfse-ingest.json` (source), the migration (DB-active row), and the Schedule action args (embedded at creation from the file). Build & Test will verify the live run.

# Code Generation Plan — unit: nfse-ingestion

> ✅ **GENERATION COMPLETE (2026-06-24):** all 10 steps executed. File-by-file results in `aidlc-docs/construction/nfse-ingestion/code/code-summary.md`. Design-C dedup resolved to the `nfse_list_new` activity (back-propagated to functional design + ADR-0152). Verification happens in Build & Test.

**This plan is the single source of truth for Code Generation.** Steps execute in order; each is checked off `[x]` as completed. Brownfield: **modify existing files in place; never create `*_new`/`*_modified` duplicates.**

- **Workspace root**: `C:\Dev\AIAccelerator\project-template`
- **Unit**: `nfse-ingestion` (single unit)
- **Requirements traceability**: FR-1..10, BR-1..19, NFR-SEC/PERF/MAINT/OBS/COMPAT (see requirements.md + functional-design/).
- **Code docs summaries** go in `aidlc-docs/construction/nfse-ingestion/code/` (markdown only). All application code in the workspace root tree.

---

## Step 1 — Worker env & source config wiring  *(FR-3, BR-17)*
- [ ] **Modify** `.env.example` — add `NFSE_SOURCE_API_URL=http://mock-nfse-api:8090` and confirm Azure canonical vars are documented (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION`, `PIAGENT_PROVIDER`, `PIAGENT_MODEL_ID`). **No secrets.**
- [ ] **Modify** `docker-compose.yml` (`temporal-worker.environment`) — add `NFSE_SOURCE_API_URL=${NFSE_SOURCE_API_URL:-http://mock-nfse-api:8090}`. (Azure vars already present.)
- [ ] **Create (gitignored, local only)** `.env` — real Azure creds + `PIAGENT_PROVIDER=azure-openai-responses`, `PIAGENT_MODEL_ID=gpt-5.4`, `AZURE_OPENAI_BASE_URL=https://accelerator-foundary.cognitiveservices.azure.com`, `AZURE_OPENAI_API_VERSION=2025-04-01-preview`, `AZURE_OPENAI_API_KEY=<secret>`. **Never committed** (matches `.gitignore`). Verify gitleaks-clean before any commit.

## Step 2 — Mock NFS-e API service (POC source)  *(FR-1, BR-3)*
- [ ] **Create** `mock-nfse-api/package.json` — minimal Node + Hono service.
- [ ] **Create** `mock-nfse-api/src/server.ts` — `GET /invoices` → `[{id, filename, content_url}]` for each PDF in the mounted invoices dir; `GET /invoices/:id/content` → streams the PDF (`Content-Type: application/pdf`). `content_url` = `${PUBLIC_BASE_URL}/invoices/:id/content` (PUBLIC_BASE_URL defaults to the in-network URL).
- [ ] **Create** `mock-nfse-api/Dockerfile` — node:22-slim, runs the server on :8090.
- [ ] **Modify** `docker-compose.yml` — add service `mock-nfse-api` (build `./mock-nfse-api`, mount `./docs/examples:/app/invoices:ro`, expose `127.0.0.1:8090`, on the compose network so the worker reaches `http://mock-nfse-api:8090`). Add `temporal-worker.depends_on: mock-nfse-api`.

## Step 3 — The `nfse-ingest` DSL definition  *(FR-2,3,4,6,10; BR-1,4,5,6,8,10,14,15,16)*
- [ ] **Create** `temporal/definitions/nfse-ingest.json` — DSL:
  - `input_schema`: optional `run_at` (+ allow empty input).
  - step: `http_request` GET `$env.NFSE_SOURCE_API_URL/invoices` → `invoices`.
  - `for_each` (`items=$var.invoices`, `item_var=inv`, mode **sequential**):
    - `try_catch.try` sequence:
      - `http_request` GET `$env.SUPABASE_URL/rest/v1/workflow_document_extractions?source_url=eq.$var.inv.content_url&select=source_url` with headers `apikey`/`Authorization: Bearer $env.SUPABASE_SERVICE_ROLE_KEY` → `existing`.
      - `condition` **if `existing` is empty** (new invoice) → then sequence: `file_extract` → `llm_agent` → `condition` (if not `content_filter_blocked`) → `supabase_mutate` upsert into `workflow_document_extractions` (match `source_url`, values: source_url, extracted_fields=`$var.extraction.parsed`, confidence, extracted_at=`$input.run_at`). else → no-op (skip).
      - `else` (already exists) → no-op.
    - `try_catch.catch` → record error (no abort).
  - `llm_agent` args: `provider=azure-openai-responses`, `model_id=gpt-5.4`, `temperature=0`, NFS-e 19-field `response_schema` (`additionalProperties:false`, required: numero_nota/prestador_razao_social/tomador_razao_social/valor_total/confidence; others nullable), `schema_name=nfse_extraction`, `user_prompt=$var.doc.text`, system prompt instructing PT-BR NFS-e extraction + numeric values with decimal point + null for missing.
- [ ] **Validate** against the DSL schema (`temporal/src/workflows/dsl/schema.ts`).
- [ ] **DESIGN-RISK CHECK (BR-1 / Design C)**: confirm the DSL expression layer can evaluate "`existing` array is empty" in `condition.if`. If it CANNOT, add the minimal fallback: a `set_variable`/`transform_data` step computing boolean `is_new`, and branch on that. Document the outcome in the code summary.

## Step 4 — Activate the definition (Supabase)  *(FR-9, BR-19; ADR-0024 additive)*
- [ ] **Create** `supabase/migrations/20260624160000_seed_nfse_ingest_definition.sql` — `insert ... on conflict (name, version) do update` into `workflow_definitions` (`name='nfse-ingest'`, `version='1.0.0'`, `definition=<the JSON>`, `is_active=true`, `review_status='approved'`, `deployed_at=now()`). Idempotent. (Satisfies the FK from `workflow_executions` and the "active definition" trigger lookup.)
- [ ] Confirm **no schema change** to `workflow_document_extractions` (reuse as-is).

## Step 5 — Edge Function whitelist  *(FR-9, BR-18)*
- [ ] **Modify** `supabase/functions/trigger-workflow/index.ts` — add `"nfse-ingest"` to `TRIGGERABLE_DEFINITIONS`.
- [ ] **Modify** `supabase/functions/trigger-workflow/index.test.ts` — add a case asserting `nfse-ingest` is allowed (kept-out definition still 403).

## Step 6 — Temporal Schedule bootstrap  *(FR-7, BR-12,13)*
- [ ] **Create** `scripts/bootstrap-nfse-schedule.ts` — uses `@temporalio/client` to create (idempotent) a Schedule `nfse-ingest-15s`: interval **15s**, overlap policy **SKIP**, action = start `DSLWorkflow` with the active `nfse-ingest` definition input (`{ run_at: <now> }` resolved at trigger). Reads `TEMPORAL_ADDRESS`/namespace/task-queue from env.
- [ ] **Modify** `Makefile` — add target `nfse-schedule` (runs the bootstrap via ts-node) and call it near the end of `up` (after worker is healthy + definition active). Tolerate "already exists".

## Step 7 — Frontend results page + Scan now  *(FR-8, BR-9,18; ADR-0018/0019)*
- [ ] **Create** `frontend/src/pages/nfse-extractions.json` — JSON page: Supabase data source on `workflow_document_extractions` (select id, source_url, extracted_fields, confidence, extracted_at; order created_at desc; limit 100); header with **"Scan now"** button (`data-testid="nfse-scan-now-button"`); table rows binding `extracted_fields.*` (numero_nota, prestador_razao_social, tomador_razao_social, valor_total, data_emissao) + confidence with **low-confidence badge** when `{{row.confidence < 0.7}}`; empty state.
- [ ] **Create** `frontend/src/routes/nfse/index.tsx` — route wrapping `UIEngine` with the page JSON.
- [ ] **Modify** `frontend/src/routes/__root.tsx` — add sidebar nav link to `/nfse`.
- [ ] **Create** `frontend/src/workflows/definitions/nfse-ingest.json` + **Modify** `frontend/src/workflows/definitions.ts` — register `nfse-ingest` (so it's triggerable from the generic screen and the Scan-now action uses the same Edge path: POST `${VITE_API_URL}/trigger-workflow` `{definition_name:"nfse-ingest", input:{}}`).
- [ ] Ensure "Scan now" refetches the data source after a short delay; reuse the fetch pattern from `routes/workflows/trigger.tsx`.

## Step 8 — Tests (example-based — NFR-TEST)
- [ ] **Create** `temporal/tests/nfse-ingest.definition.test.ts` — load `nfse-ingest.json`, assert it passes `validateDefinition`, and assert key bindings (table name `workflow_document_extractions`, provider `azure-openai-responses`, dedup condition present).
- [ ] **Create/adapt** `temporal/tests/nfse-ingest.integration.test.ts` — drive the DSL interpreter with a stubbed `file_extract`/`llm_agent`/`http_request` and assert one `supabase_mutate` upsert is issued with the expected shape (and that an already-existing `source_url` is skipped). (Adapt the existing `scripts/test-doc-extraction.ts` harness pattern.)
- [ ] (Edge whitelist test handled in Step 5.)
- [ ] **Create** `frontend/src/routes/nfse/nfse-extractions.test.tsx` — render the page with mocked rows; assert key fields render and the low-confidence badge appears when confidence < 0.7.

## Step 9 — ADR (decision record)  *(Day 2 SDD step 4; CONTRIBUTING ADR requirement)*
- [ ] **Create** `docs/adrs/0152-nfse-automated-ingestion.md` (next free number; confirm against `docs/adrs/README.md`) using the repo ADR template. Record:
  - **Decision**: automated NFS-e ingestion as a DSL `for_each` workflow (`nfse-ingest`), not a dedicated TS workflow.
  - **Model hosting**: Azure OpenAI `gpt-5.4` via pi-ai `azure-openai-responses` (Chat Completions path), env-configured.
  - **Source**: pluggable HTTP source (mock API locally; real API in prod) — swap by base URL.
  - **Dedup**: per-item PostgREST existence check before the model call (Design C).
  - **Consequences / alternatives considered** (dedicated TS workflow; upsert-only dedup; bulk pre-read).

## Step 10 — Code documentation summaries
- [ ] **Create** `aidlc-docs/construction/nfse-ingestion/code/code-summary.md` — list of files created/modified with one-line purpose + which FR/BR each satisfies + the resolved Design-C outcome (Step 3 risk check result).

---

## Generation order rationale (dependencies)
Env (1) → mock API (2) → definition (3) → activate (4) → edge whitelist (5) → schedule (6) → frontend (7) → tests (8) → ADR (9) → summaries (10). Build & verification happen in the next stage (Build & Test).

## Scope / out-of-scope reminder
- Reuse: `http_request`, `file_extract`, `llm_agent`, `supabase_mutate`, DSL engine, Edge trigger path, execution-detail screen.
- No new worker activity unless Step 3's design-risk check forces a minimal helper.
- No schema change; additive only. No cloud/Helm changes. No PBT (PoC).

## Total: 10 steps. Estimated scope: ~12–16 files (mostly small; one new tiny service; one definition; one migration; one frontend page + route; tests + ADR).

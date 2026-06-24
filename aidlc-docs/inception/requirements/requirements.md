# Requirements — Automated NFS-e Ingestion & Field Extraction

## Intent Analysis
- **User request**: Build an automated pipeline that fetches new Brazilian service invoices (NFS-e), extracts their structured fiscal fields via an LLM inside a durable Temporal workflow, persists them in Supabase, and presents them on screen — with **no manual paste or upload**. Production fetches from a real API; the POC uses a local mock API.
- **Request type**: New Feature / Enhancement (replaces the broken `doc-extraction` scaffold).
- **Scope estimate**: Multiple Components (Temporal worker definition + new mock-API service + Supabase migration/seed + Edge Function whitelist + frontend results page & trigger registration).
- **Complexity estimate**: Moderate.
- **Depth**: Standard.
- **Source inputs**: `aidlc-inputs/vision.md`, `aidlc-inputs/technical-environment.md`; reverse-engineering artifacts in `aidlc-docs/inception/reverse-engineering/`.

## Extension Configuration (from clarifying answers)
- **Security Baseline**: Not enabled (PoC). *The template's existing security posture is still preserved — see NFR-SEC.*
- **Resiliency Baseline**: Not enabled (PoC).
- **Property-Based Testing**: Not enabled (PoC — reverted by user follow-up; see audit).

---

## Functional Requirements

- **FR-1 — Mock NFS-e source API (POC).** A new local HTTP service (Docker Compose service, Node/Hono) exposes:
  - `GET /invoices` → list of available invoices `[{ id, filename, content_url }]`.
  - `GET /invoices/:id/content` → the invoice PDF (Content-Type `application/pdf`).
  It serves the sample PDFs in `docs/examples/`. The source base URL is configurable via env so production swaps it for the real API without changing the workflow.

- **FR-2 — Ingest workflow (`nfse-ingest`, DSL).** A declarative DSL definition that:
  1. `http_request` GET `/invoices` to list invoices;
  2. filters out invoices whose `source_url` already exists in `workflow_document_extractions` (dedup — FR-6);
  3. `for_each` remaining invoice (bounded; see NFR-PERF): `try_catch` →
     - `file_extract` GET `content_url` → PDF text,
     - `llm_agent` (Azure `gpt-5.4`, `temperature 0`, NFS-e `response_schema`) → structured fields,
     - `supabase_mutate` upsert into `workflow_document_extractions`.

- **FR-3 — Model-based extraction.** The model call runs **inside** the Temporal workflow (via `llm_agent`) and returns the **19 NFS-e fields** (FR-5) as schema-enforced JSON. Provider/model are configured by env (`PIAGENT_PROVIDER=azure-openai-responses`, `PIAGENT_MODEL_ID=gpt-5.4`).

- **FR-4 — Persistence.** Each successful extraction is **unconditionally** written to `workflow_document_extractions`: `source_url` = invoice content URL (unique), `extracted_fields` = the 19 fields (JSONB), `confidence`, `extracted_at`. Writes are service-role only (worker), never from the browser.

- **FR-5 — NFS-e field set (19 fields).** `numero_nota`, `serie`, `codigo_verificacao`, `data_emissao`, `competencia`, `municipio_emissor`, `prestador_razao_social`, `prestador_cnpj_cpf`, `tomador_razao_social`, `tomador_cnpj_cpf`, `descricao_servicos`, `codigo_servico`, `valor_total`, `base_calculo`, `aliquota_iss`, `valor_iss`, `iss_retido`, `valor_liquido`, `confidence`. Missing fields → `null`. Currency/number fields are normalized to numeric (e.g., "R$ 6,00" → 6.00).

- **FR-6 — Deduplication.** The worker lists all source invoices and **skips those already in `workflow_document_extractions`** (keyed by `source_url`); persistence uses idempotent upsert so re-runs do not duplicate rows.

- **FR-7 — Automatic trigger (Schedule) + manual scan.**
  - A **Temporal Schedule** runs `nfse-ingest` automatically **every 15 seconds** (created via a bootstrap script at `make up`). Schedule overlap policy = **SKIP** (no pile-up if a run is still in flight).
  - A manual **"Scan now"** action triggers the same workflow via the existing path: frontend → Edge Function `trigger-workflow` (JWT + whitelist) → worker `POST /workflows/trigger`.
  - *(With FR-6 dedup, after the first run subsequent 15s runs list + skip → near-zero cost/LLM calls. See NFR-PERF.)*

- **FR-8 — Results screen.** A JSON-driven frontend page lists the extracted invoices read **directly from `workflow_document_extractions` via supabase-js** (authenticated read), showing key fields (numero_nota, prestador, tomador, valor_total, data_emissao, confidence) and a **visual "low confidence" indicator** (NFR/AC). Reachable behind `AuthGate`→`MfaGate`. The existing execution-detail screen continues to show per-run traces.

- **FR-9 — Definition activation.** `nfse-ingest` is inserted into `workflow_definitions` with `is_active=true` (seed/migration), added to the Edge Function whitelist `TRIGGERABLE_DEFINITIONS`, and registered in the frontend trigger registry `frontend/src/workflows/definitions.ts`.

- **FR-10 — Low-confidence / content-filter handling.** If extraction is low confidence, the row is **still stored** with its `confidence` and **flagged visually** on the results screen. If `content_filter_blocked` is true, the row is **not stored** and the block is recorded in the execution trace.

## Non-Functional Requirements

- **NFR-SEC — Preserve existing security posture (hard constraint).** Even though the Security *extension* is off, the template's model is unchanged: auth lockdown (anon denied), MFA/AAL2 (`require_aal2`), **service-role-only writes** to `workflow_document_extractions`, role-guarded RPCs. The browser only **reads** results; it never writes extractions. No secrets in code/config/repo (repo is public) — Azure key only in gitignored `.env`.
- **NFR-PERF — Bounded automatic load.** 15s Schedule cadence is acceptable **because dedup makes steady-state runs no-ops**. `for_each` runs **sequential** (or small bounded batch), not unbounded parallel, to cap concurrent LLM calls and cost. Schedule overlap = SKIP.
- **NFR-TEST — Pragmatic POC testing.** No property-based testing (PoC scope). Cover the feature with focused example-based tests: a worker contract/unit test for the `nfse-ingest` definition (dedup filter + field-binding), an integration test asserting one row lands in `workflow_document_extractions`, the Edge Function whitelist test, and a frontend test for the results screen.
- **NFR-MAINT — Reuse over new code.** Reuse `llm_agent`, `file_extract`, `supabase_mutate`, `http_request`, the DSL engine, the trigger/Edge path, and the execution-detail screen. Do not fork the DSL interpreter or add a bespoke TS workflow.
- **NFR-OBS — Observability.** Each run is visible in the Temporal UI and the execution-detail screen (step trace, llm_agent metadata). Per-invoice failures are isolated by `try_catch` and recorded, not fatal to the batch.
- **NFR-COMPAT — Additive only.** New migration(s) are additive; no changes to existing tables, the DSL interpreter, other definitions, or `supabase/config.toml` beyond the already-documented Studio toggle.

## Acceptance Criteria (customer language)
- [ ] "Eu não preciso colar texto nem subir arquivo — o sistema busca as notas sozinho."
- [ ] "A cada poucos segundos o sistema verifica se há notas novas e processa as que ainda não foram processadas."
- [ ] "Vejo, na tela, a lista de notas processadas com os campos extraídos (número, prestador, tomador, valor, data)."
- [ ] "Notas com baixa confiança aparecem sinalizadas para eu revisar."
- [ ] "Posso clicar em 'Scan agora' para forçar uma verificação na hora."
- [ ] "Uma nota já processada não é processada de novo (sem duplicatas)."
- [ ] "Consigo acompanhar a execução do workflow (passos) na tela de detalhe / no Temporal UI."

## Out of Scope (this iteration)
End-user paste/upload; the real production invoice API (mock stands in); automotive line-item/OS/placa/chassi fields; human-in-the-loop correction UI; batch bulk UI; reuse of other definitions; production deployment (Helm/K8s).

## Key Requirements Summary
Automatic, scheduled (15s) ingestion of NFS-e from a local mock API; one durable DSL workflow per scan that lists → dedups → for-each (PDF fetch+parse → Azure gpt-5.4 extraction → service-role upsert); a results screen reading Supabase directly; pragmatic example-based tests (no PBT — PoC); existing security posture preserved; maximum reuse of existing activities and UI.

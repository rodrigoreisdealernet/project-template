# Vision: Automated NFS-e Ingestion & Field Extraction — 10x Application Template

> **Brownfield project.** This document describes a change to an existing system.
> The Current State section gives AIDLC the context it needs before generating
> requirements and design.

---

## Current State

The 10x Application Template is a working full-stack platform: a React/Vite
JSON-driven frontend, a Supabase backend (Postgres 17, Auth/RLS, Storage, Studio,
SCD2 schema), and a Temporal worker (TypeScript) that runs **declarative JSON
workflows** through a capable DSL interpreter (supports `for_each`, `try_catch`,
`parallel`, `condition`, `child_workflow`, `set_variable`, …). The stack is up and
verified locally (`make verify` → 19/19).

Relevant building blocks already present:

- `file_extract` — fetches a file **by URL**, parses **PDF** (pdf-parse), DOCX, XLSX,
  HTML, and can optionally run extraction itself.
- `llm_agent` — multi-provider LLM call with Azure support and schema-enforced output.
- `supabase_mutate` — the only real DB write path (insert/update/upsert via PostgREST).
  (`supabase_query` read and `supabase_core` entity activities are STUBS.)
- `http_request` — generic HTTP GET/POST activity.
- `DSLWorkflow` engine with durable execution + per-step tracing (`workflow_executions`,
  `workflow_execution_steps`); a migrated/tested table `workflow_document_extractions`;
  a trigger path (browser → Edge Function `trigger-workflow` → worker
  `POST /workflows/trigger`) and an execution **detail screen**.

There is a skeleton `definitions/doc-extraction.json`, but it is **not working
end-to-end** (wrong table name, hardcoded Anthropic provider, a confidence gate that
skips the write, generic bibliographic schema, not activated/whitelisted).

---

## What We Are Adding

An **automated NFS-e ingestion pipeline**. The user does **not** paste text or upload
files. The system **fetches new Brazilian service invoices (NFS-e) from a source,
extracts their structured fiscal fields via the Azure `gpt-5.4` model inside a durable
Temporal workflow, persists them, and presents them on screen** — automatically.

- **Production:** the workflow polls a real **API** for new invoices.
- **POC:** a **local mock API** (a small HTTP service serving the sample NFS-e PDFs)
  stands in for that API. Swapping POC → production changes only the source base URL;
  extraction, persistence, and UI are unchanged.

This satisfies the Day 2 Session 2 requirement — *touches the database, shows up on
screen, and does its real thinking through a model call inside a Temporal workflow*
(not a dashboard, not a chatbot) — and adds a realistic "fetch → process → present"
automation story.

Reference invoices (real NFS-e, 3 municipal layouts incl. an automotive one with
OS/placa/chassi) live in [`docs/examples/`](../docs/examples/) and seed the mock API.

---

## Features In Scope (this iteration)

- A **mock NFS-e API** (new local service) exposing: `GET /invoices` (list new
  invoices: id, filename, content URL) and `GET /invoices/:id/content` (the PDF).
- An **ingest workflow** (`nfse-ingest`, DSL): `list_source` (GET `/invoices`, skip
  already-processed) → `for_each` invoice → `try_catch`[ `file_extract` (URL → text)
  → `llm_agent` (NFS-e prompt + schema) → `supabase_mutate` (insert) ].
- The model call: Azure `gpt-5.4`, `temperature: 0`, schema-enforced NFS-e fields.
- **Unconditional** persistence to `workflow_document_extractions` (no confidence gate);
  `source_url` = the invoice's content URL → natural unique key + dedup.
- **Automatic triggering:** a **Temporal Schedule** (cron) runs the ingest periodically,
  plus a manual **"scan now"** action via the existing trigger path.
- A **results screen**: a list/table of extracted invoices, read from
  `workflow_document_extractions` via supabase-js (direct-CRUD everyday path).
- Activating the definition (`is_active=true`), whitelisting it in the Edge Function,
  and registering the manual trigger.
- Tests for the new path (worker contract/unit + a frontend test).

### NFS-e fields to extract (response schema)

Flat schema (Azure-friendly, `additionalProperties: false`); missing fields → `null`:

`numero_nota`, `serie`, `codigo_verificacao`, `data_emissao`, `competencia`,
`municipio_emissor`, `prestador_razao_social`, `prestador_cnpj_cpf`,
`tomador_razao_social`, `tomador_cnpj_cpf`, `descricao_servicos`, `codigo_servico`,
`valor_total`, `base_calculo`, `aliquota_iss`, `valor_iss`, `iss_retido`,
`valor_liquido`, `confidence`.

## Features Explicitly Out of Scope (this iteration)

- End-user paste / file upload (the whole point is automatic ingestion).
- The real production invoice API (mock stands in; the real integration is later).
- Automotive line-item / OS / placa / chassi extraction (Phase 2; some layouts only).
- Human-in-the-loop approval/correction of extracted fields (Phase 2).
- Re-using the other definitions (invoice-processing, lead-enrichment, etc.).
- Production deployment (Helm/k8s).

---

## What Must Not Change

- The SCD2 core schema and star schema — additive migrations only.
- The Temporal DSL interpreter and existing activities — extend via config/definitions
  and (where needed) small new activities; do not fork the engine or add a bespoke TS
  workflow for the pipeline.
- The security model: service-role-only writes to extraction tables, RLS/auth lockdown,
  MFA/AAL2; new routes stay behind `AuthGate`→`MfaGate`.
- Other workflow definitions and the local `.env.temporal` override.
- `supabase/config.toml` beyond the already-documented `[studio] enabled = true`.

---

## Resolved Decisions

- **Document type:** Brazilian NFS-e. Fields above.
- **Interaction model:** fully automatic — fetch → process → present. No paste, no upload.
- **POC source:** local **mock API** serving the sample PDFs; production = real API (swap base URL).
- **Trigger:** Temporal Schedule (cron) + manual "scan now".
- **Model:** Azure `gpt-5.4` (resource `accelerator-foundary…`, verified 200) — env-only.
- **Workflow shape:** DSL definition with `for_each` over invoices (reuse trigger + tracking + detail screen), not a dedicated TS workflow.
- **Persistence:** `workflow_document_extractions`, unconditional write, `source_url` = invoice content URL (unique → dedup).
- **Who sees it:** any authenticated user (behind AuthGate→MfaGate).

## Open Questions (minor)

- Mock API shape: standalone compose service (Node/Hono) vs a static file server + a
  `manifest.json`. (Recommend a small compose service for API fidelity.)
- Schedule cadence for the demo (e.g. every 1–2 min) and how the Schedule is created
  (Temporal `schedule create` / bootstrap script / worker startup).
- "New invoice" detection: dedup purely on `source_url` already-in-DB, or does the mock
  also expose a "processed" flag?

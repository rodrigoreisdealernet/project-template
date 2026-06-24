# Technical Environment: Document Field Extraction — 10x Application Template

> **Brownfield project.** The existing 10x template stack is the baseline. New code
> must fit the established patterns. Where a choice is not listed below, follow the
> existing codebase — do not introduce new patterns without justification.

---

## Existing Stack (must be preserved)

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Frontend language | TypeScript | 5.x | Strict. No plain JS files. |
| Frontend framework | React + Vite | React 18 / Vite 5 | JSON-driven UI engine (ADR-0018). Pages described as JSON. |
| Frontend data layer | `@supabase/supabase-js` + TanStack Query/Router | — | Direct CRUD via supabase-js; TanStack Query caching (ADR-0019). |
| UI components | Radix UI + Tailwind | Tailwind 4 | Use existing component library / design system (ADR-0020). |
| Backend platform | Supabase (self-hosted local via CLI) | Postgres 17 | PostgREST, Auth/RLS, Storage, Studio, Edge Functions. Source of truth. |
| Data model | SCD2 entity model + star schema | — | `entities`/`entity_versions`/`relationships_v2` + `fact_types`/`entity_facts`/`time_series_points` (ADR-0021/0022). |
| Vector search | pgvector | 0.8.2 | `documents` table + `match_documents` RPC. |
| Orchestration | Temporal | server 1.21.3 / UI 2.21.2 | Durable workflows. Namespace `default`, task queue `main` (local). |
| Temporal worker | TypeScript / Node.js | Node ≥ 22.19, `@temporalio/*` 1.18.1 | Compiles to **CommonJS** (webpack requirement). Workflows are **JSON DSL**, not per-feature TS. |
| LLM adapter | `@earendil-works/pi-ai` | 0.79.10 | Multi-provider (`llm_agent` activity). ADR-0008. |
| Worker HTTP API | Hono | 4.x | Trigger + query workflow executions (`temporal/src/server.ts`). |
| Doc parsing | `pdf-parse`, `mammoth`, `exceljs`, `cheerio` | — | Already installed for `file_extract` activity. |
| Worker tests | Jest + ts-jest | Jest 30 | Tests in `temporal/tests/**/*.test.ts`. Lint: Biome. |
| Local runtime | Docker + Compose (Rancher) + Supabase CLI | — | `supabase start` + `docker compose`. Keys injected at runtime. |
| Deploy (future) | Helm + Kubernetes | chart 0.1.0 | Placeholdered; not in scope for this feature. |

---

## LLM Provider — Azure OpenAI (the model call for this feature)

- Provider is **config-driven** through `llm_agent` (`temporal/src/activities/llm_agent.ts`) — no per-feature provider code.
- Azure is selected with provider id **`azure-openai-responses`**. The worker deliberately calls Azure **Chat Completions** (`{BASE_URL}/openai/v1/chat/completions`) with `api-key` + `api-version` headers — NOT the Responses API (`temporal/src/azure_openai.ts`).
- Credentials and selection live ONLY in a gitignored worker `.env` (never committed; repo is public):

  ```dotenv
  PIAGENT_PROVIDER=azure-openai-responses
  PIAGENT_MODEL_ID=gpt-5.4
  AZURE_OPENAI_API_KEY=<secret — gitignored>
  AZURE_OPENAI_BASE_URL=https://accelerator-foundary.cognitiveservices.azure.com
  AZURE_OPENAI_API_VERSION=2025-04-01-preview
  ```
- Model `gpt-5.4` connectivity already verified (HTTP 200).

---

## What to Add (new for this feature)

- A **mock NFS-e API** — a small new HTTP service (compose service) serving the sample
  PDFs: `GET /invoices` → `[{id, filename, content_url}]`; `GET /invoices/:id/content`
  → the PDF. Reachable from the worker on the compose network. Source base URL is an
  env var so production swaps it for the real API. (No end-user upload.)
- An **ingest workflow definition** `nfse-ingest` (DSL): `http_request` GET `/invoices`
  → filter out already-processed (`source_url` already in DB) → `for_each` invoice
  (`try_catch`): `file_extract` (URL → text) → `llm_agent` (NFS-e prompt + schema) →
  `supabase_mutate` (insert into `workflow_document_extractions`).
- **Automatic trigger:** a **Temporal Schedule** (cron) starting the ingest periodically
  (created via Temporal `schedule create` / a bootstrap script), plus a manual
  **"scan now"** through the existing path: browser → Edge Function `trigger-workflow`
  (JWT + whitelist) → worker `POST /workflows/trigger`.
- A **results screen**: a JSON-driven list/table reading `workflow_document_extractions`
  via supabase-js. The existing execution detail screen still shows per-run traces.
- **Activating** the definition: insert into `workflow_definitions` with `is_active=true`
  (seed/migration — no auto-loader); add `nfse-ingest` to the Edge Function whitelist
  `TRIGGERABLE_DEFINITIONS`; register the manual trigger in `frontend/src/workflows/definitions.ts`.
- Tests (worker contract/unit + a frontend test) for the new path.

These additions must not modify existing tables, the DSL interpreter, or other
definitions/activities. A small new "list invoices" may reuse `http_request`; only add
a new activity if the DSL cannot express the source listing.

---

## What to Keep Unchanged

- The SCD2 core schema and star schema — **additive migrations only** (ADR-0024).
- The DSL interpreter (`temporal/src/workflows/dsl/**`) and the existing activities — extend via config/definitions, not by forking the engine.
- The security model: `SECURITY DEFINER` RPC write path (ADR-0023), RLS/auth lockdown, MFA/AAL2 (`require_aal2`). Writes to extraction tables stay **service-role only**.
- Other workflow definitions (`invoice-processing`, `lead-enrichment`, `content-moderation`, classification, `research-report`).
- The local `.env.temporal` override (namespace `default` / task queue `main`).
- `supabase/config.toml` apart from the already-documented `[studio] enabled = true` toggle.

---

## What to Remove / Not Introduce

| Prohibited | Reason | Use Instead |
|---|---|---|
| A second LLM client / SDK in the worker | `llm_agent` (pi-ai) is the single, multi-provider call path (ADR-0008). | Configure `llm_agent` via the DSL step + env. |
| Hand-written per-feature TS workflow code | Workflows are declarative JSON interpreted by the DSL. | Add/edit a `definitions/*.json` file. |
| Direct table writes from the browser to extraction tables | Writes are revoked from `anon`/`authenticated`; service-role only. | Worker writes via `supabase_mutate`; frontend reads via PostgREST/RPC. |
| Hardcoding secrets in code, `config.toml`, definitions, or docs | Repo is **public**. | Gitignored `.env` only. |
| New CSS framework / state lib | Existing frontend uses Tailwind + Radix + TanStack. | Existing libraries. |
| Non-additive / destructive migrations | ADR-0024. | New table or additive columns only. |

---

## Security Basics

- **Auth:** Supabase Auth (GoTrue), JWT; MFA/AAL2 enforced via `require_aal2`. Frontend calls authenticated as the signed-in user.
- **Write path:** extraction tables (`workflow_document_extractions`) revoke write from `anon`/`authenticated`; only the worker (service role) writes. Reads from the frontend go through PostgREST/RPC under RLS.
- **Secrets:** worker `.env` (gitignored). Never commit the Azure key. Rotate after the lab.
- **PII:** extracted document content may contain sensitive data — do not log full document text or extracted fields at info level.

---

## Example Code Patterns (from the existing codebase — follow these)

**The NFS-e extraction step (pasted text → structured fields):**

```json
{
  "activity": {
    "name": "llm_agent",
    "args": {
      "system_prompt": "Você extrai os campos de uma NFS-e brasileira. Responda só via submit_response. Campos ausentes: null.",
      "user_prompt": "$input.document_text",
      "provider": "azure-openai-responses",
      "model_id": "gpt-5.4",
      "response_schema": {
        "type": "object", "additionalProperties": false,
        "required": ["numero_nota","prestador_razao_social","tomador_razao_social","valor_total","confidence"],
        "properties": {
          "numero_nota": {"type":"string"}, "serie": {"type":["string","null"]},
          "codigo_verificacao": {"type":["string","null"]}, "data_emissao": {"type":["string","null"]},
          "competencia": {"type":["string","null"]}, "municipio_emissor": {"type":["string","null"]},
          "prestador_razao_social": {"type":"string"}, "prestador_cnpj_cpf": {"type":["string","null"]},
          "tomador_razao_social": {"type":"string"}, "tomador_cnpj_cpf": {"type":["string","null"]},
          "descricao_servicos": {"type":["string","null"]}, "codigo_servico": {"type":["string","null"]},
          "valor_total": {"type":"number"}, "base_calculo": {"type":["number","null"]},
          "aliquota_iss": {"type":["number","null"]}, "valor_iss": {"type":["number","null"]},
          "iss_retido": {"type":["boolean","null"]}, "valor_liquido": {"type":["number","null"]},
          "confidence": {"type":"number","minimum":0,"maximum":1}
        }
      },
      "schema_name": "nfse_extraction", "temperature": 0
    },
    "result": "extraction", "start_to_close_timeout": "120s", "retry": { "max_attempts": 2 }
  }
}
```

**Ingest over a list of invoices (DSL `for_each` + `try_catch`, fetch by URL):**

```json
{
  "for_each": {
    "items": "$var.invoices", "item_var": "inv", "mode": "sequential",
    "body": { "try_catch": {
      "try": { "sequence": { "steps": [
        { "activity": { "name": "file_extract", "args": { "url": "$var.inv.content_url", "mime_type": "application/pdf" }, "result": "doc" } },
        { "activity": { "name": "llm_agent", "args": { "provider": "azure-openai-responses", "model_id": "gpt-5.4", "temperature": 0,
            "system_prompt": "Você extrai os campos de uma NFS-e brasileira. Responda só via submit_response.",
            "user_prompt": "$var.doc.text", "schema_name": "nfse_extraction", "response_schema": { } }, "result": "extraction" } },
        { "activity": { "name": "supabase_mutate", "args": { "operation": "upsert", "table": "workflow_document_extractions",
            "match": { "source_url": "$var.inv.content_url" },
            "values": { "source_url": "$var.inv.content_url", "extracted_fields": "$var.extraction.parsed", "confidence": "$var.extraction.parsed.confidence" } } } }
      ] } },
      "catch": { "error_var": "err", "body": { "activity": { "name": "execution_tracking", "args": { } } } }
    } }
  }
}
```

**Triggering (manual "scan now"; the Temporal Schedule starts the same `DSLWorkflow`):**

```http
POST /workflows/trigger
Content-Type: application/json

{ "definition_name": "nfse-ingest", "input": { "run_at": "<ISO>" } }
```

*Note: `file_extract` can also run the extraction itself (pass `extraction_schema`),
collapsing the two steps into one — but a separate `llm_agent` step keeps the NFS-e
prompt + schema visible and tunable in the definition.*

**Persisting — UNCONDITIONAL (no confidence gate), service-role via `supabase_mutate`:**

```json
{
  "name": "supabase_mutate",
  "args": {
    "operation": "insert",
    "table": "workflow_document_extractions",
    "values": { "source_url": "pasted-text", "extracted_fields": "$var.extraction.parsed", "confidence": "$var.extraction.parsed.confidence" }
  }
}
```
*(`source_url` is `not null unique` — for pasted text use a synthetic key, e.g. `numero_nota`+`codigo_verificacao` or a UUID; see Vision open question.)*

**The real persistence table (`supabase/migrations/20260621001000_workflow_document_extractions.sql`):**

```sql
create table if not exists workflow_document_extractions (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique,
  extracted_fields jsonb not null,
  confidence double precision,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
revoke insert, update, delete on table workflow_document_extractions from authenticated, anon;
```

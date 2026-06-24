# API Documentation

## Worker HTTP API (Hono) — `temporal/src/server.ts` (default :3001)

### Trigger Workflow
- **Method**: POST
- **Path**: `/workflows/trigger`
- **Purpose**: Load an active DSL definition by name and start a durable `DSLWorkflow`.
- **Request**: `{ "definition_name": string, "input": object }`
- **Response**: `{ "workflowId": string, "firstExecutionRunId": string }` (and inserts a `workflow_executions` row).

### Query Executions / Detail / Health
- **GET `/workflows/executions`** — list recent executions (JSON). Used by the history screen.
- **GET `/workflows/executions/:workflowId`** — execution detail + step trace (polled by the detail screen until terminal).
- **GET `/health`** — worker health (used by `make verify`).
- **CORS**: locked to `FRONTEND_ORIGIN` (default `http://localhost:3000`).

## Edge Function — `supabase/functions/trigger-workflow/index.ts`
- **Method**: POST (OPTIONS for CORS preflight)
- **Purpose**: Browser-facing, JWT-validated, whitelisted entrypoint that forwards to the worker `/workflows/trigger`.
- **Auth**: requires `Authorization: Bearer <supabase JWT>`; validates via `auth.getUser()` (401 if invalid).
- **Whitelist**: `TRIGGERABLE_DEFINITIONS` (currently `["smoke-classification"]`) → 403 if not listed. **The NFS-e feature must add `nfse-ingest`.**
- **Request**: `{ definition_name, input }` → **Response**: `{ workflow_id, run_id }` (502/503 on downstream issues).

## Internal API — DSL Activity Contracts (`temporal/src/activities/`)

### llm_agent(args) — the model call
- **args**: `provider?`, `model_id?`, `system_prompt`, `user_prompt`, `tools?`, `mcp_servers?`, `response_schema?`, `schema_name?`, `temperature?`, `max_tokens?`, `max_tool_rounds?`.
- **returns**: `{ parsed? (when response_schema), text?, tool_calls[], provider, model, prompt_tokens, completion_tokens, content_filter_blocked }`.
- **behavior**: enforces schema via mandatory `submit_response` tool; throws (→ Temporal retry) if model returns text instead of calling it; Azure uses Chat Completions with `api-key`/`api-version` headers.

### file_extract(args) — fetch + parse (+ optional extract)
- **args**: `url` (required), `mime_type?`, `extraction_schema?`, `max_extraction_chars?` (default 12000).
- **returns**: `{ text, pages?, tables?, extracted? }`. PDF via pdf-parse, DOCX via mammoth, XLSX via exceljs, HTML via cheerio. If `extraction_schema` given, calls `llm_agent` internally and returns `extracted`.

### supabase_mutate(args) — the only real write path (`supabase_query.ts`)
- **args**: `operation` (insert/update/upsert), `table`, `match?`, `values`.
- **behavior**: PostgREST mutation as **service role**. (Note: `supabase_query` read activity and `supabase_core` entity activities are **STUBS** — not usable.)

### http_request(args)
- **args**: `method`, `url`, `headers?`, `body?`, `expected_status?`. Generic HTTP for listing the invoice source.

## REST/RPC Surfaces (Supabase, via PostgREST)
- **Write (role-guarded SECURITY DEFINER)**: `create_entity_with_version(entity_type, data)`; `submit_definition_for_review(id)`, `approve_workflow_definition(id, reason)`, `reject_workflow_definition(id, reason)`.
- **Read (authenticated + service_role)**: `get_workflow_executions(limit, before_started_at, before_workflow_id)`, `get_workflow_execution_detail(workflow_id)`.
- **Service-role only**: `match_documents(query_embedding, threshold, count)`.
- **Direct table reads (authenticated)**: most tables are SELECT-able by `authenticated` (e.g., `workflow_document_extractions` is SELECT for authenticated, write revoked → **frontend can read the results table directly**).

## Data Models (most relevant)
### workflow_document_extractions (target persistence)
- **Fields**: `id uuid pk`, `source_url text unique not null`, `extracted_fields jsonb not null`, `confidence double precision`, `extracted_at timestamptz`, `created_at`, `updated_at`.
- **Access**: SELECT for `authenticated`; INSERT/UPDATE/DELETE revoked from anon/authenticated → **service-role writes only** (worker).
- **Validation**: `source_url` UNIQUE → natural dedup / upsert key.

### workflow_definitions / workflow_executions / workflow_execution_steps
- **definitions**: `name`, `version` (semver), `definition jsonb` (must contain name/version/steps), `is_active`, `review_status`. One active per name.
- **executions**: `workflow_id` (unique), `run_id`, `definition_name/version` (FK), `status`, `current_step`, `input_payload`, `output_payload`, timing.
- **execution_steps**: per-step trace (`step_index`, `step_name`, `status`, previews, `duration_ms`).

# Business Rules — nfse-ingestion

Decision rules, validation, and constraints. IDs are referenced by Code Generation and tests.

## Ingestion & Dedup
- **BR-1 (Dedup / skip-before-extract)**: An invoice whose `content_url` already exists as a `source_url` in `workflow_document_extractions` MUST be skipped — no model call, no write. (Implements FR-6; honors Q6=A.)
- **BR-2 (Idempotency)**: Persistence uses upsert keyed on `source_url`. Re-running the pipeline never creates duplicate rows. `upsert(upsert(x)) == upsert(x)`.
- **BR-3 (Source-agnostic)**: The workflow depends only on the source contract (`GET /invoices`, `GET /invoices/:id/content`). Swapping the mock API for the real production API changes only the base URL (env), never the workflow logic.

## Extraction
- **BR-4 (Model + schema)**: Extraction runs via `llm_agent` against Azure `gpt-5.4`, `temperature 0`, with the 19-field NFS-e `response_schema`. Output is schema-enforced (mandatory `submit_response`).
- **BR-5 (Missing fields)**: Fields not present on a given NFS-e layout return `null` (schema allows null for non-required fields). Required: `numero_nota`, `prestador_razao_social`, `tomador_razao_social`, `valor_total`, `confidence`.
- **BR-6 (Numeric normalization)**: Monetary/percent fields are numbers with a decimal point. The model is instructed to convert Brazilian formats — `"R$ 1.234,56"` → `1234.56`, `"5,00%"` → `5.0`. The schema `number` type enforces numeric output.
- **BR-7 (Confidence)**: `confidence` ∈ [0,1] is the model's self-reported reliability for the extraction.

## Persistence & Confidence/Content-filter handling
- **BR-8 (Unconditional persist on success)**: A successful (non-blocked) extraction is ALWAYS written — there is NO confidence gate blocking the write. (Fixes the inherited scaffold's "green-but-empty" trap.)
- **BR-9 (Low confidence)**: When `confidence < 0.7`, the row is still stored; the results screen flags it visually as "baixa confiança" for human review. (Threshold 0.7 is a UI display rule, not a persistence gate.)
- **BR-10 (Content filter)**: When `llm_agent` returns `content_filter_blocked = true`, the row is NOT persisted; the block is recorded in the execution trace (and the invoice remains "new", so a later run may retry).
- **BR-11 (Service-role write only)**: Writes to `workflow_document_extractions` happen only from the worker (service role). The browser never writes; it only reads.

## Scheduling & Load
- **BR-12 (Auto cadence)**: A Temporal Schedule runs `nfse-ingest` every ~15 seconds.
- **BR-13 (No pile-up)**: Schedule overlap policy = SKIP — a new scheduled run is skipped if the previous run is still executing.
- **BR-14 (Bounded fan-out)**: `for_each` over invoices runs sequentially (or a small bounded batch) to cap concurrent model calls and cost. Combined with BR-1, steady-state runs are near-zero cost.

## Resilience
- **BR-15 (Per-invoice isolation)**: Each invoice is processed inside `try_catch`; a single invoice's failure (fetch/parse/model/write) is recorded and does not abort the rest of the batch.
- **BR-16 (Retry on schema miss)**: If the model returns text instead of calling `submit_response`, `llm_agent` throws and Temporal retries the activity (bounded `max_attempts`).

## Security (preserved posture — NFR-SEC)
- **BR-17 (Secrets)**: The Azure key and Supabase service-role key live only in gitignored env (never in code, definitions, config, or the public repo).
- **BR-18 (Auth gating)**: The results page and "Scan now" sit behind `AuthGate`→`MfaGate`; the Edge Function validates JWT and enforces the `TRIGGERABLE_DEFINITIONS` whitelist (must include `nfse-ingest`).

## Additivity
- **BR-19 (No destructive change)**: No schema change to existing tables; new migration/seed is additive (activate the definition). The DSL interpreter and existing activities are not modified.

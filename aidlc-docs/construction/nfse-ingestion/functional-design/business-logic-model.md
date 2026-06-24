# Business Logic Model — nfse-ingestion

Technology-agnostic description of how the automated NFS-e ingestion behaves. (No infra details — those are decided at Code Generation.)

## Actors / Triggers
- **Temporal Schedule** — fires the ingest run automatically every ~15s (overlap policy = SKIP).
- **User ("Scan now")** — manually fires the same run via the existing trigger path (Edge Function → worker).

## High-level flow (the `nfse-ingest` workflow)

```
1. LIST     → get the set of available invoices from the source.
2. PER INVOICE (for_each, sequential):
   2a. DEDUP CHECK → has this invoice (content_url) already been extracted?
        - yes → SKIP (no model call, no write).
        - no  → continue.
   2b. FETCH+PARSE → download the PDF and extract its text.
   2c. EXTRACT     → model call returns the 19 NFS-e fields (schema-enforced).
   2d. DECIDE      → content filter blocked? → do NOT persist; record in trace.
                     otherwise → PERSIST the extraction (with confidence).
   (each invoice wrapped in try_catch → one failure does not abort the batch)
3. DONE → run recorded in workflow_executions / steps; rows visible to the UI.
```

### Step detail (maps to DSL steps + reused activities)
| # | Logic | Reused activity | Key args |
|---|---|---|---|
| 1 | List invoices from source | `http_request` | GET `${SOURCE_API}/invoices` → `invoices[]` |
| 2 | Iterate invoices | DSL `for_each` (sequential) | `items=$var.invoices`, `item_var=inv` |
| 2a | Dedup existence check | `http_request` | GET `${SUPABASE_URL}/rest/v1/workflow_document_extractions?source_url=eq.$var.inv.content_url&select=source_url` with service-role headers via `$env`; result `existing` |
| 2a | Skip-or-process branch | DSL `condition` | `if` existing is empty → process; else skip |
| 2b | Fetch + parse PDF | `file_extract` | `url=$var.inv.content_url`, `mime_type=application/pdf` → `doc.text` |
| 2c | Model extraction | `llm_agent` | Azure `gpt-5.4`, temp 0, NFS-e `response_schema`, `user_prompt=$var.doc.text` → `extraction.parsed` + `content_filter_blocked` |
| 2d | Persist (if not blocked) | DSL `condition` + `supabase_mutate` | upsert into `workflow_document_extractions` (match `source_url`) |

## Dedup design decision (DESIGN DECISION — please confirm at gate)
- **Chosen (Design C — per-item existence check)**: inside `for_each`, a cheap PostgREST `GET …?source_url=eq.<url>` + a `condition` decides skip-vs-process **before** the model call. Honors "skip before LLM" (steady-state 15s runs become no-ops), needs **no new activity** and **no array-filtering** in the DSL.
- **Alternative A (bulk pre-read)**: one `http_request` reads all existing `source_url`s up front, then filter the list. Fewer requests, but requires array membership filtering the DSL expression layer may not support → would need a tiny helper. Deferred unless per-item proves costly.
- **Alternative B (upsert-only, no pre-check)**: rejected — would re-run the model for already-processed invoices every 15s (cost).
- **Open implementation risk to validate in Code Generation**: confirm the DSL `condition.if` can evaluate "result array is empty" (e.g., length/emptiness expression). If not expressible, fall back to a minimal `transform_data`/helper to compute a boolean `is_new`.

> **RESOLVED at Code Generation (back-propagated):** Design C was infeasible — the DSL expression layer resolves `$env.*` from the workflow variable bag, NOT the worker `process.env`, so a DSL step cannot authenticate to Supabase to read existing `source_url`s (and `supabase_query` read is a stub). **Chosen implementation:** a small new activity **`nfse_list_new`** lists the source API AND filters already-extracted invoices server-side (where `config` exposes the Supabase URL + service key), returning only new invoices. The workflow becomes: `nfse_list_new` → `for_each(new invoice)` → `file_extract` → `llm_agent` → `condition(content_filter)` → `supabase_mutate`. See ADR-0152.

## Mock API behavior (POC source)
- `GET /invoices` → `[{ id, filename, content_url }]` for each PDF under `docs/examples/` (content_url points back at this service).
- `GET /invoices/:id/content` → streams the PDF (`Content-Type: application/pdf`).
- Stateless: returns the full list every time; "new vs processed" is decided by the workflow via dedup (Q6=A). Production swaps this service's base URL for the real API; the workflow is unchanged.

## Results presentation (frontend)
- A JSON-driven page queries `workflow_document_extractions` directly (supabase-js, authenticated read), newest first.
- Renders a table of key fields (numero_nota, prestador, tomador, valor_total, data_emissao) + a **confidence** column with a **low-confidence badge**.
- A **"Scan now"** button triggers `nfse-ingest` via the Edge Function path; the page refetches to show new rows.

## Failure & edge handling (summary; full rules in business-rules.md)
- Per-invoice `try_catch`: fetch/parse/model/persist errors are isolated and recorded; the batch continues.
- `content_filter_blocked = true` → skip persistence, record in the execution trace.
- Model returns text instead of schema → `llm_agent` throws → Temporal retries (bounded).
- Empty invoice list or all-already-processed → run completes as a no-op.

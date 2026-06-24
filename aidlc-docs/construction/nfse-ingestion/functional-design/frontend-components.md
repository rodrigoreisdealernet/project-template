# Frontend Components — nfse-ingestion

The UI follows the existing JSON-driven UI engine (ADR-0018): a page is a JSON definition rendered by `UIEngine`, with Supabase data sources and `{{expression}}` bindings. A thin route file wraps the page JSON. Auth is enforced globally by `AuthGate`→`MfaGate`.

> **IMPLEMENTATION NOTE (back-propagated from Code Generation):** the results screen was built as a **custom React route component** (`frontend/src/routes/nfse/index.tsx`), NOT a JSON-engine page. Reason: the "Scan now" action needs an authenticated POST to the Edge Function, which the JSON engine's `apiCall` (supabase rpc/table oriented) does not express cleanly. The existing workflow screens (`routes/workflows/trigger.tsx`, `routes/workflows/executions/$workflowId.tsx`) are also custom React components, so this is consistent with the codebase. The list still reads `workflow_document_extractions` directly via supabase-js (TanStack Query), and the low-confidence badge rule (BR-9) is preserved.

## New page: NFS-e Extractions (results)
- **Page JSON**: `frontend/src/pages/nfse-extractions.json` (new).
- **Route**: `frontend/src/routes/nfse/index.tsx` (new) — wraps the page JSON via `UIEngine`.
- **Nav**: add a sidebar link in `__root.tsx` (optional but recommended).

### Data source (Supabase, direct read — authenticated)
```
type: supabase
table: workflow_document_extractions
select: id, source_url, extracted_fields, confidence, extracted_at, created_at
order: [{ column: created_at, ascending: false }]
limit: 100
```
- Reads directly via supabase-js (the everyday CRUD path). No new RPC needed (table is SELECT-able by `authenticated`).

### Layout / components (reusing existing component set: Stack, Card, Text, Table-like rows, Button, Badge)
- **Header**: title "Notas Fiscais (NFS-e) — Extrações" + a **"Scan now"** Button.
- **List/Table**: one row per extraction, columns bound via expressions into `extracted_fields`:
  - Número: `{{row.extracted_fields.numero_nota}}`
  - Prestador: `{{row.extracted_fields.prestador_razao_social}}`
  - Tomador: `{{row.extracted_fields.tomador_razao_social}}`
  - Valor total: `{{row.extracted_fields.valor_total}}`
  - Emissão: `{{row.extracted_fields.data_emissao}}`
  - Confiança: `{{row.confidence}}` + **low-confidence badge** when `{{row.confidence < 0.7}}` (BR-9).
- **Empty state**: "Nenhuma nota processada ainda — aguarde a próxima varredura ou clique em Scan now."
- **(Optional) Detail link**: link a row to the existing execution-detail screen if we carry the workflow_id (not required for MVP).

### Interactions / actions
- **"Scan now" action** (apiCall):
  - POST `${VITE_API_URL}/trigger-workflow` with `Authorization: Bearer <session token>`, body `{ "definition_name": "nfse-ingest", "input": {} }`.
  - On success → show a brief confirmation and **refetch** the data source after a short delay (so newly-extracted rows appear).
  - Mirrors the existing `trigger.tsx` pattern (reuse its fetch shape).
- **Auto-refresh (optional)**: a periodic refetch (e.g., every few seconds) so scheduled runs surface without manual reload — reuse TanStack Query polling like the execution-detail screen.

### Trigger registry
- Register `nfse-ingest` in `frontend/src/workflows/definitions.ts` so it is also available from the generic workflow trigger screen (with an empty/simple `input_schema`).

## State
- Page state: minimal (`{ scanning: false }` to disable the button during a scan; optional `searchText` for filtering).
- No complex client state; the list is server-driven via the Supabase data source + refetch.

## Validation / UX rules
- Disable "Scan now" while a scan request is in flight (`{{state.scanning}}`).
- Low-confidence rows visually distinct (badge / muted style) per BR-9.
- All numeric values displayed as returned (already normalized to numbers per BR-6); currency formatting (R$) is a display concern, optional for MVP.

## Tests (example-based — NFR-TEST)
- A frontend test that renders the page with mocked extraction rows and asserts: rows render the key fields, and the low-confidence badge appears when `confidence < 0.7`.
- (Edge whitelist + worker/integration tests live in their respective suites.)

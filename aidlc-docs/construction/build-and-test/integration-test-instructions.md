# Integration / End-to-End Test Instructions — nfse-ingestion

Proves the full path over the wire (don't trust clean logs): Schedule/UI → Edge Function → worker → mock API → Azure gpt-5.4 → Supabase → results screen.

## Setup
```bash
make reset            # applies migration (activates nfse-ingest) + rebuilds + starts + creates schedule
make bootstrap-users  # dev login (admin@dev.local / Admin1234! + TOTP)
make verify           # baseline stack health (expect PASS)
```

## Scenario 1 — Automatic ingestion via the Temporal Schedule
1. Open Temporal UI http://localhost:8081 → **Schedules** → confirm `nfse-ingest-15s` exists (interval 15s, overlap SKIP).
2. Within ~15s a `DSLWorkflow` run appears under Workflows and **Completes**.
3. Confirm rows persisted (service-role read):
   ```bash
   curl -s "http://localhost:54321/rest/v1/workflow_document_extractions?select=source_url,confidence" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
   ```
   Expect one row per sample PDF in `docs/examples/` with `extracted_fields` populated (numero_nota, prestador, valor_total, …).
4. **Dedup**: wait for the next 15s run → it processes 0 new invoices (no duplicate rows; row count stable).

## Scenario 2 — Manual "Scan now" + results screen
1. Log in at http://localhost:3000, open **NFS-e Extractions** (sidebar).
2. The table lists the extracted invoices; low-confidence rows show the amber badge.
3. Click **Scan now** → a workflow is triggered (Edge Function → worker); the list refreshes (no new rows if all already processed — dedup).

## Scenario 3 — New invoice picked up automatically
1. Drop another NFS-e PDF into `docs/examples/` (mounted into mock-nfse-api).
2. Within ~15s the scheduled run extracts and persists it; it appears on the results screen. No manual paste/upload.

## Cleanup
```bash
make down
```

## Results in this environment
- ⏳ Live e2e requires Docker + Supabase running + the Azure key; run the scenarios above in the dev environment.
- ✅ Static verification done here: worker typecheck (exit 0) + DSL definition validation (all checks pass). The cross-service contract is exercised by the unit tests (dedup filter, edge whitelist, definition shape).

# Build Instructions — nfse-ingestion

## Prerequisites
- Docker + Compose (Rancher OK), Supabase CLI, `make`, Node ≥ 22.
- Gitignored `.env` with Azure creds (provider `azure-openai-responses`, `PIAGENT_MODEL_ID=gpt-5.4`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY`, `AZURE_API_VERSION`) + `NFSE_SOURCE_API_URL` — already created locally.

## Build Steps

### 1. Install dependencies (once)
```bash
make setup            # installs frontend + temporal deps + git hooks
# or: npm --prefix temporal install && npm --prefix frontend install
```

### 2. Bring the stack up (builds images incl. the new mock-nfse-api service)
```bash
make reset            # full clean: applies the new migration (activates nfse-ingest) + rebuilds
# (or `make up` if no prior volumes). reset re-applies migrations incl.
#  20260624160000_seed_nfse_ingest_definition.sql
```
`make up` also creates the Temporal Schedule (`make nfse-schedule`, every 15s).

### 3. Create dev users (for the UI login)
```bash
make bootstrap-users
```

### 4. Verify build success
- 6 compose containers Up/healthy: temporal-db, temporal, temporal-ui, **mock-nfse-api**, temporal-worker, frontend.
- `docker compose logs mock-nfse-api` → "mock-nfse-api listening on :8090".
- Worker logs show it polling task queue `main`.

## Verification already performed (this environment)
- ✅ Worker typecheck: `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json` → **exit 0** (compiles the new `nfse_list_new` activity + all tests).
- ✅ DSL definition validated via `validateDefinition(nfse-ingest.json)` → all structural checks pass.

## Troubleshooting
- **Worker crash-loop "Namespace ... not found"**: ensure gitignored `.env.temporal` sets `TEMPORAL_NAMESPACE=default`, `TEMPORAL_TASK_QUEUE=main`.
- **`gpt-5.4` 404**: confirm `AZURE_OPENAI_BASE_URL=https://accelerator-foundary.cognitiveservices.azure.com` (NOT the old volaris sandbox).
- **Schedule not created**: run `make nfse-schedule` after the stack is up (needs Temporal reachable on 127.0.0.1:7234 + the definition active).
- **mock-nfse-api 0 invoices**: confirm `./docs/examples` is mounted (volume) and contains the PDFs.

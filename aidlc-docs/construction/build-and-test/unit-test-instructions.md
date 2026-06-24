# Unit Test Execution — nfse-ingestion

## Worker (Jest + ts-jest)
```bash
npm --prefix temporal install   # ensure devDeps (ts-jest) present
make test-temporal              # or: cd temporal && npm test
```
New tests:
- `temporal/tests/nfse-ingest.definition.test.ts` — the `nfse-ingest.json` definition is structurally valid; uses `nfse_list_new`; calls Azure `gpt-5.4`; persists to `workflow_document_extractions`; guards on `content_filter_blocked == false`; lists before extracting.
- `temporal/tests/nfse_list_new.test.ts` — dedup logic: returns only invoices whose `content_url` is not already in the DB (BR-1/BR-6); returns all when none processed.

## Edge Function (Deno)
```bash
cd supabase/functions/trigger-workflow && deno test
```
- `index.test.ts` — `nfse-ingest` is whitelisted (allowed); a non-listed definition is rejected.

## Frontend (Vitest)
```bash
npm --prefix frontend install && npm --prefix frontend test
```
- `frontend/src/routes/nfse/nfse-extractions.test.tsx` — `isLowConfidence` flags confidence < 0.7 (BR-9) and ignores null/non-numeric.

## Results in this environment
- ✅ Worker **typecheck passed (tsc exit 0)** — all new code + test files compile.
- ✅ DSL definition validated via `validateDefinition` (all checks pass).
- ⏳ Full `jest`/`vitest`/`deno test` runs require a complete `npm ci` / Deno (the sandbox here had a partial test runner). Run the commands above in the dev environment for green suites.

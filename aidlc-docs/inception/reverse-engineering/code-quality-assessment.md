# Code Quality Assessment

## Test Coverage
- **Overall**: Good for a template — three real suites, plus CI gates.
- **Frontend**: Vitest unit/component tests (engine expression evaluator, entity list/detail UX, workflow routes) with coverage thresholds (~lines 37%, functions 36%, branches 34%, statements 38%); Playwright E2E (~11 specs incl. auth/MFA, workflows trace/history, navigation) run against a live environment.
- **Supabase**: strong SQL contract tests (auth RBAC, RPC role guards, review surface, execution query surface, **`workflow_document_extractions` access**) + Vitest integration tests (access-control, MFA, user-management, classifications).
- **Worker**: Jest activity/DSL tests + a DSL **contract snapshot** (`contract-snapshot.json`); a `scripts/test-doc-extraction.ts` harness exists but (per prior analysis) rewrites the write target and stubs the fetch — adapt, don't trust as-is.

## Code Quality Indicators
- **Linting/Formatting**: Biome (frontend + temporal), sqlfluff (SQL), yamllint, markdownlint, hadolint (Dockerfiles). Enforced via lefthook pre-commit + pr-validation.
- **Type Safety**: TypeScript strict across frontend + worker; typecheck in hooks + CI.
- **Code Style**: Consistent (SQL snake_case, UUID PKs, JSONB payloads, timestamp columns; TS idioms uniform).
- **Documentation**: Good — 151 ADRs, AGENTS.md, DATABASE.md, CONTRIBUTING.md, per-area READMEs.
- **Security tooling**: gitleaks (PR + pre-push), semgrep, osv-scan, CodeQL nightly, container scans, CIS audits.

## Technical Debt / Risks (relevant to the NFS-e feature)
1. **`doc-extraction.json` is broken end-to-end**: writes to non-existent table `document_extractions` (real table `workflow_document_extractions`); hardcoded `provider: anthropic`; a `confidence > 0.7` gate that skips the write on low confidence (green-but-empty); generic bibliographic schema. → the new `nfse-ingest` definition fixes/replaces these.
2. **Doc drift — "Python worker"**: `copilot-instructions.md`, `factory.yml` (`python -m pytest`), `docker-compose.dev.yml` (`python -m src.worker`), and the materials README describe a Python worker; the real worker is **TypeScript**. Risk: a factory agent or contributor following those docs targets the wrong runtime.
3. **STUB activities**: `supabase_query` (read) and `supabase_core` (entity SCD2) are stubs — only `supabase_mutate` is a real write path. Easy to mis-wire.
4. **No automatic definition loader**: definitions must be inserted into `workflow_definitions` (`is_active=true`) via seed/migration/RPC, AND whitelisted in the Edge Function, AND registered in the frontend dropdown — three separate activation points that are easy to miss.
5. **Edge Function whitelist** currently only allows `smoke-classification`; a new definition silently 403s until added.
6. **CORS / namespace**: worker CORS locked to `FRONTEND_ORIGIN`; local Temporal needs the gitignored `.env.temporal` (`default`/`main`) or the worker crash-loops.
7. **DSL `parallel` for_each + LLM cost**: `for_each` over many invoices in `parallel` mode can fan out many concurrent LLM calls — bound it (sequential or small batch) for the demo.

## Patterns and Anti-patterns
- **Good Patterns**: declarative DSL workflows; provider-neutral LLM adapter; defense-in-depth auth (grants + MFA hook + role-guarded RPCs); SCD2 with triggers; runtime env injection; comprehensive CI/factory governance.
- **Anti-patterns / watch-outs**: stale Python references (doc drift); a shipped-but-broken example definition; stubbed activities that look real; multi-point activation that lacks a single source of truth.

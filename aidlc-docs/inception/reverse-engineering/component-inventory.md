# Component Inventory

## Application Packages
- **frontend/** — React 19 + Vite + TypeScript JSON-driven UI (pages, engine, routes, workflows UI, data layer).
- **temporal/** — TypeScript Temporal worker: 17 activities, DSL interpreter, Hono HTTP API, JSON workflow definitions.
- **supabase/** — Postgres schema (15 migrations), Edge Functions, SQL + integration tests, seed.

## Infrastructure Packages
- **charts/app** — Helm — frontend + worker deployments.
- **charts/temporal** — Helm — Temporal server (wraps upstream chart).
- **charts/postgres** — Helm — Postgres for Temporal.
- **charts/supabase** — Helm — in-cluster Supabase (wraps upstream).
- **deploy/k8s, deploy/azure, deploy/openbao, deploy/eso** — K8s manifests, secret backend (OpenBao), External Secrets Operator.

## Shared / Tooling Packages
- **.github/** — autonomous "factory": 26 agent definitions (`agents/*.agent.md`), ~33 workflows, `factory.yml`, `copilot-instructions.md`, labels; `.github/tools/shared/src/azure-openai.ts` (CI LLM helper).
- **scripts/** — `bootstrap-users.ts`, `verify-stack.sh`, `supabase-env.sh`, copilot-assignment audits.
- **doc_templates/**, **docs/adrs/** (151 ADRs), **aidlc-inputs/** (vision + tech-env for this feature), **aidlc-workflows/** (AIDLC clone, gitignored).

## Test Packages
- **frontend** — Vitest (unit/component) + Playwright (E2E in `frontend/e2e/`, ~11 specs).
- **supabase/tests** — SQL contract tests (auth RBAC, RPC guards, review surface, query surface, extraction access) + Vitest integration tests (access-control, mfa, user-management, classifications).
- **temporal/tests** — Jest (activity/DSL/contract tests; `contract-snapshot.json`).

## Activities Inventory (`temporal/src/activities/`, 17)
| Activity | Purpose | NFS-e relevance |
|---|---|---|
| `llm_agent` | Multi-provider LLM call, schema-enforced | **Core** (extraction) |
| `file_extract` | Fetch URL + parse PDF/DOCX/XLSX/HTML (+ optional extract) | **Core** (PDF→text) |
| `supabase_query` → `supabase_mutate` | `supabase_mutate` = real write path; `supabase_query` read = STUB | **Core** (persist) |
| `http_request` | Generic HTTP GET/POST | **Core** (list invoices) |
| `transform_data` | Map/reshape data | maybe |
| `evaluate_decision` | Decision-table eval | no |
| `execution_tracking` | Write execution/step trace | indirect |
| `notifications` / `email_send` / `slack_message` | Notifications | optional |
| `schedule_trigger` | Delayed one-shot start of a DSLWorkflow | maybe (vs Temporal Schedule) |
| `vector_search` / `llm_embeddings` | pgvector search / embeddings | no (Phase 2) |
| `web_search` / `web_crawl` | Exa web tools (built-in to llm_agent) | no |
| `domain_probe` | Domain classification helper | no |
| `data_validate` | Schema validation | maybe |
| `supabase_core` | Entity SCD2 activities — **STUBS** | no |

## Total Count
- **Total top-level packages/areas**: ~9 (frontend, temporal, supabase, charts, deploy, .github, scripts, docs, aidlc).
- **Application**: 3 (frontend, temporal, supabase).
- **Infrastructure**: charts (4 sub-charts) + deploy (4 areas) + .github factory.
- **Test**: 3 suites (frontend, supabase, temporal).
- **Worker activities**: 17. **Workflow definitions**: 7 JSON. **Migrations**: 15. **ADRs**: 151.

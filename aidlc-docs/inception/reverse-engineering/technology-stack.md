# Technology Stack

## Programming Languages
- **TypeScript** — frontend (React 19) and Temporal worker. Strict mode. Worker compiles to **CommonJS** (Temporal webpack requirement).
- **SQL (PostgreSQL 17)** — Supabase migrations, RPCs (PL/pgSQL), tests.
- **TypeScript on Deno** — Supabase Edge Functions.

> ⚠️ **Doc drift to note**: several boilerplate docs (`.github/copilot-instructions.md`, `.github/factory.yml` `worker_test: python -m pytest`, `docker-compose.dev.yml` `python -m src.worker`, README catalog) describe the worker as **Python**. The actual worker in this copy is **TypeScript** (`temporal/package.json`, `temporal/src/worker.ts`, runtime `node dist/worker.js`). Treat the worker as TS; the Python references are stale.

## Frameworks & Libraries
- **Frontend**: React 19, Vite, TanStack Router + TanStack Query, Tailwind 4, Radix UI / shadcn, `@supabase/supabase-js` 2.x, lodash-es.
- **Worker**: `@temporalio/{worker,client,workflow,activity}` 1.18.1, Hono 4 (HTTP API), `@earendil-works/pi-ai` 0.79.10 (LLM, ESM-only), `pdf-parse`, `mammoth`, `exceljs`, `cheerio`, `pg`, `node-fetch`.
- **Backend**: Supabase (PostgREST, GoTrue Auth + MFA/TOTP, Storage, Realtime, Edge Runtime), pgvector 0.8.2.

## Infrastructure
- **Local**: Docker + Compose (Rancher), Supabase CLI (Postgres 17), Temporal server 1.21.3 + UI 2.21.2.
- **Deploy (placeholdered, out of scope here)**: Kubernetes (AKS/EKS), Helm, OpenBao + External Secrets Operator, Azure ACR / AWS ECR, Cosign/SBOM/SLSA in CI.
- **LLM**: provider-neutral via pi-ai. This feature uses **Azure OpenAI `gpt-5.4`** at `accelerator-foundary.cognitiveservices.azure.com` (api-version `2025-04-01-preview`), Chat Completions path, `api-key` header. Default fallback provider = Anthropic `claude-sonnet-4-6`.

## Build Tools
- **npm** (frontend + temporal), **Supabase CLI**, **Docker Compose**, **Helm**, root **Makefile** (`DOCKER_BUILDKIT=0`).
- **Biome** (lint/format), **TypeScript** compiler, **lefthook** (git hooks), **gitleaks** (secrets).

## Testing Tools
- **Frontend**: Vitest (+ jsdom) for unit/component; Playwright for E2E.
- **Supabase**: psql SQL contract tests; Vitest integration tests (supabase-js).
- **Worker**: Jest (+ ts-jest); DSL contract snapshot (`contract-snapshot.json`).
- **CI gates**: pr-validation (typecheck/lint/build/DSL-validate/Helm-render/SQL-YAML-MD lint), semgrep, osv-scan, gitleaks, CodeQL (nightly).

## Environment / Config
- Worker env (gitignored `.env` / compose): `PIAGENT_PROVIDER`, `PIAGENT_MODEL_ID`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION` (aliases `AZURE_API_*` accepted), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TEMPORAL_*`, `HTTP_PORT`, `FRONTEND_ORIGIN`.
- Local Temporal namespace override: gitignored `.env.temporal` (`TEMPORAL_NAMESPACE=default`, `TEMPORAL_TASK_QUEUE=main`).
- Supabase keys injected at `make up` time via `scripts/supabase-env.sh` (per-instance, never committed).

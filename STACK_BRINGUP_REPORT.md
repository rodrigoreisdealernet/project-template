# Report — "Bring the Stack Up" (DAY 2 · SESSION 1)

**Date:** 2026-06-24 · **Host:** Rancher Desktop (WSL2) · **Runtime:** Docker 29.1.3 + Compose v5.0.1
**Template:** the "10x template" (this repo) · **Result:** ✅ **stack up and services talking**

> **Slide success criterion:** *"Supabase and Temporal UIs both reachable — services connected."*
> **Achieved:** ✅ Supabase Studio (`:54323`), Temporal UI (`:8081`) and the app (`:3000`) reachable; cross-service connectivity proven over the wire.
> **Automated check:** `make verify` → **PASS=19, WARN=0, FAIL=0** (exit 0).

---

## TL;DR

| # | Slide step | Status | Key evidence |
|---|------------|--------|--------------|
| 1 | Point the agent at the repo and **stand the stack up** in Rancher/Docker | ✅ | 5 compose containers + 12 Supabase containers, all `Up`/`healthy` |
| 2 | **Supabase backend** end-to-end (schema, auth, data layer, seed) | ✅ | 15 migrations · 15 tables · 133 functions/RPCs · pgvector 0.8.2 · auth + MFA |
| 3 | **Frontend** wired to Supabase | ✅ | served bundle carries real `:54321` URL + anon key; Sign-In UI renders |
| 4 | **Verify it is really up** (don't trust clean logs) | ✅ | `scripts/verify-stack.sh` proves 3 cross-service paths; 3 UI screenshots |

Raw evidence in [`docs/stack-bringup-evidence/`](docs/stack-bringup-evidence/) (`backend-db.txt`, `verify-output.txt`, `runtime-state.txt`, `frontend.png`, `temporal-ui.png`, `supabase-studio.png`).

## Environment

```
Docker 29.1.3 + Compose v5.0.1   (Rancher Desktop, WSL2)   ← the "Rancher" of the slide
Node v22.22.2 · npm 10.9.7 · Supabase CLI 2.107.0
```

## Stack topology (ports/URLs)

| Service | Container | URL / host port | Role |
|---|---|---|---|
| Supabase API (Kong) | `supabase_kong_project-template` | http://localhost:54321 | REST/Auth/Storage/Functions gateway |
| **Supabase Studio (UI)** | `supabase_studio_project-template` | **http://localhost:54323** | Supabase admin UI |
| Supabase DB (Postgres 17) | `supabase_db_project-template` | localhost:54322 | Database |
| Supabase Auth (GoTrue) | `supabase_auth_project-template` | …/auth/v1 | Authentication + MFA |
| Mailpit (dev mail) | `supabase_inbucket_project-template` | http://localhost:54324 | Email capture (dev) |
| **Temporal UI** | `temporal-ui` | **http://localhost:8081** | Workflow UI |
| Temporal server | `temporal` | localhost:7234→7233 | Orchestrator (gRPC) |
| Temporal DB | `temporal-db` | localhost:5433 | Temporal's Postgres |
| Temporal worker | `temporal-worker` | http://localhost:3001 | Node.js worker + workflow API |
| Frontend | `frontend` | http://localhost:3000 | Vite/React app (nginx) |

Canonical flow: **Supabase is CLI-managed** (`supabase start`) and **Temporal + worker + frontend** come up via `docker compose`. The per-instance Supabase keys are injected into compose by `scripts/supabase-env.sh`.

---

## Step 1 — Stand the stack up (Rancher/Docker)

The agent ran the setup end-to-end:
1. `supabase start` — Postgres + Kong + Auth + Storage + Realtime + Studio + Edge Runtime (applies migrations + seed).
2. `docker compose build` — builds `temporal-worker` (Node) and `frontend` (Vite→nginx) images from this repo.
3. `eval "$(./scripts/supabase-env.sh)"; docker compose up -d` — injects real Supabase keys and starts Temporal (db/server/ui/worker) + frontend.

**Status:** ✅ Full stack up. See `docs/stack-bringup-evidence/runtime-state.txt`.

---

## Step 2 — Supabase backend (schema · auth · data layer · seed)

The backend was built by the tooling (not by hand): `supabase start` applied **all migrations in order** and ran `seed.sql`. Verified with real Postgres queries (`docs/stack-bringup-evidence/backend-db.txt`):

- **Schema/migrations:** 15 migrations in `supabase_migrations.schema_migrations`; **15 public tables** — `entities, entity_versions, relationships_v2, fact_types, entity_facts, time_series_points` (core ontology) + `workflow_definitions, workflow_executions, workflow_execution_steps, workflow_classifications, workflow_definition_audit_log, workflow_document_extractions, workflow_signals, decision_tables, documents`.
- **Data layer (RPCs):** 133 functions in `public` (e.g. `create_entity_with_version`, `get_workflow_executions`, `match_documents`, `require_aal2`).
- **Analytics/AI:** **pgvector 0.8.2** installed (embeddings on `documents` + `match_documents`).
- **Auth + MFA:** GoTrue up; MFA (AAL2) enforced via `require_aal2`. 3 dev users created (`auth.users` = 3).
- **Security lockdown (proven):** anon direct read of `/rest/v1/entities` → **HTTP 401** (expected — access is via `SECURITY DEFINER` RPCs / service role), while service role → **HTTP 200**.
- **Seed:** `seed.sql` applied (template scaffold; `fact_types` = 1 row).

**Status:** ✅ Backend complete: schema + auth + data layer + seed, all in Docker.

---

## Step 3 — Frontend wired to Supabase

The frontend (Vite + React + `@supabase/supabase-js`) is built in-container (multi-stage → nginx); `VITE_*` vars are injected at **runtime** by the entrypoint (replacing `__VITE_*__` placeholders) with the **real** local Supabase URL + anon key.

- Frontend serves at http://localhost:3000 → **HTTP 200**, React shell present (`<div id="root">`).
- Env injection confirmed in the served bundle (chunk `supabase-*.js`) — **no placeholders remain**; real `http://localhost:54321` URL present.
- **frontend→Supabase proven:** the embedded anon key is accepted by Supabase Auth (`/auth/v1/settings` → **HTTP 200**).
- UI renders the app's Sign-In screen (see `frontend.png`).

**Dev login credentials** (local only, created via `make bootstrap-users` — MFA/TOTP enforced):
`admin@dev.local` / `Admin1234!` · `editor@dev.local` / `Editor1234!` · `readonly@dev.local` / `Readonly1234!`

**Status:** ✅ Frontend up and effectively connected to Supabase.

---

## Step 4 — Verify it is really up (and fix what isn't)

A reusable, testable check ([`scripts/verify-stack.sh`](scripts/verify-stack.sh) + `make verify`) probes every service **over the network** and exercises the cross-service paths — it does **not** trust clean logs:

```
== STEP 2: Supabase backend ==
  [PASS] Supabase REST (PostgREST) reachable (HTTP 200, service role)
  [PASS] Supabase Auth (GoTrue) healthy (/auth/v1/health 200)
  [PASS] Supabase Storage reachable
  [PASS] Supabase Studio UI reachable (http://localhost:54323, HTTP 307)
  [PASS] Postgres reachable · 15 migrations · core 6/6 · workflow 3/3
  [PASS] auth lockdown active: anon denied direct table read (HTTP 401)
== STEP 3: Frontend ==
  [PASS] Frontend serving (HTTP 200) · HTML shell present
  [PASS] Frontend wired to Supabase: real :54321 URL injected (supabase-*.js)
  [PASS] Frontend->Supabase: anon key accepted by Auth (200)
== STEP 4: Temporal + worker + cross-service ==
  [PASS] Temporal UI reachable (http://localhost:8081, 200)
  [PASS] Temporal UI -> server: 'default' namespace listed
  [PASS] Worker->Temporal: poller(s) on task queue 'main'
  [PASS] Worker HTTP health (/health 200)
  [PASS] Worker->Supabase: /workflows/executions returned JSON (200)
== SUMMARY ==  PASS=19  WARN=0  FAIL=0
RESULT: STACK IS UP AND SERVICES ARE TALKING.
```

Visual evidence: `frontend.png` (Sign-In UI), `temporal-ui.png` (default namespace, connected), `supabase-studio.png` (Database Tables with the real schema).

**Status:** ✅ Real connectivity confirmed and operationalized as `make verify`.

---

## Problem found & fixed (honest note)

**Symptom:** on first `docker compose up`, the `temporal-worker` crash-looped:
```
Worker fatal error: Namespace 10x-stack-dev was not found or otherwise could not be described
```
**Diagnosis:** this template's required `.env.temporal.example` defaults to the **dev-Kubernetes** naming (`TEMPORAL_NAMESPACE=10x-stack-dev`, `TEMPORAL_TASK_QUEUE=10x-stack-dev-main`) so local runs mirror staging — but `temporalio/auto-setup` only auto-creates the `default` namespace locally, so the worker's namespace didn't exist.
**Fix (the template's own documented path — README §"Temporal naming"):** created a local, gitignored **`.env.temporal`** override with classic local naming (`TEMPORAL_NAMESPACE=default`, `TEMPORAL_TASK_QUEUE=main`) and recreated the worker. It then reached `state: 'RUNNING'` on task queue `main`. **No committed/tracked file was changed for this fix** — `.env.temporal` is a local override (`.gitignore`d).

---

## Changes made in the repo

| File | Change | Why |
|---|---|---|
| `supabase/config.toml` | `[studio] enabled = true` (+ note) | Slide requires the Supabase UI reachable. Documented & reversible. |
| `.env.temporal` | **new** (gitignored) | Local Temporal namespace override (classic naming) — fixes the worker crash. Not committed. |
| `scripts/verify-stack.sh` | **new** | Reusable cross-service verification (Step 4). |
| `Makefile` | `verify` target (+ `.PHONY`) | Operationalizes the check as `make verify`. |
| `docs/stack-bringup-evidence/` | **new** | Evidence: screenshots + DB/runtime/verify output. |
| `STACK_BRINGUP_REPORT.md` | **new** | This report. |

> `make up` is **unaffected** by the `config.toml` change: it runs `supabase start --exclude studio` and still excludes Studio. The change only matters to a direct `supabase start` (used here to expose the Supabase UI for the lab).

---

## How to operate / reproduce

```bash
# Bring the full stack up (with Studio reachable, as in this exercise):
supabase start                                              # Supabase backend incl. Studio
DOCKER_BUILDKIT=0 docker compose build                      # worker + frontend images
eval "$(./scripts/supabase-env.sh)"; docker compose up -d   # Temporal + worker + frontend

# Verify it is really up (don't trust logs):
make verify                                                 # -> PASS=19, exit 0

# Create dev users (TOTP) for frontend login:
cd temporal && npm install && cd .. && make bootstrap-users

# Tear down:
make down                                                   # compose down + supabase stop
```

**URLs:** Frontend http://localhost:3000 · Temporal UI http://localhost:8081 · Supabase Studio http://localhost:54323 · Supabase API http://localhost:54321 · Dev mail http://localhost:54324

**Revert Studio** to the secure template default: set `[studio] enabled = false` in `supabase/config.toml`, then `supabase stop && supabase start`.

## Caveats

- **Studio enabled** only for this exercise (the slide needs the Supabase UI). Template default is `false` (Studio has no auth). Everything binds locally.
- **Seed** is a template scaffold (1 `fact_type`, no domain rows) — tables show empty in Studio until a domain is seeded.
- **No LLM key needed** for connectivity: the worker connects to Temporal + Supabase without `ANTHROPIC_API_KEY`; the key is only used by the `llm_agent` activity at workflow runtime.

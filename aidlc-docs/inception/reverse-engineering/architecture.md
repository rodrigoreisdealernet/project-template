# System Architecture

## System Overview

A multi-service local-first stack: a React/Vite frontend, a Supabase backend (Postgres source of truth, CLI-managed), a TypeScript Temporal worker running JSON-DSL workflows, and the Temporal server/UI. Two paths reach the one source of truth: **direct CRUD** (frontend → Supabase via supabase-js) for everyday data, and **Edge Function + Temporal** for durable/agentic work. Kubernetes/Helm deployment exists but is placeholdered; the feature targets the local stack.

## Architecture Diagram

```mermaid
flowchart TD
    subgraph Browser
      UI["React + Vite (JSON-driven UI)\nAuthGate -> MfaGate -> Router"]
    end
    subgraph Supabase["Supabase (CLI-managed)"]
      KONG["PostgREST / Kong :54321"]
      AUTH["Auth (GoTrue) + MFA AAL2"]
      PG["Postgres 17 (SCD2 + star + workflow tables)"]
      STG["Storage"]
      EF["Edge Function: trigger-workflow"]
    end
    subgraph TemporalStack["Docker Compose"]
      WK["Temporal Worker (TS)\nHono HTTP API :3001"]
      TS["Temporal Server :7233"]
      TUI["Temporal UI :8081"]
      TDB["Temporal Postgres :5433"]
    end
    LLM["LLM Provider (Azure gpt-5.4 / Anthropic)"]

    UI -->|supabase-js direct CRUD| KONG
    UI -->|POST trigger-workflow JWT| EF
    EF -->|forward| WK
    KONG --> PG
    AUTH --> PG
    WK -->|start/poll| TS
    TS --> TDB
    TUI --> TS
    WK -->|service-role REST| KONG
    WK -->|model call| LLM
```

## Component Descriptions

### Frontend — `frontend/`
- **Purpose**: JSON-driven UI; trigger + observe workflows; browse SCD2 data.
- **Responsibilities**: Auth/MFA gating, page rendering engine, Supabase reads, workflow trigger/detail.
- **Dependencies**: Supabase (anon key), Edge Function, worker HTTP API.
- **Type**: Application.

### Supabase — `supabase/`
- **Purpose**: Source of truth + security boundary.
- **Responsibilities**: schema/migrations, auth/MFA, role-guarded RPCs, read query surfaces, Edge Functions.
- **Dependencies**: none (foundation).
- **Type**: Application/Data.

### Temporal Worker — `temporal/`
- **Purpose**: Durable workflow execution + activities.
- **Responsibilities**: DSL interpretation, activities (LLM/file/HTTP/Supabase/vector), execution tracking, HTTP trigger+query API.
- **Dependencies**: Temporal server, Supabase (service role), LLM provider.
- **Type**: Application.

### Temporal Server/UI/DB — compose services
- **Purpose**: Orchestration backbone + observability.
- **Type**: Infrastructure.

### GitHub Factory — `.github/`
- **Purpose**: Autonomous issue-to-merge (governance, not runtime).
- **Type**: Infrastructure/Tooling.

## Data Flow — NFS-e ingestion (target feature) and existing trigger path

```mermaid
sequenceDiagram
    participant Sched as Temporal Schedule / Scan button
    participant EF as Edge Function trigger-workflow
    participant WK as Worker (DSLWorkflow)
    participant SRC as NFS-e source (mock API / prod API)
    participant LLM as Azure gpt-5.4
    participant PG as Supabase (workflow_document_extractions)
    participant UI as Results screen

    Sched->>EF: trigger nfse-ingest (manual path, JWT)
    EF->>WK: POST /workflows/trigger
    WK->>SRC: GET /invoices (list new)
    loop for_each invoice
        WK->>SRC: GET /invoices/:id/content (PDF)
        WK->>LLM: extract NFS-e fields (schema)
        WK->>PG: upsert extraction (service role)
    end
    UI->>PG: read extractions (supabase-js)
```

## Integration Points
- **External APIs**: LLM providers (Azure OpenAI primary for this feature); Exa Search (optional, web tools). **New**: an NFS-e source API (mock locally; real API in prod).
- **Databases**: Supabase Postgres (app data); Temporal Postgres (workflow history).
- **Third-party Services**: Temporal (orchestration).

## Infrastructure Components
- **Local**: Supabase CLI + Docker Compose (`temporal-db`, `temporal`, `temporal-ui`, `temporal-worker`, `frontend`); optional Traefik HTTPS overlay.
- **Deployment Model (placeholdered)**: Helm charts (app/temporal/postgres/supabase), AKS/EKS, OpenBao + External Secrets Operator, image signing/SBOM/SLSA in CI. **Out of scope** for this feature (local only).
- **Networking**: worker reaches host Supabase via `host.docker.internal:54321`; browser via `localhost:54321`.

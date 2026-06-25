# Spec: Fix NFS-e "Scan now" button hang in trigger-workflow Edge Function

> Issue: [#30](https://github.com/rodrigoreisdealernet/project-template/issues/30) · Status: **DRAFT — awaiting human approval**

## Overview

The NFS-e "Scan now" button on the `/nfse` route never completes — it stays in "Disparando…" state indefinitely because the `trigger-workflow` Supabase Edge Function hangs in the `getUser()` call and/or never reaches the Temporal worker to trigger the `nfse-ingest` workflow. This spec covers fixing both the authentication hang and wiring the worker address.

## Problem / Context

**Frontend behavior**: Clicking "Scan now" on `/nfse` POSTs to the Edge Function with a valid bearer token, but the request hangs for 30+ seconds and ultimately times out, leaving the button stuck. The `/nfse` table read and Temporal Schedule path (15s automatic scans) both work; the problem is isolated to the manual trigger button.

**Root causes identified**:
1. **Auth hang**: The Edge Function calls `authClient.auth.getUser()` with **no JWT argument**, which in the Deno edge runtime falls through GoTrueClient's stored-session / navigator-lock code path and never returns (even with a valid token or bogus bearer). A test from a sidecar proves `kong:8000/auth/v1/user` responds in ~15ms; the hang is not a network issue.
2. **Missing worker address**: `TEMPORAL_TRIGGER_URL` is unset in the edge runtime configuration (`supabase/config.toml` `[edge_runtime.secrets]` is commented out). Even if auth were fixed, the function returns 503 "Workflow trigger service is unavailable".

**Verified working**: The worker's `POST /workflows/trigger` endpoint (`temporal/src/server.ts:216`) returns 201 + real workflow IDs; the automatic 15s schedule path bypasses the Edge Function and completes; frontend wiring is correct.

## Acceptance Criteria

- [ ] **User clicks "Scan now"**: The button changes to "Disparando…" and the Edge Function POST completes promptly (≤ 2 seconds) instead of hanging.
- [ ] **Workflow is triggered**: The POST returns HTTP 200 with `{ workflow_id, run_id }` that match a real Temporal execution visible in the Temporal UI or worker logs.
- [ ] **Success message appears**: The frontend displays "Varredura disparada (workflow <id>)." on success, proving the response was received and parsed correctly.
- [ ] **Table auto-refreshes**: The extraction results table re-fetches within ~5 seconds after a successful trigger, showing new or updated results from the workflow run.
- [ ] **Authenticated requests only**: Unauthenticated POST (no bearer token) returns 401 "Missing bearer token" without hanging, confirming the JWT path is fixed.
- [ ] **Misconfigured worker URL fails gracefully**: If `TEMPORAL_TRIGGER_URL` is unset or unreachable, the function returns 502/503 with a clear error message (not a hang), and the UI displays the error.

## Non-Goals

- Changing how the frontend POSTs the request or parses the response (already correct).
- Modifying the Temporal workflow logic or worker `/workflows/trigger` endpoint (already working).
- Adding new workflow definitions or input validation beyond what exists.
- Deploying to production or changing cloud/staging behavior (local dev fix only).

## Out-of-Scope

- Fixing the 15-second automatic schedule workflow (separate, independent code path; not part of this issue).
- Refactoring the Edge Function's error-handling structure or HTTP status codes (orthogonal improvements).
- Worker network binding or Supabase/Temporal network architecture changes beyond configuring `TEMPORAL_TRIGGER_URL`.

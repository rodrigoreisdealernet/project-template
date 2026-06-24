# Reverse Engineering Metadata

**Analysis Date**: 2026-06-24T15:39:19Z
**Analyzer**: AI-DLC
**Workspace**: C:\Dev\AIAccelerator\project-template
**Method**: Parallel sub-agent analysis (frontend / supabase / infra-CI) + direct worker (TypeScript) inspection.
**Scope note**: Whole-system reverse engineering, with emphasis on the subsystems the automated NFS-e ingestion feature touches (Temporal worker + DSL, Supabase data/security, frontend JSON-UI + workflow trigger/detail). Helm/K8s deploy is documented but out of scope for the feature (local stack only).

## Artifacts Generated
- [x] business-overview.md
- [x] architecture.md
- [x] code-structure.md
- [x] api-documentation.md
- [x] component-inventory.md
- [x] technology-stack.md
- [x] dependencies.md
- [x] code-quality-assessment.md

## Key Corrections to Inherited Docs
- The Temporal worker is **TypeScript**, not Python (several boilerplate docs are stale).
- The persistence table is **workflow_document_extractions** (not `document_extractions`).
- Only **supabase_mutate** is a real DB write path (`supabase_query`/`supabase_core` are stubs).
- Azure **gpt-5.4** works on the provisioned `accelerator-foundary` resource (the README's 404 note is about a different/old sandbox resource).

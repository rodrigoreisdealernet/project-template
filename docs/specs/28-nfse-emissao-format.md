# Spec: Format data_emissao to DD/MM/AAAA in NFS-e Extractions List

**Issue #28** · Status: **DRAFT** (requires human approval before any code is written)

## Overview

The NFS-e extractions table currently renders the "Emissão" (emission date) column as raw ISO dates (e.g., `2026-06-20`). This change formats those dates to Brazilian locale (DD/MM/AAAA, e.g., `20/06/2026`) using the same defensive pattern already established by the `formatBRL()` function for the "Valor total" column.

## Problem / Context

**File evidence:** `frontend/src/routes/nfse/index.tsx`

- **Line 225** renders `data_emissao` verbatim: `{f.data_emissao ?? "—"}`
- **Line 54–59** defines `formatBRL()`, which guards against non-finite values and returns "—" as a fallback
- **Line 209** shows "Emissão" is rendered in the same table that uses `formatBRL()` for "Valor total" (line 224)
- **Line 41** defines `data_emissao?: string | null` in the `ExtractedNfse` interface

Users currently see raw ISO dates in the Emissão column while monetary values are formatted to Brazilian locale. This inconsistency makes extraction results harder to read, especially in business documents where dates are expected in DD/MM/AAAA format.

## Acceptance Criteria

- [ ] The "Emissão" column renders valid ISO dates in DD/MM/AAAA format (e.g., `2026-06-20` → `20/06/2026`)
- [ ] Null or undefined dates render as "—" (em dash) without error
- [ ] Unparseable dates (e.g., invalid ISO strings) render as "—" and do not break the page or show "Invalid Date"
- [ ] The formatter uses only the `data_emissao` field from `extracted_fields` (no additional API calls or reprocessing)
- [ ] The "Número", "Prestador", "Tomador", "Valor total", "Confiança", and "Original" columns remain unchanged
- [ ] The implementation follows the same defensive guard pattern as `formatBRL()` for consistency

## Non-Goals

- Changing the date source or storage format
- Adding timezone handling or date picker components
- Reformatting dates in other parts of the application

## Out-of-Scope

- Localizing other date columns (e.g., `extracted_at`, `created_at`)
- Changing confidence or source URL rendering
- UI redesign or column reordering

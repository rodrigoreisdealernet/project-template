# Domain Entities — nfse-ingestion

Technology-agnostic domain model for the automated NFS-e ingestion feature.

## Entity: SourceInvoice (from the source API / mock API)
A reference to an invoice available at the source, before extraction.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Source-assigned id (e.g., filename stem). |
| `filename` | string | Original file name (e.g., `NFSe_14521.pdf`). |
| `content_url` | string | URL the worker fetches to get the PDF bytes. **Becomes `source_url` in persistence (unique key).** |

- **Lifecycle**: listed by `GET /invoices`; fetched by `GET /invoices/:id/content`.
- **Identity**: `content_url` is the canonical identity for dedup.

## Entity: ExtractedNfse (the 19 extracted fields)
The structured result of the model extraction. Stored as JSONB (`extracted_fields`).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `numero_nota` | string | no (required) | Invoice number. |
| `serie` | string | yes | Série. |
| `codigo_verificacao` | string | yes | Verification code. |
| `data_emissao` | string | yes | Issue date/time (kept as read; ISO-ish or original). |
| `competencia` | string | yes | Competência (e.g., `2026.02` or `06/2026`). |
| `municipio_emissor` | string | yes | Issuing municipality/prefecture. |
| `prestador_razao_social` | string | no (required) | Provider legal name. |
| `prestador_cnpj_cpf` | string | yes | Provider CNPJ/CPF (digits as printed). |
| `tomador_razao_social` | string | no (required) | Recipient legal name. |
| `tomador_cnpj_cpf` | string | yes | Recipient CNPJ/CPF. |
| `descricao_servicos` | string | yes | Free-text service description. |
| `codigo_servico` | string | yes | Service/CNAE/list item code. |
| `valor_total` | number | no (required) | Total service value (numeric, decimal point). |
| `base_calculo` | number | yes | ISS calculation base. |
| `aliquota_iss` | number | yes | ISS rate (% as number, e.g., 5.0). |
| `valor_iss` | number | yes | ISS amount. |
| `iss_retido` | boolean | yes | Whether ISS is withheld. |
| `valor_liquido` | number | yes | Net value. |
| `confidence` | number [0..1] | no (required) | Model's self-reported extraction confidence. |

- **Numeric convention**: all monetary/percent fields are numbers with a decimal point (e.g., `"R$ 1.234,56"` → `1234.56`, `"5,00%"` → `5.0`). The model is instructed to output numerics; the schema enforces `number`.

## Entity: ExtractionRecord (persistence — existing table `workflow_document_extractions`)
The stored row. **No schema change** — reuses the existing table.

| Column | Type | Source |
|---|---|---|
| `id` | uuid | DB default. |
| `source_url` | text UNIQUE NOT NULL | = `SourceInvoice.content_url`. **Dedup/idempotency key.** |
| `extracted_fields` | jsonb NOT NULL | = `ExtractedNfse` (the 19 fields). |
| `confidence` | double precision | = `ExtractedNfse.confidence`. |
| `extracted_at` | timestamptz | run timestamp. |
| `created_at` / `updated_at` | timestamptz | DB-managed. |

- **Access**: SELECT by `authenticated` (the results screen reads directly); INSERT/UPDATE by **service role only** (the worker). Never written from the browser.

## Relationships
```
SourceInvoice (content_url) ──1:1──▶ ExtractionRecord (source_url)
ExtractedNfse  ──embedded as JSONB──▶ ExtractionRecord.extracted_fields
```
- One `ExtractionRecord` per `content_url` (UNIQUE). Re-running the pipeline does not create duplicates (dedup skip + idempotent upsert).

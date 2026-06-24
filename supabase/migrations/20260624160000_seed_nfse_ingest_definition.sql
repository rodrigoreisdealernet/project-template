-- Activate the nfse-ingest workflow definition (feature: automated NFS-e ingestion).
--
-- There is no automatic definition loader: the worker's trigger path loads the
-- ACTIVE definition row from workflow_definitions by name. This migration inserts
-- (idempotently) the nfse-ingest definition with is_active=true so it can be
-- triggered (manual "Scan now") and run by the Temporal Schedule.
--
-- Additive only (ADR-0024): no schema change. The persistence table
-- workflow_document_extractions already exists and is reused as-is.
--
-- The `definition` JSONB MUST mirror temporal/definitions/nfse-ingest.json.

insert into workflow_definitions (name, version, definition, description, is_active, review_status, deployed_at)
values (
  'nfse-ingest',
  '1.0.0',
  $${
    "name": "nfse-ingest",
    "version": "1.0.0",
    "description": "Automatically ingest Brazilian NFS-e: list new invoices from the source API, extract fiscal fields with an LLM (Azure gpt-5.4), and persist them. Dedup handled by nfse_list_new.",
    "steps": {
      "sequence": {
        "steps": [
          {
            "activity": {
              "name": "nfse_list_new",
              "args": {},
              "result": "listing",
              "start_to_close_timeout": "30s",
              "retry": { "max_attempts": 3, "initial_interval": "2s" }
            }
          },
          {
            "for_each": {
              "items": "$var.listing.invoices",
              "item_var": "inv",
              "index_var": "idx",
              "mode": "sequential",
              "body": {
                "try_catch": {
                  "try": {
                    "sequence": {
                      "steps": [
                        {
                          "activity": {
                            "name": "file_extract",
                            "args": { "url": "$var.inv.content_url", "mime_type": "application/pdf" },
                            "result": "doc",
                            "start_to_close_timeout": "60s",
                            "retry": { "max_attempts": 2, "initial_interval": "2s" }
                          }
                        },
                        {
                          "activity": {
                            "name": "llm_agent",
                            "args": {
                              "provider": "azure-openai-responses",
                              "model_id": "gpt-5.4",
                              "temperature": 0,
                              "max_tokens": 1200,
                              "schema_name": "nfse_extraction",
                              "system_prompt": "Você é um extrator de campos de Notas Fiscais de Serviço eletrônicas (NFS-e) brasileiras. A partir do texto do documento, extraia os campos solicitados e responda SOMENTE chamando a ferramenta submit_response. Regras: use ponto como separador decimal (ex.: 1234.56); percentuais como número (ex.: 5.0); campos ausentes devem ser null; iss_retido é true/false; não invente valores; confidence é a sua confiança (0 a 1) na extração.",
                              "user_prompt": "Texto da NFS-e:\n\n$var.doc.text",
                              "response_schema": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["numero_nota", "prestador_razao_social", "tomador_razao_social", "valor_total", "confidence"],
                                "properties": {
                                  "numero_nota": { "type": "string" },
                                  "serie": { "type": ["string", "null"] },
                                  "codigo_verificacao": { "type": ["string", "null"] },
                                  "data_emissao": { "type": ["string", "null"] },
                                  "competencia": { "type": ["string", "null"] },
                                  "municipio_emissor": { "type": ["string", "null"] },
                                  "prestador_razao_social": { "type": "string" },
                                  "prestador_cnpj_cpf": { "type": ["string", "null"] },
                                  "tomador_razao_social": { "type": "string" },
                                  "tomador_cnpj_cpf": { "type": ["string", "null"] },
                                  "descricao_servicos": { "type": ["string", "null"] },
                                  "codigo_servico": { "type": ["string", "null"] },
                                  "valor_total": { "type": "number" },
                                  "base_calculo": { "type": ["number", "null"] },
                                  "aliquota_iss": { "type": ["number", "null"] },
                                  "valor_iss": { "type": ["number", "null"] },
                                  "iss_retido": { "type": ["boolean", "null"] },
                                  "valor_liquido": { "type": ["number", "null"] },
                                  "confidence": { "type": "number" }
                                }
                              }
                            },
                            "result": "extraction",
                            "start_to_close_timeout": "120s",
                            "retry": { "max_attempts": 2, "initial_interval": "3s" }
                          }
                        },
                        {
                          "condition": {
                            "if": "$var.extraction.content_filter_blocked == false",
                            "then": {
                              "activity": {
                                "name": "supabase_mutate",
                                "args": {
                                  "operation": "upsert",
                                  "table": "workflow_document_extractions",
                                  "match": { "source_url": "$var.inv.content_url" },
                                  "values": {
                                    "source_url": "$var.inv.content_url",
                                    "extracted_fields": "$var.extraction.parsed",
                                    "confidence": "$var.extraction.parsed.confidence",
                                    "extracted_at": "$var.listing.run_at"
                                  }
                                },
                                "result": "persisted",
                                "start_to_close_timeout": "30s",
                                "retry": { "max_attempts": 3, "initial_interval": "2s" }
                              }
                            }
                          }
                        }
                      ]
                    }
                  },
                  "catch": {
                    "error_var": "ingest_error",
                    "body": { "set_variable": { "name": "last_error", "value": "$var.ingest_error" } }
                  }
                }
              }
            }
          }
        ]
      }
    }
  }$$::jsonb,
  'Automated NFS-e ingestion (mock API source in POC; real API in prod).',
  true,
  'approved',
  now()
)
on conflict (name, version) do update
  set definition    = excluded.definition,
      description    = excluded.description,
      is_active      = true,
      review_status  = 'approved',
      deployed_at    = now(),
      updated_at     = now();

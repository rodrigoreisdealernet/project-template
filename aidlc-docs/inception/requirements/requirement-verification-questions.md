# Requirements Verification Questions — Automated NFS-e Ingestion & Extraction

Responda preenchendo a letra após cada `[Answer]:`. Se nenhuma opção servir, use **X) Other** e descreva.

> **Já resolvido pelos input docs** (`aidlc-inputs/vision.md` + `technical-environment.md`) — **não preciso perguntar**:
> tipo de documento = **NFS-e**; interação = **automática (sem colar/upload)**; fonte POC = **mock API local** / produção = API real; gatilho = **Temporal Schedule + scan manual**; modelo = **Azure gpt-5.4** (env-only); forma do workflow = **definição DSL com `for_each`** (não workflow TS dedicado); persistência = **`workflow_document_extractions`**, escrita incondicional, `source_url` = URL da nota (chave única → dedup); leitura na tela = supabase-js; rotas atrás de `AuthGate`→`MfaGate`.

---

## Extensões AI-DLC (decisão obrigatória)

## Question 1 — Extensão de Segurança

Devem as regras da extensão de **Segurança** ser aplicadas como restrições bloqueantes neste projeto?

A) Sim — aplicar todas as regras de SECURITY como restrições bloqueantes (recomendado para aplicações de produção)

B) Não — pular as regras de SECURITY (adequado para PoCs, protótipos e experimentos)

X) Other (descreva após [Answer]:)

[Answer]: B

## Question 2 — Extensão de Resiliência

Deve a **baseline de Resiliência** (boas práticas direcionais do AWS Well-Architected — Reliability) ser aplicada?

A) Sim — aplicar a baseline de resiliência como guia de design (recomendado para workloads críticos)

B) Não — pular a baseline de resiliência (adequado para PoCs e protótipos onde iteração rápida importa mais)

X) Other (descreva após [Answer]:)

[Answer]: B

## Question 3 — Extensão de Property-Based Testing (PBT)

Devem as regras de **Property-Based Testing** ser aplicadas?

A) Sim — aplicar PBT como restrição bloqueante (recomendado p/ lógica de negócio, transformações, serialização)

B) Parcial — PBT só para funções puras e round-trips de serialização

C) Não — pular PBT (adequado p/ CRUD simples, UI, camadas finas de integração)

X) Other (descreva após [Answer]:)

[Answer]: C — revertido pelo usuário: é apenas uma POC, sem PBT.

---

## Decisões específicas da feature (pontos ainda em aberto)

## Question 4 — Forma do mock API de NFS-e (POC)

Como implementar a fonte local que o workflow consome?

A) Um pequeno serviço no docker-compose (Node/Hono) expondo `GET /invoices` (lista) e `GET /invoices/:id/content` (PDF), servindo os PDFs de `docs/examples/` (recomendado — mais fiel à API de produção)

B) Um servidor estático simples servindo os PDFs + um `manifest.json` com a lista (mais leve, menos "API")

C) Uma rota nova no próprio worker (Hono) servindo as notas (menos serviços, mas mistura fonte com o worker)

X) Other (descreva após [Answer]:)

[Answer]: A

## Question 5 — Cadência e criação da Temporal Schedule

Com que frequência o ingest roda automaticamente, e como a Schedule é criada?

A) A cada ~2 min, criada por um script de bootstrap (`schedule create`) no `make up`; + botão "scan agora" (recomendado p/ demo)

B) A cada ~5 min, mesmo mecanismo

C) Sem Schedule por enquanto — só o botão "scan agora" (deixar a Schedule documentada p/ depois)

X) Other (descreva após [Answer]:)

[Answer]: 15 seconds

## Question 6 — Detecção de "nota nova" (dedup)

Como evitar reprocessar notas já extraídas?

A) Dedup por `source_url` já existente no banco — o worker lista tudo e pula as já gravadas; upsert idempotente (recomendado)

B) O mock API expõe um flag/endpoint de "não processadas" e marca como processada após sucesso

C) Reprocessar todas a cada rodada (upsert sobrescreve) — mais simples, menos realista

X) Other (descreva após [Answer]:)

[Answer]: A

## Question 7 — Conjunto de campos da NFS-e

Confirma o schema de extração proposto?

A) Os 19 campos propostos (numero_nota, serie, codigo_verificacao, data_emissao, competencia, municipio_emissor, prestador_razao_social/cnpj_cpf, tomador_razao_social/cnpj_cpf, descricao_servicos, codigo_servico, valor_total, base_calculo, aliquota_iss, valor_iss, iss_retido, valor_liquido, confidence) (recomendado)

B) Um núcleo reduzido (numero_nota, prestador, tomador, valor_total, data_emissao, confidence) p/ demo mais enxuta

C) Os 19 campos + campos automotivos agora (placa, chassi, OS, modelo) — relevante p/ oficinas, mais trabalho

X) Other (descreva após [Answer]:)

[Answer]: A

## Question 8 — Baixa confiança / content filter

O que fazer quando a extração tem baixa confiança ou é bloqueada pelo content filter do modelo?

A) Gravar mesmo assim, com o `confidence`, e sinalizar visualmente "baixa confiança" na tela; se `content_filter_blocked`, não gravar e registrar no trace (recomendado)

B) Não gravar abaixo de um limiar (ex.: 0.5) e registrar no trace/alerta

C) Gravar sempre, sem distinção visual

X) Other (descreva após [Answer]:)

[Answer]: A

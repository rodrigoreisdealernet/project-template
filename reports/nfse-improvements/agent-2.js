window.__AGENTS = window.__AGENTS || {};
window.__AGENTS[2] = {
  id: 2,
  title: "#2 Dedup com leitura limitada",
  subtitle: "Trocar varredura da tabela inteira por consulta de pertinência source_url=in.(...)",
  owner: "temporal/src/activities/nfse_list_new.ts",
  state: "done",
  progress: 100,
  current: "Concluído — 4 testes verdes",
  steps: [
    { label: "Ler nfse_list_new.ts e seu teste", done: true },
    { label: "Buscar origem primeiro, consultar existentes por in.(...)", done: true },
    { label: "Chunking + encoding seguro das URLs", done: true },
    { label: "Atualizar mock do teste para a query nova", done: true },
    { label: "Rodar teste e validar verde", done: true }
  ],
  files: ["temporal/src/activities/nfse_list_new.ts", "temporal/tests/nfse_list_new.test.ts"],
  log: [
    "Iniciado: arquivos lidos",
    "Runner detectado: Jest (jest --forceExit), nao vitest",
    "fetchExistingSourceUrls agora consulta source_url=in.(...) em lotes de CHUNK_SIZE=100",
    "Origem buscada antes; lista vazia evita leitura no DB",
    "Testes atualizados: +query limitada, +pula DB quando origem vazia",
    "node_modules reparado com npm install (.bin/ts-jest faltando)",
    "Teste verde: Test Suites: 1 passed; Tests: 4 passed"
  ],
  result: {
    summary: "Dedup agora é leitura de pertinência limitada (source_url=in.(...)) em lotes de 100, com encoding seguro; não há mais varredura da tabela inteira. Lista de origem vazia pula o DB.",
    tests: "Test Suites: 1 passed, 1 total / Tests: 4 passed, 4 total",
    caveats: "CHUNK_SIZE=100 assume URLs de NFS-e curtas; com URLs muito longas pode ser necessário reduzir o lote para respeitar limites de tamanho da URL. node_modules do temporal precisou de npm install (shims .bin ausentes)."
  }
};

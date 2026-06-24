window.__AGENTS = window.__AGENTS || {};
window.__AGENTS[1] = {
  id: 1,
  title: "#1 Guard de drift da definição",
  subtitle: "Arquivo .json como fonte única + teste de paridade (arquivo × seed × schedule)",
  owner: "temporal/tests · supabase/migrations (seed)",
  state: "done",
  progress: 100,
  current: "Concluído: 8/8 testes verdes",
  steps: [
    { label: "Ler definição, seed SQL e bootstrap", done: true },
    { label: "Sincronizar JSON da seed com o arquivo (fonte única)", done: true },
    { label: "Teste de paridade: arquivo == seed (deep-equal)", done: true },
    { label: "Teste: schedule/bootstrap deriva do arquivo", done: true },
    { label: "Rodar teste e validar verde", done: true }
  ],
  files: [
    "supabase/migrations/20260624160000_seed_nfse_ingest_definition.sql",
    "temporal/tests/nfse-ingest.definition.test.ts"
  ],
  log: [
    "Definicao, seed SQL e bootstrap lidos",
    "Runner detectado: Jest (temporal/package.json)",
    "Drift confirmado: description da seed diverge do arquivo",
    "Seed sincronizada com o arquivo (description divergente corrigida)",
    "Testes de paridade adicionados (arquivo==seed, bootstrap deriva do arquivo)",
    "Jest: Test Suites 1 passed; Tests 8 passed, 8 total"
  ],
  result: "Seed alinhada ao arquivo .json (fonte única) e 2 guard-tests adicionados. Jest: 8/8 testes verdes."
};

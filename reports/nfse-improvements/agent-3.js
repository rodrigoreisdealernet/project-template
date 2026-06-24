window.__AGENTS = window.__AGENTS || {};
window.__AGENTS[3] = {
  id: 3,
  title: "#3 Caminho de revisão (baixa confiança)",
  subtitle: "Filtro de pendentes, contador, e link para o PDF original — UI only",
  owner: "frontend/src/routes/nfse/index.tsx",
  state: "done",
  progress: 100,
  current: "Concluído: 8 testes verdes, tsc limpo.",
  steps: [
    { label: "Ler index.tsx e seu teste", done: true },
    { label: "Filtro 'só pendentes de revisão' + contador", done: true },
    { label: "Link para o PDF original (source_url)", done: true },
    { label: "Testes do filtro/contador/link", done: true },
    { label: "Rodar teste e validar verde", done: true }
  ],
  files: [
    "frontend/src/routes/nfse/index.tsx",
    "frontend/src/routes/nfse/nfse-extractions.test.tsx"
  ],
  log: [
    "Iniciado: configurando status e lendo arquivos",
    "Li index.tsx e nfse-extractions.test.tsx; runner = vitest",
    "Adicionei needsReview() e countPendingReview() exportados",
    "UI: contador amber, toggle 'só pendentes', coluna Original com 'Ver PDF'",
    "Testes unitarios adicionados para os novos helpers",
    "npm install na pasta frontend (node_modules estava ausente)",
    "vitest: Test Files 1 passed (1) | Tests 8 passed (8)",
    "tsc --noEmit: 0 erros no frontend"
  ],
  result: "Sucesso. Helpers needsReview/countPendingReview exportados e testados; UI ganhou contador 'N pendente(s) de revisão', toggle 'Mostrar só pendentes de revisão' (state local, default off, mantém polling/Scan now) e coluna 'Original' com link 'Ver PDF' (target=_blank rel=noopener noreferrer). vitest: 8/8 verdes; tsc sem erros."
};

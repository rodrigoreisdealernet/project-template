import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/data/supabase";

// Results screen for the automated NFS-e ingestion feature.
// Reads extracted invoices directly from Supabase (authenticated read; the worker
// is the only writer) and offers a manual "Scan now" that triggers the nfse-ingest
// workflow via the existing Edge Function path (same as the generic trigger screen).

const DEFAULT_FUNCTIONS_BASE_URL = "http://localhost:54321/functions/v1";
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function isLowConfidence(confidence: unknown): boolean {
  return typeof confidence === "number" && confidence < LOW_CONFIDENCE_THRESHOLD;
}

// A row needs a human's review when its confidence is a number below the threshold.
export function needsReview(row: { confidence: number | null }): boolean {
  return isLowConfidence(row.confidence);
}

// How many rows still need review (low confidence).
export function countPendingReview(rows: ReadonlyArray<{ confidence: number | null }>): number {
  return rows.reduce((total, row) => (needsReview(row) ? total + 1 : total), 0);
}

interface ExtractedNfse {
  numero_nota?: string | null;
  prestador_razao_social?: string | null;
  tomador_razao_social?: string | null;
  valor_total?: number | null;
  data_emissao?: string | null;
  [key: string]: unknown;
}

interface ExtractionRow {
  id: string;
  source_url: string;
  extracted_fields: ExtractedNfse;
  confidence: number | null;
  extracted_at: string | null;
  created_at: string;
}

function formatBRL(value: unknown): string {
  if (typeof value !== "number") return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function fetchExtractions(): Promise<ExtractionRow[]> {
  const { data, error } = await supabase
    .from("workflow_document_extractions")
    .select("id, source_url, extracted_fields, confidence, extracted_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as ExtractionRow[];
}

export const Route = createFileRoute("/nfse/")({
  component: NfseExtractionsPage,
});

function NfseExtractionsPage() {
  const queryClient = useQueryClient();
  const {
    data: rows,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["nfse-extractions"],
    queryFn: fetchExtractions,
    // Surface scheduled-run results without a manual reload.
    refetchInterval: 5000,
  });

  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);

  const allRows = rows ?? [];
  const pendingReviewCount = countPendingReview(allRows);
  const visibleRows = reviewOnly ? allRows.filter(needsReview) : allRows;

  async function onScanNow() {
    setScanning(true);
    setScanError(null);
    setScanMessage(null);
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      const apiUrl = `${import.meta.env.VITE_API_URL || DEFAULT_FUNCTIONS_BASE_URL}/trigger-workflow`;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ definition_name: "nfse-ingest", input: {} }),
      });
      const payload = (await response.json()) as { workflow_id?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Falha ao disparar a varredura.");
      setScanMessage(`Varredura disparada (workflow ${payload.workflow_id ?? "?"}).`);
      // Give the workflow a moment, then refresh the list.
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["nfse-extractions"] }), 2500);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Falha ao disparar a varredura.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <section className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Notas Fiscais (NFS-e) — Extrações
          </h1>
          <p className="text-sm text-muted-foreground">
            Notas processadas automaticamente pelo workflow <code>nfse-ingest</code>. A varredura
            roda sozinha a cada 15s; use “Scan now” para forçar agora.
          </p>
          {pendingReviewCount > 0 ? (
            <span
              data-testid="nfse-review-count"
              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
            >
              {pendingReviewCount} pendente(s) de revisão
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="nfse-scan-now-button"
          disabled={scanning}
          onClick={onScanNow}
        >
          {scanning ? "Disparando..." : "Scan now"}
        </button>
      </header>

      {scanMessage ? (
        <p className="text-sm text-green-700" data-testid="nfse-scan-message">
          {scanMessage}
        </p>
      ) : null}
      {scanError ? (
        <p className="text-sm text-red-600" data-testid="nfse-scan-error">
          {scanError}
        </p>
      ) : null}

      <label
        className="inline-flex items-center gap-2 text-sm text-muted-foreground select-none"
        data-testid="nfse-review-filter-label"
      >
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-input"
          data-testid="nfse-review-filter"
          checked={reviewOnly}
          onChange={(e) => setReviewOnly(e.target.checked)}
        />
        Mostrar só pendentes de revisão
      </label>

      <div className="rounded-xl border bg-card overflow-hidden">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Carregando…</p>
        ) : error ? (
          <p className="p-6 text-sm text-red-600">Erro ao carregar: {(error as Error).message}</p>
        ) : allRows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="nfse-empty">
            Nenhuma nota processada ainda — aguarde a próxima varredura ou clique em “Scan now”.
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="nfse-review-empty">
            Nenhuma nota pendente de revisão.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="nfse-table">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Número</th>
                <th className="px-4 py-2 font-medium">Prestador</th>
                <th className="px-4 py-2 font-medium">Tomador</th>
                <th className="px-4 py-2 font-medium text-right">Valor total</th>
                <th className="px-4 py-2 font-medium">Emissão</th>
                <th className="px-4 py-2 font-medium">Confiança</th>
                <th className="px-4 py-2 font-medium">Original</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const f = row.extracted_fields ?? {};
                const low = isLowConfidence(row.confidence);
                return (
                  <tr key={row.id} className="border-t" data-testid="nfse-row">
                    <td className="px-4 py-2">{f.numero_nota ?? "—"}</td>
                    <td className="px-4 py-2">{f.prestador_razao_social ?? "—"}</td>
                    <td className="px-4 py-2">{f.tomador_razao_social ?? "—"}</td>
                    <td className="px-4 py-2 text-right">{formatBRL(f.valor_total)}</td>
                    <td className="px-4 py-2">{f.data_emissao ?? "—"}</td>
                    <td className="px-4 py-2">
                      {row.confidence == null ? (
                        "—"
                      ) : (
                        <span
                          data-testid={low ? "nfse-low-confidence" : "nfse-confidence"}
                          className={
                            low
                              ? "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                              : "inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
                          }
                        >
                          {(row.confidence * 100).toFixed(0)}%{low ? " · baixa" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {row.source_url ? (
                        <a
                          href={row.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline underline-offset-2 hover:no-underline"
                          data-testid="nfse-open-source"
                        >
                          Ver PDF
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

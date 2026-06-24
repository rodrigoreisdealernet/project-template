// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Component-level tests for the NFS-e results screen. The pure helpers are covered
// in nfse-extractions.test.tsx; here we render the actual <NfseExtractionsPage/> and
// drive the table rendering, the confidence badge, the review filter, the four
// list states, and the "Scan now" trigger (success + error). useQuery is mocked so
// each test controls the data/loading/error state directly.

// ── Module mocks ────────────────────────────────────────────────────────────────

const getSession = vi.fn(async () => ({ data: { session: { access_token: "tok-123" } } }));
vi.mock("@/data/supabase", () => ({ supabase: { auth: { getSession: () => getSession() } } }));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, createFileRoute: () => (opts: { component: unknown }) => opts };
});

type UseQueryResult = {
  data: unknown;
  isLoading: boolean;
  error: unknown;
};

let extractionsResult: UseQueryResult = { data: [], isLoading: false, error: null };
const invalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => extractionsResult,
    useQueryClient: () => ({ invalidateQueries }),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    source_url: "http://mock-nfse-api:8090/invoices/402/content",
    extracted_fields: {
      numero_nota: "402",
      prestador_razao_social: "Prestador LTDA",
      tomador_razao_social: "Tomador SA",
      valor_total: 245.05,
      data_emissao: "2026-06-20",
    },
    confidence: 0.95,
    extracted_at: "2026-06-24T10:00:00.000Z",
    created_at: "2026-06-24T10:00:00.000Z",
    ...overrides,
  };
}

async function renderPage() {
  const { NfseExtractionsPage } = await import("@/routes/nfse/index");
  return render(<NfseExtractionsPage />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  extractionsResult = { data: [], isLoading: false, error: null };
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe("NfseExtractionsPage — rendering", () => {
  it("renders a row per extraction with formatted BRL and high-confidence badge", async () => {
    extractionsResult = { data: [row()], isLoading: false, error: null };
    await renderPage();

    const rows = await screen.findAllByTestId("nfse-row");
    expect(rows).toHaveLength(1);

    const cells = within(rows[0]);
    expect(cells.getByText("402")).toBeInTheDocument();
    expect(cells.getByText("Prestador LTDA")).toBeInTheDocument();
    // pt-BR currency formatting (non-breaking space between R$ and amount).
    expect(cells.getByText(/R\$\s*245,05/)).toBeInTheDocument();

    // 0.95 >= 0.7 -> high-confidence (green) badge, no "baixa" suffix.
    const badge = cells.getByTestId("nfse-confidence");
    expect(badge).toHaveTextContent("95%");
    expect(badge).not.toHaveTextContent("baixa");
    expect(cells.queryByTestId("nfse-low-confidence")).not.toBeInTheDocument();

    // Original PDF link points at the source_url.
    expect(cells.getByTestId("nfse-open-source")).toHaveAttribute("href", row().source_url);

    // Issue #28 (AC1): the Emissão column (5th cell) shows the date in DD/MM/AAAA,
    // not the raw ISO "2026-06-20".
    const emissaoCell = rows[0].querySelectorAll("td")[4];
    expect(emissaoCell.textContent).toBe("20/06/2026");
  });

  // Issue #28 (AC2): a null data_emissao renders the em dash placeholder, not
  // "Invalid Date" or an empty cell.
  it("renders an em dash in the Emissão column for a null data_emissao", async () => {
    extractionsResult = {
      data: [
        row({
          id: "no-date",
          extracted_fields: {
            numero_nota: "402",
            valor_total: 245.05,
            data_emissao: null,
          },
        }),
      ],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    // Emissão is the 5th column (index 4).
    const emissaoCell = r.querySelectorAll("td")[4];
    expect(emissaoCell.textContent).toBe("—");
    // And no raw/invalid date leaked into the row.
    expect(within(r).queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(within(r).queryByText(/\d{4}-\d{2}-\d{2}/)).not.toBeInTheDocument();
  });

  // Issue #28 (AC3): an unparseable data_emissao renders the em dash placeholder,
  // not "Invalid Date" and not the raw malformed string.
  it("renders an em dash in the Emissão column for an unparseable data_emissao", async () => {
    extractionsResult = {
      data: [
        row({
          id: "bad-date",
          extracted_fields: {
            numero_nota: "402",
            valor_total: 245.05,
            data_emissao: "2026/06/20",
          },
        }),
      ],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    // Emissão is the 5th column (index 4).
    const emissaoCell = r.querySelectorAll("td")[4];
    expect(emissaoCell.textContent).toBe("—");
    // No "Invalid Date" and no raw malformed string leaked into the row.
    expect(within(r).queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(within(r).queryByText("2026/06/20")).not.toBeInTheDocument();
  });

  it("flags a low-confidence row with the amber badge and a pending-review pill", async () => {
    extractionsResult = {
      data: [row({ id: "low", confidence: 0.42 })],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const badge = await screen.findByTestId("nfse-low-confidence");
    expect(badge).toHaveTextContent("42%");
    expect(badge).toHaveTextContent("baixa");
    expect(screen.getByTestId("nfse-review-count")).toHaveTextContent("1 pendente");
  });

  // Regression (red-team #2): source_url is untrusted (external API). A non-http
  // scheme must NOT become a clickable link (stored-XSS vector).
  it("does not render a clickable link for a javascript: source_url", async () => {
    extractionsResult = {
      data: [row({ id: "xss", source_url: "javascript:alert(document.cookie)" })],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    expect(within(r).queryByTestId("nfse-open-source")).not.toBeInTheDocument();
    // And no anchor with a javascript: href leaked into the row.
    expect(r.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  // Regression (red-team #4): non-finite valor_total must render as a placeholder,
  // not "R$ NaN" / "R$ ∞".
  it("renders an em dash for a non-finite valor_total (Infinity/NaN)", async () => {
    extractionsResult = {
      data: [
        row({
          id: "inf",
          extracted_fields: { numero_nota: "Z", valor_total: Infinity },
        }),
      ],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    // No currency string anywhere in the row...
    expect(within(r).queryByText(/R\$/)).not.toBeInTheDocument();
    // ...and the valor-total cell (4th column) shows the placeholder, not "R$ ∞".
    const valorCell = r.querySelectorAll("td")[3];
    expect(valorCell.textContent).toBe("—");
  });

  // Regression (red-team #3): an impossible confidence (150%) must be flagged for
  // review, not shown as a green high-confidence badge.
  it("flags an out-of-range confidence (1.5) for review instead of treating it as high", async () => {
    extractionsResult = {
      data: [row({ id: "over", confidence: 1.5 })],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    expect(within(r).getByTestId("nfse-low-confidence")).toBeInTheDocument();
    expect(within(r).queryByTestId("nfse-confidence")).not.toBeInTheDocument();
    expect(screen.getByTestId("nfse-review-count")).toHaveTextContent("1 pendente");
  });

  it("renders an em dash for null valor_total and hides the badge for null confidence", async () => {
    extractionsResult = {
      data: [
        row({
          id: "nulls",
          confidence: null,
          extracted_fields: { numero_nota: "X", valor_total: null },
        }),
      ],
      isLoading: false,
      error: null,
    };
    await renderPage();

    const r = (await screen.findAllByTestId("nfse-row"))[0];
    expect(within(r).queryByTestId("nfse-confidence")).not.toBeInTheDocument();
    expect(within(r).queryByTestId("nfse-low-confidence")).not.toBeInTheDocument();
    // No pending-review pill when the only row has null (non-numeric) confidence.
    expect(screen.queryByTestId("nfse-review-count")).not.toBeInTheDocument();
  });
});

// ── List states ───────────────────────────────────────────────────────────────

describe("NfseExtractionsPage — list states", () => {
  it("shows the loading state", async () => {
    extractionsResult = { data: undefined, isLoading: true, error: null };
    await renderPage();
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });

  it("shows the error state with the error message", async () => {
    extractionsResult = { data: undefined, isLoading: false, error: new Error("boom-db") };
    await renderPage();
    expect(screen.getByText(/Erro ao carregar: boom-db/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no extractions", async () => {
    extractionsResult = { data: [], isLoading: false, error: null };
    await renderPage();
    expect(screen.getByTestId("nfse-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("nfse-table")).not.toBeInTheDocument();
  });
});

// ── Review filter ───────────────────────────────────────────────────────────────

describe("NfseExtractionsPage — review filter", () => {
  it("filters to only low-confidence rows when 'review only' is checked", async () => {
    extractionsResult = {
      data: [row({ id: "hi", confidence: 0.95 }), row({ id: "lo", confidence: 0.4 })],
      isLoading: false,
      error: null,
    };
    await renderPage();

    expect(await screen.findAllByTestId("nfse-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("nfse-review-filter"));

    // Only the low-confidence row survives the filter.
    const rows = screen.getAllByTestId("nfse-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByTestId("nfse-low-confidence")).toBeInTheDocument();
  });

  it("shows the review-empty state when filtering and all rows are high-confidence", async () => {
    extractionsResult = {
      data: [row({ id: "hi", confidence: 0.95 })],
      isLoading: false,
      error: null,
    };
    await renderPage();

    fireEvent.click(screen.getByTestId("nfse-review-filter"));
    expect(screen.getByTestId("nfse-review-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("nfse-table")).not.toBeInTheDocument();
  });
});

// ── Scan now ─────────────────────────────────────────────────────────────────

describe("NfseExtractionsPage — Scan now", () => {
  it("posts the nfse-ingest trigger and shows the workflow id on success", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ workflow_id: "wf-xyz" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    extractionsResult = { data: [row()], isLoading: false, error: null };
    await renderPage();

    fireEvent.click(screen.getByTestId("nfse-scan-now-button"));

    await waitFor(() => {
      expect(screen.getByTestId("nfse-scan-message")).toHaveTextContent("wf-xyz");
    });

    // It triggered the correct workflow with a bearer token from the session.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/trigger-workflow");
    expect(JSON.parse(String(init.body))).toMatchObject({ definition_name: "nfse-ingest" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");

    vi.unstubAllGlobals();
  });

  it("surfaces the server error message when the trigger fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "definição não permitida" }), { status: 403 })
    );
    vi.stubGlobal("fetch", fetchMock);

    extractionsResult = { data: [], isLoading: false, error: null };
    await renderPage();

    fireEvent.click(screen.getByTestId("nfse-scan-now-button"));

    await waitFor(() => {
      expect(screen.getByTestId("nfse-scan-error")).toHaveTextContent("definição não permitida");
    });
    expect(screen.queryByTestId("nfse-scan-message")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});

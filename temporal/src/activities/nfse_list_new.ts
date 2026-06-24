/**
 * nfse_list_new — list NFS-e invoices from the source API and return only the
 * ones not yet extracted (dedup against the DB).
 *
 * Why an activity (not raw DSL steps): the DSL expression layer's `$env.*`
 * resolves from the workflow variable bag, NOT the worker process env — so a DSL
 * step cannot read SUPABASE_URL / the service-role key. And `supabase_query`
 * (read) is a stub. This activity runs worker-side where `config` exposes the
 * Supabase URL + service key, so it can both call the source API and read the
 * existing extractions to filter. (See functional-design Design decision.)
 *
 * The source API contract (mock locally, real in prod):
 *   GET {NFSE_SOURCE_API_URL}/invoices -> { invoices: [{ id, filename, content_url }] }
 * Dedup key = content_url (== workflow_document_extractions.source_url, UNIQUE).
 */
import { log } from "@temporalio/activity";
import {
  config,
  MISSING_SUPABASE_SERVICE_ROLE_KEY,
  UNINJECTED_SUPABASE_SERVICE_ROLE_KEY,
} from "../config";

function safeLogInfo(message: string, attributes: Record<string, unknown>): void {
  try {
    log.info(message, attributes);
  } catch {
    // Unit tests call this outside a Temporal activity context.
  }
}

export interface NfseInvoiceRef {
  id: string;
  filename: string;
  content_url: string;
}

export interface NfseListNewArgs {
  /** Override the source API base URL (defaults to config.nfseSourceApiUrl). */
  source_api_url?: string;
  _idempotency_key?: string;
}

export interface NfseListNewResult {
  /** Invoices NOT yet present in workflow_document_extractions. */
  invoices: NfseInvoiceRef[];
  /** ISO timestamp captured at list time (used as extracted_at by the workflow). */
  run_at: string;
  total: number;
  new_count: number;
  skipped_count: number;
}

function assertSupabaseConfig(): void {
  if (!config.supabaseUrl) throw new Error("nfse_list_new: SUPABASE_URL is required");
  if (
    !config.supabaseServiceKey ||
    config.supabaseServiceKey === MISSING_SUPABASE_SERVICE_ROLE_KEY ||
    config.supabaseServiceKey === UNINJECTED_SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error("nfse_list_new: SUPABASE_SERVICE_ROLE_KEY is required");
  }
}

const FETCH_TIMEOUT_MS = 20_000;
// Page size for reading existing source_urls. PostgREST caps responses at its
// configured max-rows (often 1000); we page explicitly so dedup stays correct
// beyond that cap (review finding A1).
const EXISTING_PAGE_SIZE = 1000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error(`nfse_list_new: request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSourceInvoices(baseUrl: string): Promise<NfseInvoiceRef[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/invoices`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`nfse_list_new: source ${url} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let body: { invoices?: NfseInvoiceRef[] };
  try {
    body = (await res.json()) as { invoices?: NfseInvoiceRef[] };
  } catch {
    throw new Error(`nfse_list_new: source ${url} returned non-JSON`);
  }
  const invoices = Array.isArray(body.invoices) ? body.invoices : [];
  return invoices.filter((i) => i && typeof i.content_url === "string" && i.content_url.length > 0);
}

async function fetchExistingSourceUrls(): Promise<Set<string>> {
  // Service-role read of already-extracted invoices (source_url is the dedup key).
  // Paginated with limit/offset so we are not silently capped by PostgREST max-rows.
  const headers = {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
  };
  const existing = new Set<string>();
  for (let offset = 0; ; offset += EXISTING_PAGE_SIZE) {
    const url =
      `${config.supabaseUrl}/rest/v1/workflow_document_extractions` +
      `?select=source_url&order=source_url.asc&limit=${EXISTING_PAGE_SIZE}&offset=${offset}`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`nfse_list_new: existing read HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<{ source_url?: string }>;
    for (const r of rows) {
      if (typeof r.source_url === "string") existing.add(r.source_url);
    }
    if (rows.length < EXISTING_PAGE_SIZE) break;
  }
  return existing;
}

export async function nfse_list_new(args: NfseListNewArgs = {}): Promise<NfseListNewResult> {
  assertSupabaseConfig();
  const baseUrl = args.source_api_url ?? config.nfseSourceApiUrl;

  const [all, existing] = await Promise.all([
    fetchSourceInvoices(baseUrl),
    fetchExistingSourceUrls(),
  ]);

  const invoices = all.filter((inv) => !existing.has(inv.content_url));
  const run_at = new Date().toISOString();

  safeLogInfo("nfse_list_new", {
    source: baseUrl,
    total: all.length,
    new: invoices.length,
    skipped: all.length - invoices.length,
  });

  return {
    invoices,
    run_at,
    total: all.length,
    new_count: invoices.length,
    skipped_count: all.length - invoices.length,
  };
}

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
 *
 * Dedup is a BOUNDED MEMBERSHIP READ (not a full-table scan): we fetch the small
 * source list first, then ask the DB only about the source_urls in that list via
 * a PostgREST `source_url=in.(...)` filter (chunked to stay under URL limits).
 * The workflow runs every ~15s, so the steady-state read cost is proportional to
 * the source list size, NOT the total size of workflow_document_extractions.
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
// Max number of source_urls per membership (`in.(...)`) request. Chunking keeps
// the request URL under server/proxy length limits as the source list grows.
const CHUNK_SIZE = 100;

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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchExistingSourceUrls(urls: string[]): Promise<Set<string>> {
  // Service-role membership read: ask only about the source_urls we are about to
  // consider (the current source list), instead of scanning the whole table.
  const existing = new Set<string>();
  if (urls.length === 0) return existing; // never emit an empty in.() — it is invalid.

  const headers = {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
  };
  for (const batch of chunk(urls, CHUNK_SIZE)) {
    // Build `in.("url1","url2",...)`: double-quote each value (escaping any " inside)
    // and join with commas, then encode the whole filter value so reserved chars in
    // the URLs travel safely over the query string.
    const list = batch.map((u) => `"${u.replace(/"/g, '\\"')}"`).join(",");
    const filter = encodeURIComponent(`in.(${list})`);
    const url =
      `${config.supabaseUrl}/rest/v1/workflow_document_extractions` +
      `?select=source_url&source_url=${filter}`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`nfse_list_new: existing read HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<{ source_url?: string }>;
    for (const r of rows) {
      if (typeof r.source_url === "string") existing.add(r.source_url);
    }
  }
  return existing;
}

export async function nfse_list_new(args: NfseListNewArgs = {}): Promise<NfseListNewResult> {
  assertSupabaseConfig();
  const baseUrl = args.source_api_url ?? config.nfseSourceApiUrl;

  // Fetch the (small) source list first; dedup is then a bounded membership read
  // over exactly those content_urls (no full-table scan).
  const all = await fetchSourceInvoices(baseUrl);
  const existing = await fetchExistingSourceUrls(all.map((inv) => inv.content_url));

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

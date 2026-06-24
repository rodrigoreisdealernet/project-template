// Mock NFS-e source API (POC).
//
// Stands in for the production "new invoices" API. Lists and serves the sample
// NFS-e PDFs mounted at INVOICES_DIR. The nfse-ingest Temporal workflow polls
// GET /invoices, then fetches GET /invoices/:id/content per invoice. Swapping
// this for the real API in production means changing NFSE_SOURCE_API_URL only.
//
// Dedup ("new vs already processed") is decided by the workflow against the DB
// (Supabase), not here — this service is stateless and returns the full list.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const PORT = Number(process.env.PORT ?? 8090);
const INVOICES_DIR = process.env.INVOICES_DIR ?? "/app/invoices";
// The base URL other services use to fetch invoice content. On the compose
// network the worker reaches this service by its service name.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://mock-nfse-api:${PORT}`).replace(
  /\/$/,
  ""
);

const app = new Hono();

/** id = the PDF filename (URL-encoded in links, decoded from the route param). */
async function listPdfFiles() {
  const entries = await readdir(INVOICES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"))
    .map((e) => e.name)
    .sort();
}

app.get("/health", (c) => c.json({ status: "ok", invoices_dir: INVOICES_DIR }));

app.get("/invoices", async (c) => {
  const files = await listPdfFiles();
  const invoices = files.map((filename) => ({
    id: filename,
    filename,
    content_url: `${PUBLIC_BASE_URL}/invoices/${encodeURIComponent(filename)}/content`,
  }));
  return c.json({ invoices, count: invoices.length });
});

app.get("/invoices/:id/content", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  // Guard against path traversal: only allow exact filenames from the dir.
  const files = await listPdfFiles();
  if (!files.includes(id)) {
    return c.json({ error: `invoice not found: ${id}` }, 404);
  }
  const bytes = await readFile(join(INVOICES_DIR, id));
  return c.body(bytes, 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${id}"`,
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  process.stdout.write(`mock-nfse-api listening on :${info.port} (invoices: ${INVOICES_DIR})\n`);
});

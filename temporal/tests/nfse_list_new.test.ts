import { nfse_list_new } from "../src/activities/nfse_list_new";

// Validates the dedup logic (BR-1/BR-6): list all invoices from the source API,
// then return only those whose content_url is not already in the DB.

const SOURCE = "http://mock-nfse-api:8090";

const INVOICES = [
  { id: "a.pdf", filename: "a.pdf", content_url: `${SOURCE}/invoices/a.pdf/content` },
  { id: "b.pdf", filename: "b.pdf", content_url: `${SOURCE}/invoices/b.pdf/content` },
  { id: "c.pdf", filename: "c.pdf", content_url: `${SOURCE}/invoices/c.pdf/content` },
];

describe("nfse_list_new", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.NFSE_SOURCE_API_URL = SOURCE;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns only invoices not already extracted", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        // 'a.pdf' already processed
        return new Response(JSON.stringify([{ source_url: INVOICES[0].content_url }]), {
          status: 200,
        });
      }
      // source API list
      return new Response(JSON.stringify({ invoices: INVOICES }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});

    expect(result.total).toBe(3);
    expect(result.new_count).toBe(2);
    expect(result.skipped_count).toBe(1);
    expect(result.invoices.map((i) => i.id)).toEqual(["b.pdf", "c.pdf"]);
    expect(typeof result.run_at).toBe("string");
  });

  it("returns all invoices when none are processed yet", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ invoices: INVOICES }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});
    expect(result.new_count).toBe(3);
    expect(result.skipped_count).toBe(0);
  });

  it("reads existing source_urls via a bounded membership query (source_url=in.)", async () => {
    const requested: string[] = [];
    global.fetch = (async (url: string) => {
      const u = String(url);
      requested.push(u);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ invoices: INVOICES }), { status: 200 });
    }) as unknown as typeof fetch;

    await nfse_list_new({});

    const dbReads = requested.filter((u) =>
      u.includes("/rest/v1/workflow_document_extractions"),
    );
    expect(dbReads.length).toBeGreaterThan(0);
    // Bounded membership read, not an unfiltered/limit-offset full-table scan.
    for (const u of dbReads) {
      expect(u).toContain("source_url=in.");
      expect(u).not.toContain("limit=");
      expect(u).not.toContain("offset=");
    }
  });

  it("skips the DB read entirely when the source returns zero invoices", async () => {
    const requested: string[] = [];
    global.fetch = (async (url: string) => {
      const u = String(url);
      requested.push(u);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ invoices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});

    expect(result.new_count).toBe(0);
    expect(result.total).toBe(0);
    expect(
      requested.some((u) => u.includes("/rest/v1/workflow_document_extractions")),
    ).toBe(false);
  });

  // ── Error paths ───────────────────────────────────────────────────────────
  // The activity runs on a 15s cadence against an external source API and the
  // DB. Failures must surface as thrown errors (so Temporal retries) rather than
  // silently returning a wrong/empty list that would skip real invoices.

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing (never calls out)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    let called = false;
    global.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(nfse_list_new({})).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY is required/);
    // Config is asserted before any network call — no source/DB request is made.
    expect(called).toBe(false);
  });

  it("throws when the source API returns a non-2xx status", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/rest/v1/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("upstream down", { status: 502 });
    }) as unknown as typeof fetch;

    await expect(nfse_list_new({})).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the source API returns non-JSON", async () => {
    global.fetch = (async (url: string) => {
      if (String(url).includes("/rest/v1/")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("<html>not json</html>", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(nfse_list_new({})).rejects.toThrow(/non-JSON/);
  });

  it("throws when the existing-extractions DB read fails", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response("permission denied", { status: 403 });
      }
      return new Response(JSON.stringify({ invoices: INVOICES }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(nfse_list_new({})).rejects.toThrow(/existing read HTTP 403/);
  });

  it("ignores malformed source rows (missing/empty content_url) without throwing", async () => {
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          invoices: [
            INVOICES[0],
            { id: "no-url", filename: "no-url.pdf" }, // missing content_url
            { id: "empty", filename: "empty.pdf", content_url: "" }, // empty content_url
            { id: "num", filename: "num.pdf", content_url: 12345 }, // non-string
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});
    // Only the one well-formed invoice survives the filter.
    expect(result.total).toBe(1);
    expect(result.invoices.map((i) => i.id)).toEqual(["a.pdf"]);
  });

  // Regression (red-team #1): an embedded double-quote in a content_url must be
  // escaped the PostgREST way — doubled ("") — not backslash-escaped. Getting this
  // wrong makes the membership filter misparse, re-processing or silently dropping
  // the invoice.
  it("escapes embedded double-quotes in content_url the PostgREST way (doubled, not backslash)", async () => {
    const quoted = `${SOURCE}/invoices/a".pdf/content`;
    const dbReads: string[] = [];
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        dbReads.push(u);
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify({ invoices: [{ id: "q", filename: "q.pdf", content_url: quoted }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await nfse_list_new({});

    expect(dbReads).toHaveLength(1);
    const encodedFilter = dbReads[0].split("&source_url=")[1];
    const decoded = decodeURIComponent(encodedFilter);
    expect(decoded).toContain('a"".pdf'); // doubled quote (CSV-style)
    expect(decoded).not.toContain('a\\".pdf'); // NOT backslash-escaped
  });

  // Regression (red-team #5): the source API may list the same content_url twice
  // in one batch. Dedup must collapse it to one so we don't pay for two model
  // calls / write the row twice.
  it("de-duplicates identical content_urls within a single source batch", async () => {
    const dup = { id: "x", filename: "x.pdf", content_url: `${SOURCE}/invoices/x.pdf/content` };
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ invoices: [dup, { ...dup }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});

    expect(result.total).toBe(1);
    expect(result.new_count).toBe(1);
    expect(result.invoices).toHaveLength(1);
  });

  it("chunks the membership read so the request URL stays bounded for large source lists", async () => {
    // 250 invoices -> with CHUNK_SIZE=100 the activity must issue 3 DB reads.
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `inv-${i}.pdf`,
      filename: `inv-${i}.pdf`,
      content_url: `${SOURCE}/invoices/inv-${i}.pdf/content`,
    }));
    const dbReads: string[] = [];
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/rest/v1/workflow_document_extractions")) {
        dbReads.push(u);
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ invoices: many }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await nfse_list_new({});

    expect(result.total).toBe(250);
    expect(result.new_count).toBe(250);
    expect(dbReads).toHaveLength(3); // ceil(250 / 100)
    // Each chunk request encodes a membership filter (no full-table scan).
    for (const u of dbReads) expect(u).toContain("source_url=in.");
  });
});

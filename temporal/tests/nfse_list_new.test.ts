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
});

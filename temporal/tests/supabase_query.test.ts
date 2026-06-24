describe("supabase_mutate", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("upserts a row through PostgREST and returns the representation row", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "row-1", domain: "stripe.com", confidence: 0.99 }],
    });
    global.fetch = fetchMock as typeof fetch;

    const { supabase_mutate } = await import("../src/activities/supabase_query");
    const row = await supabase_mutate({
      operation: "upsert",
      table: "workflow_classifications",
      match: { domain: "stripe.com" },
      values: { name: "Stripe", confidence: 0.99 },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/workflow_classifications?on_conflict=domain",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
        body: JSON.stringify({
          domain: "stripe.com",
          name: "Stripe",
          confidence: 0.99,
        }),
      })
    );
    expect(row).toEqual({ id: "row-1", domain: "stripe.com", confidence: 0.99 });
  });

  it("upserts an NFS-e extraction on source_url (dedup contract for workflow_document_extractions)", async () => {
    // This is the exact mutation the nfse-ingest workflow performs. It is the
    // write-side half of dedup: re-running over the same invoice must update the
    // existing row (on_conflict=source_url + merge-duplicates), never insert a
    // duplicate. Covered here because the orchestration test stubs supabase_mutate.
    const persisted = {
      id: "ext-1",
      source_url: "http://mock-nfse-api:8090/invoices/402/content",
      confidence: 0.95,
    };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [persisted] });
    global.fetch = fetchMock as typeof fetch;

    const { supabase_mutate } = await import("../src/activities/supabase_query");
    const row = await supabase_mutate({
      operation: "upsert",
      table: "workflow_document_extractions",
      match: { source_url: persisted.source_url },
      values: {
        source_url: persisted.source_url,
        extracted_fields: { numero_nota: "402", valor_total: 245.05 },
        confidence: 0.95,
        extracted_at: "2026-06-24T10:00:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/workflow_document_extractions?on_conflict=source_url",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Prefer: "resolution=merge-duplicates,return=representation",
        }),
      })
    );
    // The match key is merged into the body and the values are carried verbatim.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      source_url: persisted.source_url,
      confidence: 0.95,
      extracted_at: "2026-06-24T10:00:00.000Z",
      extracted_fields: { numero_nota: "402", valor_total: 245.05 },
    });
    expect(row).toEqual(persisted);
  });

  it("rejects an upsert with an empty match (would lose dedup and insert duplicates)", async () => {
    const { supabase_mutate } = await import("../src/activities/supabase_query");
    await expect(
      supabase_mutate({
        operation: "upsert",
        table: "workflow_document_extractions",
        match: {},
        values: { source_url: "x", confidence: 0.5 },
      })
    ).rejects.toThrow(/requires at least one match key/);
  });

  it("rejects update mutations without a match filter", async () => {
    const { supabase_mutate } = await import("../src/activities/supabase_query");

    await expect(
      supabase_mutate({
        operation: "update",
        table: "workflow_classifications",
        values: { confidence: 0.5 },
      })
    ).rejects.toThrow("requires a non-empty match filter");
  });

  it("upserts entity state through the core entity model", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "entity-1", entity_type: "content_submission", source_record_id: "submission-1" },
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "version-1", version_number: 1 }],
      });
    global.fetch = fetchMock as typeof fetch;

    const { supabase_mutate } = await import("../src/activities/supabase_query");
    const result = await supabase_mutate({
      operation: "upsert",
      entity_type: "content_submission",
      source_record_id: "submission-1",
      data: {
        decision_status: "approved",
        policy_version: "2026-06-21",
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:54321/rest/v1/entities?select=id%2Centity_type%2Csource_record_id&entity_type=eq.content_submission&source_record_id=eq.submission-1&limit=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Prefer: "return=representation" }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:54321/rest/v1/entities",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          entity_type: "content_submission",
          source_record_id: "submission-1",
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:54321/rest/v1/entity_versions?select=version_number&entity_id=eq.entity-1&order=version_number.desc&limit=1",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:54321/rest/v1/entity_versions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          entity_id: "entity-1",
          version_number: 1,
          data: {
            decision_status: "approved",
            policy_version: "2026-06-21",
          },
        }),
      })
    );
    expect(result).toEqual({
      entity_id: "entity-1",
      version_id: "version-1",
      version_number: 1,
      success: true,
    });
  });

  it("reuses an existing entity and appends a new version", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "entity-1", entity_type: "content_submission", source_record_id: "submission-1" },
        ],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ version_number: 2 }] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "version-3", version_number: 3 }],
      });
    global.fetch = fetchMock as typeof fetch;

    const { supabase_mutate } = await import("../src/activities/supabase_query");
    const result = await supabase_mutate({
      operation: "upsert",
      entity_type: "content_submission",
      source_record_id: "submission-1",
      data: { decision_status: "rejected" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:54321/rest/v1/entity_versions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          entity_id: "entity-1",
          version_number: 3,
          data: { decision_status: "rejected" },
        }),
      })
    );
    expect(result).toEqual({
      entity_id: "entity-1",
      version_id: "version-3",
      version_number: 3,
      success: true,
    });
  });

  it("rejects entity updates when no lookup key is provided", async () => {
    global.fetch = jest.fn() as typeof fetch;

    const { supabase_mutate } = await import("../src/activities/supabase_query");

    await expect(
      supabase_mutate({
        operation: "update",
        entity_type: "content_submission",
        data: { decision_status: "approved" },
      })
    ).rejects.toThrow("requires an existing entity_id or source_record_id");
  });
});

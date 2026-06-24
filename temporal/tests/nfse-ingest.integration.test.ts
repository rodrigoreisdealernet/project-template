import * as fs from "node:fs";
import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import type { DSLInput } from "../src/workflows/dsl/interpreter";

// Integration test for the nfse-ingest workflow ORCHESTRATION (not the individual
// activities). It runs the real DSL interpreter in a local Temporal test env with
// every activity stubbed, so we exercise the control flow the definition encodes:
//   list new -> for_each(invoice) -> try_catch { file_extract -> llm_agent ->
//                                                 if !content_filter_blocked: supabase_mutate }
//
// This is the layer the unit tests cannot reach: sequencing, the per-invoice
// try_catch (one bad invoice must not sink the batch), and the persistence guard
// on content_filter_blocked.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SOURCE = "http://mock-nfse-api:8090";

function invoiceRef(id: string) {
  return { id, filename: id, content_url: `${SOURCE}/invoices/${id}/content` };
}

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    parsed: {
      numero_nota: "402",
      prestador_razao_social: "Prestador LTDA",
      tomador_razao_social: "Tomador SA",
      valor_total: 245.05,
      confidence: 0.95,
    },
    content_filter_blocked: false,
    prompt_tokens: 100,
    completion_tokens: 40,
    ...overrides,
  };
}

// A recorder so assertions can see exactly which activities ran, with what args.
interface Recorder {
  fileExtractUrls: string[];
  llmCalls: number;
  llmArgs: Array<Record<string, unknown>>;
  mutates: Array<Record<string, unknown>>;
}

function makeActivities(
  rec: Recorder,
  opts: {
    invoices: ReturnType<typeof invoiceRef>[];
    runAt?: string;
    // Per-invoice id -> behavior. Default: succeed with high confidence.
    extractionFor?: (inv: ReturnType<typeof invoiceRef>) => Record<string, unknown>;
    fileExtractThrowsFor?: (inv: ReturnType<typeof invoiceRef>) => boolean;
  }
) {
  const runAt = opts.runAt ?? "2026-06-24T10:00:00.000Z";
  return {
    nfse_list_new: async () => ({
      invoices: opts.invoices,
      run_at: runAt,
      total: opts.invoices.length,
      new_count: opts.invoices.length,
      skipped_count: 0,
    }),

    file_extract: async (...a: unknown[]) => {
      const args = (a[0] ?? {}) as { url?: string };
      const url = String(args.url ?? "");
      rec.fileExtractUrls.push(url);
      const inv = opts.invoices.find((i) => i.content_url === url);
      if (inv && opts.fileExtractThrowsFor?.(inv)) {
        throw new Error(`file_extract: simulated download failure for ${inv.id}`);
      }
      return { text: `NFS-e ${inv?.id ?? "?"}`, pages: 1 };
    },

    llm_agent: async (...a: unknown[]) => {
      rec.llmCalls += 1;
      // Recover which invoice this is from the interpolated prompt text.
      const args = (a[0] ?? {}) as { user_prompt?: string };
      rec.llmArgs.push(args as Record<string, unknown>);
      const promptText = String(args.user_prompt ?? "");
      const inv = opts.invoices.find((i) => promptText.includes(i.id));
      return opts.extractionFor ? opts.extractionFor(inv ?? opts.invoices[0]) : extraction();
    },

    supabase_mutate: async (...a: unknown[]) => {
      const args = (a[0] ?? {}) as Record<string, unknown>;
      rec.mutates.push(args);
      const values = (args.values ?? {}) as Record<string, unknown>;
      return { id: rec.mutates.length, source_url: values.source_url };
    },

    // Execution-tracking activities — no-ops so the interpreter's bookkeeping
    // does not log "not registered" noise and does not affect assertions.
    record_step: async () => undefined as string | undefined,
    complete_execution: async () => undefined,
  };
}

// ── Test harness ────────────────────────────────────────────────────────────────

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger("WARN") });
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
}, 30_000);

function loadDefinition(): Record<string, unknown> {
  const definitionPath = path.resolve(__dirname, "../definitions/nfse-ingest.json");
  return JSON.parse(fs.readFileSync(definitionPath, "utf8")) as Record<string, unknown>;
}

async function runWithWorker(
  activities: Record<string, (...a: unknown[]) => unknown>,
  run: (env: TestWorkflowEnvironment) => Promise<void>
): Promise<void> {
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    namespace: "default",
    taskQueue: "nfse-ingest-test",
    workflowsPath: require.resolve("../src/workflows"),
    activities,
  });
  const workerHandle = worker.run();
  try {
    await run(testEnv);
  } finally {
    await worker.shutdown();
    await workerHandle;
  }
}

function execute(env: TestWorkflowEnvironment, id: string): Promise<Record<string, unknown>> {
  const dslInput: DSLInput = { definition: loadDefinition(), input: {} };
  return env.client.workflow.execute("DSLWorkflow", {
    args: [dslInput],
    taskQueue: "nfse-ingest-test",
    workflowId: id,
  }) as Promise<Record<string, unknown>>;
}

// ── Happy path: every new invoice is extracted and persisted ───────────────────

describe("nfse-ingest — happy path", () => {
  it("extracts and persists every new invoice in order", async () => {
    const rec: Recorder = { fileExtractUrls: [], llmCalls: 0, llmArgs: [], mutates: [] };
    const invoices = [invoiceRef("402"), invoiceRef("14521")];

    await runWithWorker(makeActivities(rec, { invoices }), async (env) => {
      await execute(env, `nfse-happy-${Date.now()}`);
    });

    // One file_extract + one llm_agent + one persist per invoice.
    expect(rec.fileExtractUrls).toEqual(invoices.map((i) => i.content_url));
    expect(rec.llmCalls).toBe(2);
    expect(rec.mutates).toHaveLength(2);

    // The model call carries the extraction contract from the definition: the
    // Azure model, deterministic temperature, the named schema, and the document
    // text interpolated from the file_extract result.
    const llm = rec.llmArgs[0];
    expect(llm.model_id).toBe("gpt-5.4");
    expect(llm.temperature).toBe(0);
    expect(llm.schema_name).toBe("nfse_extraction");
    expect(String(llm.user_prompt)).toContain("NFS-e 402");

    // The persisted row carries the dedup key, the parsed fields, the confidence,
    // and the run-time stamp from the listing step — exactly what the screen reads.
    const first = rec.mutates[0];
    expect(first.operation).toBe("upsert");
    expect(first.table).toBe("workflow_document_extractions");
    const values = first.values as Record<string, unknown>;
    expect(values.source_url).toBe(invoices[0].content_url);
    expect(values.confidence).toBe(0.95);
    expect(values.extracted_at).toBe("2026-06-24T10:00:00.000Z");
    expect((values.extracted_fields as Record<string, unknown>).numero_nota).toBe("402");
  }, 30_000);
});

// ── Persistence guard: blocked extractions are never written ───────────────────

describe("nfse-ingest — content filter guard", () => {
  it("does NOT persist an invoice whose extraction was content-filter blocked", async () => {
    const rec: Recorder = { fileExtractUrls: [], llmCalls: 0, llmArgs: [], mutates: [] };
    const invoices = [invoiceRef("good"), invoiceRef("blocked")];

    await runWithWorker(
      makeActivities(rec, {
        invoices,
        extractionFor: (inv) =>
          inv.id === "blocked"
            ? extraction({ content_filter_blocked: true, parsed: null })
            : extraction(),
      }),
      async (env) => {
        await execute(env, `nfse-blocked-${Date.now()}`);
      }
    );

    // Both invoices reach the model, but only the unblocked one is persisted.
    expect(rec.llmCalls).toBe(2);
    expect(rec.mutates).toHaveLength(1);
    expect((rec.mutates[0].values as Record<string, unknown>).source_url).toBe(
      invoices[0].content_url
    );
  }, 30_000);
});

// ── Resilience: one failing invoice must not sink the batch ────────────────────

describe("nfse-ingest — per-invoice try_catch", () => {
  it("continues the batch when one invoice's file_extract throws", async () => {
    const rec: Recorder = { fileExtractUrls: [], llmCalls: 0, llmArgs: [], mutates: [] };
    const invoices = [invoiceRef("boom"), invoiceRef("ok")];

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      runWithWorker(
        makeActivities(rec, {
          invoices,
          fileExtractThrowsFor: (inv) => inv.id === "boom",
        }),
        async (env) => {
          resolve(await execute(env, `nfse-trycatch-${Date.now()}`));
        }
      ).catch(reject);
    });

    // The failing invoice never reached the model or the DB; the healthy one did.
    expect(rec.llmCalls).toBe(1);
    expect(rec.mutates).toHaveLength(1);
    expect((rec.mutates[0].values as Record<string, unknown>).source_url).toBe(
      invoices[1].content_url
    );
    // The workflow caught a real activity failure rather than failing the run.
    // Temporal wraps the thrown message ("...boom...") as an ActivityFailure, so
    // last_error surfaces as "Activity task failed" — we assert it captured an
    // actual failure (truthy, failure-shaped), not undefined or a stale value.
    expect(result.last_error).toBeDefined();
    expect(String(JSON.stringify(result.last_error))).toMatch(/fail/i);
  }, 30_000);
});

// ── Empty listing: nothing to do is a clean no-op ──────────────────────────────

describe("nfse-ingest — empty listing", () => {
  it("makes no extraction or persistence calls when there are no new invoices", async () => {
    const rec: Recorder = { fileExtractUrls: [], llmCalls: 0, llmArgs: [], mutates: [] };

    await runWithWorker(makeActivities(rec, { invoices: [] }), async (env) => {
      await execute(env, `nfse-empty-${Date.now()}`);
    });

    expect(rec.fileExtractUrls).toHaveLength(0);
    expect(rec.llmCalls).toBe(0);
    expect(rec.mutates).toHaveLength(0);
  }, 30_000);
});

// ── Low confidence still persists (review happens in the UI, not the workflow) ──

describe("nfse-ingest — low confidence", () => {
  it("persists a low-confidence extraction so the UI can flag it for review", async () => {
    const rec: Recorder = { fileExtractUrls: [], llmCalls: 0, llmArgs: [], mutates: [] };
    const invoices = [invoiceRef("lowconf")];

    await runWithWorker(
      makeActivities(rec, {
        invoices,
        extractionFor: () =>
          extraction({
            parsed: {
              numero_nota: "999",
              prestador_razao_social: "P",
              tomador_razao_social: "T",
              valor_total: 10,
              confidence: 0.42,
            },
          }),
      }),
      async (env) => {
        await execute(env, `nfse-lowconf-${Date.now()}`);
      }
    );

    expect(rec.mutates).toHaveLength(1);
    expect((rec.mutates[0].values as Record<string, unknown>).confidence).toBe(0.42);
  }, 30_000);
});

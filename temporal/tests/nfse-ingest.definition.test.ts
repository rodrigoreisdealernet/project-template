import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDefinition } from "../src/workflows/dsl/schema";

const def = JSON.parse(
  readFileSync(join(__dirname, "..", "definitions", "nfse-ingest.json"), "utf8")
) as Record<string, unknown>;

// ── Structural navigation helpers ───────────────────────────────────────────
// Assert on the parsed control-flow tree (not substring presence) so the tests
// fail if a value moves into a comment, the wrong step, or a dead branch.

/* eslint-disable @typescript-eslint/no-explicit-any */
const topSteps = (def as any).steps.sequence.steps as any[];
const forEachBody = topSteps[1].for_each.body.try_catch.try.sequence.steps as any[];
const llmStep = forEachBody[1].activity;
const persistCondition = forEachBody[2].condition;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("nfse-ingest definition", () => {
  it("is a structurally valid DSL definition", () => {
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it("is named nfse-ingest with a semver version", () => {
    expect(def.name).toBe("nfse-ingest");
    expect(String(def.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs nfse_list_new as the first step, before the per-invoice model call", () => {
    // Structural: the dedup/list activity is the FIRST top-level step, and the
    // model call lives inside the subsequent for_each body — not merely earlier
    // in the serialized text.
    expect(topSteps[0].activity.name).toBe("nfse_list_new");
    expect(topSteps[1].for_each).toBeDefined();
    expect(llmStep.name).toBe("llm_agent");
  });

  it("calls Azure gpt-5.4 via the llm_agent step with the nfse_extraction schema", () => {
    expect(llmStep.args.provider).toBe("azure-openai-responses");
    expect(llmStep.args.model_id).toBe("gpt-5.4");
    expect(llmStep.args.temperature).toBe(0);
    expect(llmStep.args.schema_name).toBe("nfse_extraction");
    // Required fields the UI and dedup depend on are all in the response schema.
    expect(llmStep.args.response_schema.required).toEqual(
      expect.arrayContaining([
        "numero_nota",
        "prestador_razao_social",
        "tomador_razao_social",
        "valor_total",
        "confidence",
      ])
    );
  });

  it("persists via an upsert into workflow_document_extractions keyed on source_url", () => {
    const mutate = persistCondition.then.activity;
    expect(mutate.name).toBe("supabase_mutate");
    expect(mutate.args.operation).toBe("upsert");
    expect(mutate.args.table).toBe("workflow_document_extractions");
    expect(mutate.args.match).toEqual({ source_url: "$var.inv.content_url" });
    // Provenance: extracted_at comes from the listing step's run_at.
    expect(mutate.args.values.extracted_at).toBe("$var.listing.run_at");
    // Guard against regressing to the wrong (non-existent) table name.
    expect(JSON.stringify(def)).not.toContain('"table": "document_extractions"');
  });

  it("guards persistence on content_filter_blocked == false (wraps the mutate step)", () => {
    // The guard must wrap the supabase_mutate step — not just appear somewhere.
    expect(persistCondition.if).toBe("$var.extraction.content_filter_blocked == false");
    expect(persistCondition.then.activity.name).toBe("supabase_mutate");
  });

  it("seed migration JSON matches the definition file (no drift)", () => {
    const seedSql = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "supabase",
        "migrations",
        "20260624160000_seed_nfse_ingest_definition.sql"
      ),
      "utf8"
    );
    // Extract the JSONB literal embedded between the first `$$` and `$$::jsonb`.
    const start = seedSql.indexOf("$$");
    const end = seedSql.indexOf("$$::jsonb");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const seedJson = seedSql.slice(start + 2, end);
    const seedDef = JSON.parse(seedJson) as Record<string, unknown>;
    expect(seedDef).toEqual(def);
  });

  it("schedule bootstrap derives the definition from the file (no embedded copy)", () => {
    const bootstrap = readFileSync(
      join(__dirname, "..", "..", "scripts", "bootstrap-nfse-schedule.ts"),
      "utf8"
    );
    // Reads the canonical definition from the .json file...
    expect(bootstrap).toContain("nfse-ingest.json");
    // ...and does NOT embed its own copy of the workflow literal.
    expect(bootstrap).not.toContain('"steps"');
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDefinition } from "../src/workflows/dsl/schema";

const def = JSON.parse(
  readFileSync(join(__dirname, "..", "definitions", "nfse-ingest.json"), "utf8")
) as Record<string, unknown>;

describe("nfse-ingest definition", () => {
  it("is a structurally valid DSL definition", () => {
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it("is named nfse-ingest with a semver version", () => {
    expect(def.name).toBe("nfse-ingest");
    expect(String(def.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists new invoices via the nfse_list_new activity (dedup before model call)", () => {
    const json = JSON.stringify(def);
    expect(json).toContain('"nfse_list_new"');
    // dedup/list step comes before file_extract + llm_agent
    expect(json.indexOf("nfse_list_new")).toBeLessThan(json.indexOf("llm_agent"));
  });

  it("calls Azure gpt-5.4 for extraction", () => {
    const json = JSON.stringify(def);
    expect(json).toContain('"azure-openai-responses"');
    expect(json).toContain('"gpt-5.4"');
  });

  it("persists to the real table workflow_document_extractions (not document_extractions)", () => {
    const json = JSON.stringify(def);
    expect(json).toContain('"workflow_document_extractions"');
    expect(json).not.toContain('"table": "document_extractions"');
  });

  it("guards persistence on content_filter_blocked == false", () => {
    expect(JSON.stringify(def)).toContain("content_filter_blocked == false");
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

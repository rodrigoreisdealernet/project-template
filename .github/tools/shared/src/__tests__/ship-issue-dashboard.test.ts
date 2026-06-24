import { describe, expect, it } from "vitest";
// The renderer is a dependency-free Node script shared with CI; import it directly.
import {
  STEP_DEFS,
  assertValidRun,
  createRun,
  isActive,
  overallStatus,
  renderShipIssueDashboard,
  setMeta,
  setStep,
} from "../../../../scripts/ship-issue-dashboard.mjs";

const T0 = "2026-06-24T10:00:00.000Z";
const T1 = "2026-06-24T10:00:30.000Z";

function newRun() {
  return createRun({ issue: 25, title: "NFS-e issue date", slug: "nfse-data", branch: "feature/25-nfse-data", now: T0 });
}

describe("createRun", () => {
  it("seeds one pending step per definition", () => {
    const run = newRun();
    expect(run.steps).toHaveLength(STEP_DEFS.length);
    expect(run.steps.every((s) => s.status === "pending")).toBe(true);
    expect(run.issue).toEqual({ number: 25, title: "NFS-e issue date", url: null });
    expect(run.startedAt).toBe(T0);
  });

  it("rejects a non-positive issue number", () => {
    expect(() => createRun({ issue: 0, slug: "x" })).toThrow(/positive integer/);
    expect(() => createRun({ issue: 5 })).toThrow(/slug/);
  });
});

describe("setStep", () => {
  it("stamps startedAt on running and finishedAt on done, without mutating the input", () => {
    const run = newRun();
    const running = setStep(run, "code", { status: "running", now: T0 });
    expect(running.steps.find((s) => s.id === "code")?.startedAt).toBe(T0);
    expect(run.steps.find((s) => s.id === "code")?.status).toBe("pending"); // input untouched

    const done = setStep(running, "code", { status: "done", now: T1 });
    const code = done.steps.find((s) => s.id === "code");
    expect(code?.status).toBe("done");
    expect(code?.startedAt).toBe(T0);
    expect(code?.finishedAt).toBe(T1);
    expect(done.updatedAt).toBe(T1);
  });

  it("appends notes and de-duplicates artifacts", () => {
    let run = newRun();
    run = setStep(run, "spec", { note: "first" });
    run = setStep(run, "spec", { note: "second", artifacts: [{ label: "Spec", href: "docs/specs/25.md" }] });
    run = setStep(run, "spec", { artifacts: [{ label: "Spec", href: "docs/specs/25.md" }] }); // dupe
    const spec = run.steps.find((s) => s.id === "spec");
    expect(spec?.notes).toEqual(["first", "second"]);
    expect(spec?.artifacts).toHaveLength(1);
  });

  it("rejects unknown steps and invalid statuses", () => {
    const run = newRun();
    expect(() => setStep(run, "nope", { status: "done" })).toThrow(/unknown step/);
    expect(() => setStep(run, "code", { status: "bogus" })).toThrow(/invalid status/);
  });
});

describe("overallStatus / isActive", () => {
  it("follows failed > waiting > running > complete precedence", () => {
    let run = newRun();
    expect(overallStatus(run)).toBe("pending");
    run = setStep(run, "spec", { status: "running" });
    expect(overallStatus(run)).toBe("running");
    run = setStep(run, "approve", { status: "waiting" });
    expect(overallStatus(run)).toBe("waiting");
    expect(isActive(run)).toBe(true);

    let complete = newRun();
    for (const def of STEP_DEFS) complete = setStep(complete, def.id, { status: "done" });
    expect(overallStatus(complete)).toBe("complete");
    expect(isActive(complete)).toBe(false);

    const failed = setStep(complete, "tests", { status: "failed" });
    expect(overallStatus(failed)).toBe("failed");
  });
});

describe("renderShipIssueDashboard", () => {
  it("produces a self-contained page with inline styles and no external/script assets", () => {
    const html = renderShipIssueDashboard(newRun());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/i); // no external assets
    for (const def of STEP_DEFS) expect(html).toContain(def.name);
  });

  it("escapes HTML in the issue title to prevent injection", () => {
    const run = createRun({ issue: 7, title: "<img src=x onerror=alert(1)>", slug: "x", now: T0 });
    const html = renderShipIssueDashboard(run);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("auto-refreshes while active and stops once complete", () => {
    const active = renderShipIssueDashboard(setStep(newRun(), "spec", { status: "running" }));
    expect(active).toContain('http-equiv="refresh"');

    let complete = newRun();
    for (const def of STEP_DEFS) complete = setStep(complete, def.id, { status: "done" });
    expect(renderShipIssueDashboard(complete)).not.toContain('http-equiv="refresh"');
  });

  it("shows a live activity banner with the running step's latest note", () => {
    let run = setStep(newRun(), "code", { status: "running" });
    run = setStep(run, "code", { note: "writing formatDateBR helper" });
    const html = renderShipIssueDashboard(run);
    expect(html).toContain("Running");
    expect(html).toContain("Code");
    expect(html).toContain("writing formatDateBR helper");
    expect(html).toContain("pulse");
    // no live banner once nothing is running
    let complete = newRun();
    for (const def of STEP_DEFS) complete = setStep(complete, def.id, { status: "done" });
    expect(renderShipIssueDashboard(complete)).not.toContain('class="pulse"');
  });

  it("renders the human-gate banners", () => {
    const specGate = setMeta(setStep(newRun(), "approve", { status: "waiting" }), { gate: "spec-approval" });
    expect(renderShipIssueDashboard(specGate)).toContain("approve the spec");
    const mergeGate = setMeta(newRun(), { gate: "merge" });
    expect(renderShipIssueDashboard(mergeGate)).toContain("read the review and merge");
  });

  it("is deterministic for a given model", () => {
    const run = setStep(newRun(), "code", { status: "done", now: T1 });
    expect(renderShipIssueDashboard(run)).toBe(renderShipIssueDashboard(run));
  });
});

describe("assertValidRun", () => {
  it("rejects malformed models", () => {
    expect(() => assertValidRun(null)).toThrow();
    expect(() => assertValidRun({ issue: {}, steps: [] })).toThrow(/issue.number/);
    expect(() => assertValidRun({ issue: { number: 1 }, steps: [{ id: "ghost", status: "done" }] })).toThrow(/unknown step/);
  });
});

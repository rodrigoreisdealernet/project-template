/**
 * Contract tests for the actions-monitor agent baseline-attribution step.
 *
 * ADR-0112 introduced the shared CI baseline-attribution layer to prevent
 * pre-existing `main` failures from generating PR-branch remediation pressure.
 * ADR-0116 aligned the actions-monitor inline jq filter with the SDK tool's
 * BASELINE_FAILING_CONCLUSIONS set (failure, timed_out, startup_failure).
 *
 * These tests lock the contracts so that regressions in the agent prompt
 * surface as test failures before the change reaches the factory pipeline.
 * Trend issue: Volaris-AI/project-template#1033.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../agent-loader.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../");
const AGENTS_PATH = join(REPO_ROOT, ".github", "agents");
const AGENT_PATH = join(AGENTS_PATH, "actions-monitor.agent.md");

describe("actions-monitor agent baseline-attribution contract (ADR-0112, ADR-0116)", () => {
  it("loads with expected metadata", () => {
    const { frontmatter } = loadAgent(AGENTS_PATH, "actions-monitor");
    expect(frontmatter.name).toBe("actions-monitor");
    expect(frontmatter.tools).toEqual(["gh"]);
  });

  it("includes step 2.5 baseline attribution section (ADR-0112)", () => {
    const { body } = loadAgent(AGENTS_PATH, "actions-monitor");
    expect(body).toContain("2.5");
    expect(body).toContain("Baseline attribution");
    expect(body).toContain("default_branch");
  });

  it("jq filter in step 2.5 includes all three BASELINE_FAILING_CONCLUSIONS (ADR-0116)", () => {
    // The jq filter must match BASELINE_FAILING_CONCLUSIONS in factory-tools.ts:
    // failure, timed_out, startup_failure.
    // If any conclusion is missing here, the monitor will misclassify PR-branch
    // failures that have the same conclusion on main as pr_introduced, spawning
    // unwarranted incidents and Copilot code-fix nudges.
    const content = readFileSync(AGENT_PATH, "utf8");
    expect(content).toContain('.conclusion == "failure"');
    expect(content).toContain('.conclusion == "timed_out"');
    expect(content).toContain('.conclusion == "startup_failure"');
  });

  it("routes pre-existing baseline failures to ci-baseline-<workflow-slug> incidents, not PR-branch incidents", () => {
    const { body } = loadAgent(AGENTS_PATH, "actions-monitor");
    // Fingerprint convention for baseline main failures
    expect(body).toContain("ci-baseline-");
    // Title prefix for attribution clarity
    expect(body).toContain("[CI baseline]");
    // Explicit instruction not to open a new PR-branch incident (markdown bold: "Do **not** open")
    expect(body).toContain("not** open");
    // The update-over-create deduplication rule
    expect(body).toContain("update");
  });

  it("routes action_required gates to ci-action-required-gate, not as code failures (ADR-0112)", () => {
    const { body } = loadAgent(AGENTS_PATH, "actions-monitor");
    // action_required must be tracked under its own fingerprint
    expect(body).toContain("ci-action-required-gate");
    // Must NOT attempt gh run rerun for action_required (that causes a busy-loop)
    expect(body).toContain("do NOT");
    expect(body).toContain("action_required");
  });

  it("does NOT open issues for flake/cancelled runs — notes them in summary only", () => {
    const { body } = loadAgent(AGENTS_PATH, "actions-monitor");
    // Cancelled runs are a concurrency/rapid-push artifact, not code failures
    expect(body).toContain("do not open an issue");
    expect(body).toMatch(/[Ff]lake\/cancelled/);
  });

  it("mandates baseline attribution check BEFORE attributing a failure to a PR branch", () => {
    const { body } = loadAgent(AGENTS_PATH, "actions-monitor");
    expect(body).toContain("Baseline attribution first");
  });
});

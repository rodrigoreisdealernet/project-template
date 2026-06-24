// ship-issue-dashboard — status page for the /ship-issue pipeline.
//
// Renders a single self-contained HTML file (inline CSS, no external assets)
// that lets a dev/architect follow a /ship-issue run step by step in real time.
// The orchestrator owns a JSON status model and calls this script to mutate it
// and re-render the HTML after every step transition.
//
// Pure, dependency-free (Node built-ins only) so it runs anywhere `node` does
// and stays unit-testable. Matches the `.github/scripts/*-render.mjs` pattern.
//
// CLI:
//   node ship-issue-dashboard.mjs init   <base> --issue <n> --title <t> --slug <s> --branch <b> [--issue-url <u>]
//   node ship-issue-dashboard.mjs set    <base> <stepId> <status> [--summary <s>] [--note <s>] [--artifact label=href ...] [--pr <n>] [--pr-url <u>] [--gate spec-approval|merge|none]
//   node ship-issue-dashboard.mjs render <base>
//
// `<base>` is a path prefix: the model lives at `<base>.json`, the page at `<base>.html`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Canonical pipeline steps — single source of truth, kept in sync with /ship-issue. */
export const STEP_DEFS = [
  { id: "spec", n: "01", name: "Spec", owner: "agent", desc: "Draft a short, testable spec from the issue" },
  { id: "approve", n: "02", name: "Approve spec", owner: "human", desc: "Human approves the spec or sends it back", gate: "spec-approval" },
  { id: "code", n: "03", name: "Code", owner: "agent", desc: "Implement the approved spec" },
  { id: "tests", n: "04", name: "Tests", owner: "agent", desc: "Generate the unit / integration / e2e tests" },
  { id: "test-review", n: "05", name: "Test review", owner: "agent", desc: "Audit tests for gaps & weak assertions" },
  { id: "code-review", n: "06", name: "Code review", owner: "agent", desc: "Review the diff and post on the PR" },
  { id: "merge", n: "07", name: "Merge", owner: "human", desc: "Human reads the review and merges", gate: "merge" },
];

export const STATUSES = ["pending", "running", "done", "waiting", "failed", "skipped"];

const STEP_IDS = new Set(STEP_DEFS.map((s) => s.id));

/**
 * Build a fresh run model with every step pending.
 * @param {{ issue: number, title: string, slug: string, branch?: string, issueUrl?: string, now?: string }} input
 */
export function createRun(input) {
  if (input == null || typeof input !== "object") throw new Error("createRun: input is required");
  const number = Number(input.issue);
  if (!Number.isInteger(number) || number <= 0) throw new Error("createRun: `issue` must be a positive integer");
  if (!input.slug || typeof input.slug !== "string") throw new Error("createRun: `slug` is required");
  const now = input.now ?? new Date().toISOString();
  return {
    issue: { number, title: String(input.title ?? `Issue #${number}`), url: input.issueUrl ?? null },
    slug: input.slug,
    branch: input.branch ?? null,
    pr: null,
    gate: null,
    startedAt: now,
    updatedAt: now,
    steps: STEP_DEFS.map((def) => ({
      id: def.id,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      summary: null,
      notes: [],
      artifacts: [],
    })),
  };
}

/**
 * Return a new model with one step patched. Does not mutate the input.
 * @param {object} model
 * @param {string} stepId
 * @param {{ status?: string, summary?: string, note?: string, artifacts?: Array<{label:string,href:string}>, startedAt?: string, finishedAt?: string, now?: string }} patch
 */
export function setStep(model, stepId, patch = {}) {
  assertValidRun(model);
  if (!STEP_IDS.has(stepId)) throw new Error(`setStep: unknown step "${stepId}"`);
  if (patch.status != null && !STATUSES.includes(patch.status)) {
    throw new Error(`setStep: invalid status "${patch.status}" (expected one of ${STATUSES.join(", ")})`);
  }
  const now = patch.now ?? new Date().toISOString();
  const steps = model.steps.map((step) => {
    if (step.id !== stepId) return step;
    const next = { ...step };
    if (patch.status != null) {
      next.status = patch.status;
      if (patch.status === "running" && !next.startedAt) next.startedAt = patch.startedAt ?? now;
      if ((patch.status === "done" || patch.status === "failed" || patch.status === "skipped") && !next.finishedAt) {
        next.finishedAt = patch.finishedAt ?? now;
      }
    }
    if (patch.startedAt != null) next.startedAt = patch.startedAt;
    if (patch.finishedAt != null) next.finishedAt = patch.finishedAt;
    if (patch.summary != null) next.summary = patch.summary;
    if (patch.note != null) next.notes = [...next.notes, patch.note];
    if (patch.artifacts != null) {
      const seen = new Set(next.artifacts.map((a) => `${a.label}|${a.href}`));
      next.artifacts = [...next.artifacts];
      for (const a of patch.artifacts) {
        const key = `${a.label}|${a.href}`;
        if (!seen.has(key)) {
          next.artifacts.push({ label: String(a.label), href: String(a.href) });
          seen.add(key);
        }
      }
    }
    return next;
  });
  return { ...model, steps, updatedAt: now };
}

/**
 * Patch run-level metadata (PR, gate). Does not mutate the input.
 * @param {object} model
 * @param {{ pr?: {number:number, url?:string} | null, gate?: string | null, now?: string }} patch
 */
export function setMeta(model, patch = {}) {
  assertValidRun(model);
  const now = patch.now ?? new Date().toISOString();
  const next = { ...model, updatedAt: now };
  if ("pr" in patch) next.pr = patch.pr;
  if ("gate" in patch) next.gate = patch.gate;
  return next;
}

/** Throw if the model is structurally invalid. */
export function assertValidRun(model) {
  if (model == null || typeof model !== "object") throw new Error("invalid run model: not an object");
  if (model.issue == null || !Number.isInteger(model.issue.number)) throw new Error("invalid run model: missing issue.number");
  if (!Array.isArray(model.steps)) throw new Error("invalid run model: steps must be an array");
  for (const step of model.steps) {
    if (!STEP_IDS.has(step.id)) throw new Error(`invalid run model: unknown step "${step?.id}"`);
    if (!STATUSES.includes(step.status)) throw new Error(`invalid run model: step "${step.id}" has invalid status "${step.status}"`);
  }
  return model;
}

/** Overall run status derived from its steps. */
export function overallStatus(model) {
  const steps = model.steps;
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "waiting")) return "waiting";
  if (steps.some((s) => s.status === "running")) return "running";
  if (steps.every((s) => s.status === "done" || s.status === "skipped")) return "complete";
  return "pending";
}

/** True while the run is still moving and the page should auto-refresh. */
export function isActive(model) {
  const o = overallStatus(model);
  return o === "running" || o === "waiting" || o === "pending";
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanDuration(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const STATUS_LABEL = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  waiting: "Waiting on human",
  failed: "Failed",
  skipped: "Skipped",
};
const STATUS_ICON = {
  pending: "○",
  running: "◐",
  done: "✓",
  waiting: "⏸",
  failed: "✕",
  skipped: "–",
};

/**
 * Render the run model to a self-contained HTML page.
 * Pure: depends only on `model` (timestamps come from the model), so output is
 * deterministic and unit-testable.
 * @param {object} model
 * @returns {string}
 */
export function renderShipIssueDashboard(model) {
  assertValidRun(model);
  const defById = Object.fromEntries(STEP_DEFS.map((d) => [d.id, d]));
  const overall = overallStatus(model);
  const active = isActive(model);
  const doneCount = model.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const total = model.steps.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const refresh = active ? '\n    <meta http-equiv="refresh" content="4">' : "";

  const gateBanner =
    model.gate === "spec-approval"
      ? `<div class="banner gate">⏸ Waiting on a human to <strong>approve the spec</strong>. Re-run <code>/ship-issue ${model.issue.number} --approved</code> to continue.</div>`
      : model.gate === "merge"
        ? `<div class="banner gate">⏸ Waiting on a human to <strong>read the review and merge</strong> the PR. The pipeline never merges on its own.</div>`
        : overall === "failed"
          ? `<div class="banner fail">✕ A step failed. See the failed step below.</div>`
          : overall === "complete"
            ? `<div class="banner ok">✓ Pipeline complete.</div>`
            : "";

  const prLink = model.pr?.number
    ? `<a href="${esc(model.pr.url ?? "#")}">PR #${esc(model.pr.number)}</a>`
    : '<span class="muted">no PR yet</span>';

  const issueTitle = model.issue.url
    ? `<a href="${esc(model.issue.url)}">#${esc(model.issue.number)}</a>`
    : `#${esc(model.issue.number)}`;

  const rows = model.steps
    .map((step) => {
      const def = defById[step.id];
      const duration = humanDuration(step.startedAt, step.finishedAt);
      const artifacts = step.artifacts.length
        ? `<ul class="artifacts">${step.artifacts
            .map((a) => `<li><a href="${esc(a.href)}">${esc(a.label)}</a></li>`)
            .join("")}</ul>`
        : "";
      const notes = step.notes.length
        ? `<ul class="notes">${step.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
        : "";
      const summary = step.summary ? `<p class="summary">${esc(step.summary)}</p>` : "";
      const times = [
        step.startedAt ? `started ${esc(step.startedAt)}` : null,
        step.finishedAt ? `finished ${esc(step.finishedAt)}` : null,
        duration ? `(${duration})` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `      <li class="step status-${esc(step.status)}">
        <div class="step-rail"><span class="step-icon" aria-hidden="true">${STATUS_ICON[step.status]}</span></div>
        <div class="step-body">
          <div class="step-head">
            <span class="step-n">${esc(def.n)}</span>
            <span class="step-name">${esc(def.name)}</span>
            <span class="badge owner-${esc(def.owner)}">${esc(def.owner)}</span>
            <span class="badge st st-${esc(step.status)}">${esc(STATUS_LABEL[step.status])}</span>
          </div>
          <p class="desc">${esc(def.desc)}</p>
          ${summary}
          ${artifacts}
          ${notes}
          ${times ? `<p class="times">${times}</p>` : ""}
        </div>
      </li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
    <title>ship-issue #${esc(model.issue.number)} — ${esc(model.issue.title)}</title>
    <style>
      :root { color-scheme: light dark; --bg:#0f1419; --card:#1a212b; --line:#2a3543; --txt:#e6edf3; --muted:#8b98a5; --accent:#3b82f6; --ok:#22c55e; --run:#eab308; --wait:#f59e0b; --fail:#ef4444; }
      * { box-sizing: border-box; }
      body { margin:0; padding:24px; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
      .wrap { max-width: 860px; margin: 0 auto; }
      header { border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:16px; }
      h1 { font-size:18px; margin:0 0 6px; }
      .meta { color:var(--muted); font-size:13px; display:flex; flex-wrap:wrap; gap:14px; }
      .meta a { color:var(--accent); text-decoration:none; }
      .muted { color:var(--muted); }
      .progress { margin:14px 0 4px; height:8px; background:var(--line); border-radius:6px; overflow:hidden; }
      .progress > span { display:block; height:100%; background:var(--ok); transition:width .3s; }
      .progress-label { font-size:12px; color:var(--muted); }
      .banner { padding:10px 14px; border-radius:8px; margin:14px 0; font-size:13px; }
      .banner.gate { background:rgba(245,158,11,.12); border:1px solid var(--wait); }
      .banner.ok { background:rgba(34,197,94,.12); border:1px solid var(--ok); }
      .banner.fail { background:rgba(239,68,68,.12); border:1px solid var(--fail); }
      .banner code { background:rgba(255,255,255,.08); padding:1px 5px; border-radius:4px; }
      ol.steps { list-style:none; margin:0; padding:0; }
      li.step { display:flex; gap:14px; }
      .step-rail { display:flex; flex-direction:column; align-items:center; }
      .step-icon { width:26px; height:26px; line-height:26px; text-align:center; border-radius:50%; background:var(--card); border:1px solid var(--line); font-size:14px; }
      li.step:not(:last-child) .step-rail::after { content:""; flex:1; width:2px; background:var(--line); margin:4px 0; }
      .step-body { flex:1; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
      .step-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .step-n { color:var(--muted); font-variant-numeric:tabular-nums; }
      .step-name { font-weight:600; }
      .desc { color:var(--muted); margin:6px 0 0; }
      .summary { margin:8px 0 0; }
      .badge { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); text-transform:capitalize; }
      .owner-human { color:#c4b5fd; border-color:#5b4b8a; }
      .owner-agent { color:#7dd3fc; border-color:#2b6a8a; }
      .st { font-weight:600; }
      .st-pending { color:var(--muted); }
      .st-running { color:var(--run); border-color:var(--run); }
      .st-done { color:var(--ok); border-color:var(--ok); }
      .st-waiting { color:var(--wait); border-color:var(--wait); }
      .st-failed { color:var(--fail); border-color:var(--fail); }
      .st-skipped { color:var(--muted); }
      .status-done .step-icon { color:var(--ok); border-color:var(--ok); }
      .status-running .step-icon { color:var(--run); border-color:var(--run); }
      .status-waiting .step-icon { color:var(--wait); border-color:var(--wait); }
      .status-failed .step-icon { color:var(--fail); border-color:var(--fail); }
      ul.artifacts, ul.notes { margin:8px 0 0; padding-left:18px; }
      ul.artifacts a { color:var(--accent); text-decoration:none; }
      ul.notes { color:var(--muted); }
      .times { color:var(--muted); font-size:12px; margin:8px 0 0; }
      footer { color:var(--muted); font-size:12px; margin-top:18px; border-top:1px solid var(--line); padding-top:12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>ship-issue ${issueTitle} — ${esc(model.issue.title)}</h1>
        <div class="meta">
          <span>Status: <strong class="st-${esc(overall === "complete" ? "done" : overall)}">${esc(overall)}</strong></span>
          <span>Branch: <code>${esc(model.branch ?? "—")}</code></span>
          <span>${prLink}</span>
          <span>Updated: ${esc(model.updatedAt)}</span>
        </div>
        <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <div class="progress-label">${doneCount} / ${total} steps complete (${pct}%)</div>
      </header>
      ${gateBanner}
      <ol class="steps">
${rows}
      </ol>
      <footer>
        Generated by <code>ship-issue-dashboard.mjs</code>.${active ? " This page auto-refreshes every 4s while the run is active." : " Run finished — auto-refresh off."}
      </footer>
    </div>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const artifacts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = args[i + 1] != null && !args[i + 1].startsWith("--") ? args[++i] : "true";
    if (key === "artifact") {
      const eq = value.indexOf("=");
      if (eq === -1) throw new Error(`--artifact expects label=href, got "${value}"`);
      artifacts.push({ label: value.slice(0, eq), href: value.slice(eq + 1) });
    } else {
      flags[key] = value;
    }
  }
  return { flags, artifacts };
}

function readModel(base) {
  return assertValidRun(JSON.parse(readFileSync(`${base}.json`, "utf8")));
}

function writeModel(base, model) {
  mkdirSync(dirname(`${base}.json`), { recursive: true });
  writeFileSync(`${base}.json`, `${JSON.stringify(model, null, 2)}\n`);
  writeFileSync(`${base}.html`, renderShipIssueDashboard(model));
}

function main(argv) {
  const [command, base, ...rest] = argv;
  if (!command || !base) {
    throw new Error("usage: ship-issue-dashboard.mjs <init|set|render> <base> [...]");
  }

  if (command === "init") {
    const { flags } = parseFlags(rest);
    const model = createRun({
      issue: flags.issue,
      title: flags.title,
      slug: flags.slug,
      branch: flags.branch,
      issueUrl: flags["issue-url"],
    });
    writeModel(base, model);
    process.stdout.write(`${base}.html\n`);
    return;
  }

  if (command === "set") {
    const [stepId, status, ...flagArgs] = rest;
    if (!stepId) throw new Error("set: missing <stepId>");
    const { flags, artifacts } = parseFlags(flagArgs);
    let model = readModel(base);
    model = setStep(model, stepId, {
      status: status && !status.startsWith("--") ? status : undefined,
      summary: flags.summary,
      note: flags.note,
      artifacts: artifacts.length ? artifacts : undefined,
    });
    const metaPatch = {};
    if (flags.pr) metaPatch.pr = { number: Number(flags.pr), url: flags["pr-url"] };
    if (flags.gate) metaPatch.gate = flags.gate === "none" ? null : flags.gate;
    if (Object.keys(metaPatch).length) model = setMeta(model, metaPatch);
    writeModel(base, model);
    process.stdout.write(`${base}.html\n`);
    return;
  }

  if (command === "render") {
    writeModel(base, readModel(base));
    process.stdout.write(`${base}.html\n`);
    return;
  }

  throw new Error(`unknown command "${command}" (expected init|set|render)`);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ship-issue-dashboard: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

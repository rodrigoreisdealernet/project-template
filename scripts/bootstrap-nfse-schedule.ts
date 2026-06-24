/**
 * bootstrap-nfse-schedule — create (idempotently) a Temporal Schedule that runs
 * the nfse-ingest workflow automatically every 15 seconds (overlap = SKIP).
 *
 * Runs on the HOST (via `make nfse-schedule`), so it connects to Temporal on the
 * compose-mapped port (127.0.0.1:7234), not the in-network temporal:7233.
 *
 * The Schedule starts DSLWorkflow directly, so it embeds the definition JSON read
 * from temporal/definitions/nfse-ingest.json (must match the active DB definition).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";

const ADDRESS = process.env.TEMPORAL_HOST_ADDRESS ?? "127.0.0.1:7234";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "main";
const SCHEDULE_ID = "nfse-ingest-15s";
const EVERY = process.env.NFSE_SCHEDULE_EVERY ?? "15s";

async function main(): Promise<void> {
  const definitionPath = join(__dirname, "..", "temporal", "definitions", "nfse-ingest.json");
  const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as Record<string, unknown>;

  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });

  try {
    await client.schedule.create({
      scheduleId: SCHEDULE_ID,
      spec: { intervals: [{ every: EVERY }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: {
        type: "startWorkflow",
        workflowType: "DSLWorkflow",
        taskQueue: TASK_QUEUE,
        workflowId: "nfse-ingest-scheduled",
        args: [{ definition, input: {} }],
      },
    });
    process.stdout.write(`Created Temporal Schedule '${SCHEDULE_ID}' (every ${EVERY}, overlap=SKIP).\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already|exists/i.test(msg)) {
      process.stdout.write(`Schedule '${SCHEDULE_ID}' already exists — leaving as is.\n`);
    } else {
      throw err;
    }
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  process.stderr.write(`bootstrap-nfse-schedule failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

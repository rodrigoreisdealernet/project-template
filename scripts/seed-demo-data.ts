#!/usr/bin/env npx ts-node
/**
 * seed-demo-data — populate the LOCAL dev database with demo entities and
 * workflow definitions so the Playwright E2E specs (frontend/e2e/*.spec.ts)
 * have data to assert against. Without this, the template ships an empty
 * workspace (entities=0, only the nfse-ingest definition) and most data-driven
 * E2E specs fail on missing rows rather than real defects.
 *
 * Idempotent: rows are keyed by stable markers (entities by source_record_id
 * `seed-*`, definitions by name+version) and UPSERTed, so re-running is safe.
 *
 * LOCAL/DEV ONLY. Refuses to run against a non-local database unless
 * SEED_FORCE=1 is set. Never run this against production.
 *
 * Usage:
 *   make seed-demo
 *   npx ts-node --project temporal/tsconfig.json scripts/seed-demo-data.ts
 *
 * Connection (first match wins):
 *   SEED_DATABASE_URL | SUPABASE_DB_URL | default postgresql://postgres:postgres@127.0.0.1:54322/postgres
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Load .env (best-effort) — mirrors scripts/bootstrap-users.ts
// ---------------------------------------------------------------------------

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Config + safety guard
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.SEED_DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const isLocal = /@(127\.0\.0\.1|localhost|::1)[:/]/.test(DATABASE_URL);
if (!isLocal && process.env.SEED_FORCE !== '1') {
  console.error(
    `Refusing to seed a non-local database (${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}).`,
  );
  console.error('This script is for local dev only. Set SEED_FORCE=1 to override.');
  process.exit(1);
}

const DEFINITIONS_DIR = resolve(__dirname, '..', 'temporal', 'definitions');

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

interface SeedEntity {
  type: string;
  ref: string; // stable source_record_id for idempotency
  name: string;
  description: string;
}

// Two each of the working-set types the experience specs search/list, plus one
// of every remaining entity_type so the sidebar working sets and entity-detail
// routes have something to render.
const ENTITIES: SeedEntity[] = [
  { type: 'portfolio', ref: 'seed-portfolio-alpha', name: 'Seed Portfolio Alpha', description: 'Demo portfolio for E2E list/search coverage' },
  { type: 'portfolio', ref: 'seed-portfolio-beta', name: 'Seed Portfolio Beta', description: 'Second demo portfolio for search narrowing' },
  { type: 'group', ref: 'seed-group-alpha', name: 'Seed Group Alpha', description: 'Demo group for sidebar + entity-detail tests' },
  { type: 'group', ref: 'seed-group-beta', name: 'Seed Group Beta', description: 'Second demo group for search narrowing' },
  { type: 'vbu', ref: 'seed-vbu-1', name: 'Seed VBU One', description: 'Demo VBU' },
  { type: 'assessment', ref: 'seed-assessment-1', name: 'Seed Assessment One', description: 'Demo assessment' },
  { type: 'question', ref: 'seed-question-1', name: 'Seed Question One', description: 'Demo question' },
  { type: 'person', ref: 'seed-person-1', name: 'Seed Person One', description: 'Demo person' },
  { type: 'evidence', ref: 'seed-evidence-1', name: 'Seed Evidence One', description: 'Demo evidence' },
];

interface DefRow {
  name: string;
  version: string;
  definition: Record<string, unknown>;
  description: string | null;
  isActive: boolean;
  reviewStatus: 'draft' | 'pending-review' | 'approved' | 'rejected';
}

function loadDefinition(file: string): Record<string, unknown> {
  const path = resolve(DEFINITIONS_DIR, file);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function buildDefinitions(): DefRow[] {
  const smoke = loadDefinition('smoke-classification.json');
  const vertical = loadDefinition('vertical-classification.json');

  // A pending-review definition so the definitions list shows a non-live status
  // badge and the promotion specs have something to approve/reject. Reuse the
  // vertical-classification DSL under a fresh version so it does not collide
  // with the active row above.
  const pending: Record<string, unknown> = { ...vertical, version: '2.0.0' };

  return [
    {
      name: String(smoke.name),
      version: String(smoke.version),
      definition: smoke,
      description: (smoke.description as string) ?? null,
      isActive: true,
      reviewStatus: 'approved',
    },
    {
      name: String(vertical.name),
      version: String(vertical.version),
      definition: vertical,
      description: (vertical.description as string) ?? null,
      isActive: true,
      reviewStatus: 'approved',
    },
    {
      name: String(pending.name),
      version: '2.0.0',
      definition: pending,
      description: `${(vertical.description as string) ?? 'Demo definition'} (pending review)`,
      isActive: false,
      reviewStatus: 'pending-review',
    },
  ];
}

// ---------------------------------------------------------------------------
// Seed routines
// ---------------------------------------------------------------------------

async function seedEntities(client: Client): Promise<void> {
  for (const e of ENTITIES) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO entities (entity_type, source_record_id)
       VALUES ($1, $2)
       ON CONFLICT (entity_type, source_record_id)
         DO UPDATE SET updated_at = now()
       RETURNING id`,
      [e.type, e.ref],
    );
    const entityId = rows[0].id;
    await client.query(
      `INSERT INTO entity_versions (entity_id, version_number, data, is_current)
       VALUES ($1, 1, $2::jsonb, true)
       ON CONFLICT (entity_id, version_number)
         DO UPDATE SET data = EXCLUDED.data, is_current = true, updated_at = now()`,
      [entityId, JSON.stringify({ name: e.name, description: e.description })],
    );
  }
  console.log(`  seeded ${ENTITIES.length} entities (portfolio, group, vbu, assessment, question, person, evidence)`);
}

async function seedDefinitions(client: Client): Promise<void> {
  const defs = buildDefinitions();
  for (const d of defs) {
    await client.query(
      `INSERT INTO workflow_definitions
         (name, version, definition, description, is_active, review_status, deployed_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, CASE WHEN $5 THEN now() ELSE NULL END)
       ON CONFLICT (name, version) DO UPDATE SET
         definition    = EXCLUDED.definition,
         description   = EXCLUDED.description,
         is_active     = EXCLUDED.is_active,
         review_status = EXCLUDED.review_status,
         deployed_at   = EXCLUDED.deployed_at,
         updated_at    = now()`,
      [d.name, d.version, JSON.stringify(d.definition), d.description, d.isActive, d.reviewStatus],
    );
    console.log(`  seeded definition ${d.name}@${d.version} (${d.reviewStatus}${d.isActive ? ', active' : ''})`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== seed-demo-data ===\n');
  console.log(`Database: ${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}\n`);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await seedEntities(client);
    await seedDefinitions(client);
    await client.query('COMMIT');
    console.log('\nDemo seed applied. Re-run anytime — it is idempotent.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('seed-demo-data failed:', (err as Error).message);
  process.exit(1);
});

import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// E2E coverage for the NFS-e automated ingestion results screen (`/nfse`).
// This is the end-to-end tip of the test pyramid for the feature: it drives the
// REAL route in a browser, through AuthGate -> MfaGate, React Query, and the
// rendered table — with only the two backend boundaries mocked at the network
// edge (the Supabase read of `workflow_document_extractions` and the
// `trigger-workflow` Edge Function), exactly as `experience.spec.ts` mocks
// `trigger-workflow` and `rest/v1/entities` for the generic trigger screen.
//
// E2E runs against a REAL running frontend (E2E_BASE_URL). The authenticated
// cases skip automatically when E2E_AUTH_EMAIL is not configured (fresh fork /
// CI without a deployed env) — consistent with the rest of the suite.

const TOTP_PERIOD_SECONDS = 30;
const MFA_APPEARANCE_TIMEOUT_MS = 2_500;
const MFA_VERIFY_TIMEOUT_MS = 30_000;
const AUTH_REDIRECT_TIMEOUT_MS = 30_000;

function decodeBase32Secret(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid Base32 TOTP secret.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function generateTotpCode(secret: string): string {
  const key = decodeBase32Secret(secret);
  const counter = Math.floor(Date.now() / 1_000 / TOTP_PERIOD_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

async function resolveMfaCode(page: Page): Promise<string> {
  const directCode = process.env.E2E_MFA_CODE?.trim();
  if (directCode) {
    return directCode;
  }

  const stableSecret = process.env.E2E_MFA_SECRET?.trim();
  if (stableSecret) {
    return generateTotpCode(stableSecret);
  }

  const enrollmentSecret = (
    await page.locator("[data-testid='mfa-secret']").textContent()
  )?.trim();
  if (enrollmentSecret) {
    return generateTotpCode(enrollmentSecret);
  }

  throw new Error(
    "MFA challenge detected but no E2E_MFA_CODE or E2E_MFA_SECRET is configured.",
  );
}

async function signIn(page: Page): Promise<void> {
  const emailInput = page.locator("[data-testid='login-email']");
  const passwordInput = page.locator("[data-testid='login-password']");

  await page.goto("/");
  await expect(emailInput).toBeVisible();
  await expect(passwordInput).toBeVisible();
  await emailInput.fill(process.env.E2E_AUTH_EMAIL ?? "");
  await passwordInput.fill(process.env.E2E_AUTH_PASSWORD ?? "");
  await page.locator("[data-testid='login-submit']").click();

  const mfaVisible = await page
    .locator("[data-testid='mfa-card']")
    .waitFor({ state: "visible", timeout: MFA_APPEARANCE_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);

  if (mfaVisible) {
    await page.locator("[data-testid='mfa-code']").fill(await resolveMfaCode(page));
    await page.locator("[data-testid='mfa-submit']").click();
    await page
      .locator("[data-testid='mfa-card']")
      .waitFor({ state: "hidden", timeout: MFA_VERIFY_TIMEOUT_MS });
  }

  await page.waitForURL("/", { timeout: AUTH_REDIRECT_TIMEOUT_MS });
  await expect(page.locator("[data-testid='login-card']")).toHaveCount(0);
  await expect(page.locator("[data-testid='mfa-card']")).toHaveCount(0);
}

// Deterministic extraction rows covering the four UI-critical states:
//  - a clean high-confidence row with a safe https source (renders "Ver PDF");
//  - a genuinely low-confidence row (< 0.7) -> flagged for review;
//  - an out-of-range (impossible) confidence 1.5 -> must NOT pass as high confidence;
//  - a javascript: source_url -> must NOT render as a clickable link (stored-XSS guard).
const EXTRACTION_ROWS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    source_url: "https://mock-nfse-api.test/invoices/402/content",
    extracted_fields: {
      numero_nota: "402",
      prestador_razao_social: "Oficina Modelo LTDA",
      tomador_razao_social: "Cliente Alpha SA",
      valor_total: 245.05,
      data_emissao: "2026-05-12",
    },
    confidence: 0.95,
    extracted_at: "2026-06-24T12:00:00.000Z",
    created_at: "2026-06-24T12:00:00.000Z",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    source_url: "https://mock-nfse-api.test/invoices/14521/content",
    extracted_fields: {
      numero_nota: "14521",
      prestador_razao_social: "Serviços Beta ME",
      tomador_razao_social: "Cliente Gamma LTDA",
      valor_total: 500,
      data_emissao: "2026-05-13",
    },
    confidence: 0.42,
    extracted_at: "2026-06-24T12:00:01.000Z",
    created_at: "2026-06-24T12:00:01.000Z",
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    source_url: "https://mock-nfse-api.test/invoices/2551/content",
    extracted_fields: {
      numero_nota: "2551",
      prestador_razao_social: "Delta Engenharia",
      tomador_razao_social: "Cliente Epsilon",
      valor_total: 827.5,
      data_emissao: "2026-05-14",
    },
    confidence: 1.5, // impossible score — must be flagged, never shown as "high".
    extracted_at: "2026-06-24T12:00:02.000Z",
    created_at: "2026-06-24T12:00:02.000Z",
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    // Deliberately malicious — asserts the UI refuses to render it as a link.
    source_url: "javascript:alert(1)",
    extracted_fields: {
      numero_nota: "9999",
      prestador_razao_social: "Fonte Suspeita",
      tomador_razao_social: "Cliente Zeta",
      valor_total: 10,
      data_emissao: "2026-05-15",
    },
    confidence: 0.9,
    extracted_at: "2026-06-24T12:00:03.000Z",
    created_at: "2026-06-24T12:00:03.000Z",
  },
] as const;

// Rows that need review (low or out-of-range confidence): #2 (0.42) and #3 (1.5).
const PENDING_REVIEW_COUNT = 2;

async function mockExtractionsRead(page: Page, rows: unknown[]): Promise<void> {
  await page.route("**/rest/v1/workflow_document_extractions*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows),
    });
  });
}

test.describe("NFS-e ingestion results screen", () => {
  test.beforeAll(() => {
    if (!process.env.E2E_AUTH_EMAIL) {
      test.skip(
        true,
        "E2E_AUTH_EMAIL not configured — skipping NFS-e ingestion E2E (route is behind AuthGate)",
      );
    }
  });

  test("renders extracted invoices with currency, confidence badges, and a safe source link", async ({
    page,
  }) => {
    await mockExtractionsRead(page, [...EXTRACTION_ROWS]);
    await signIn(page);
    await page.goto("/nfse");

    await expect(
      page.getByRole("heading", { name: /Notas Fiscais .*Extra/i }),
    ).toBeVisible();

    const table = page.getByTestId("nfse-table");
    await expect(table).toBeVisible();
    await expect(page.getByTestId("nfse-row")).toHaveCount(EXTRACTION_ROWS.length);

    // High-confidence row: BRL formatting, green badge, and a clickable PDF link.
    const cleanRow = page.getByTestId("nfse-row").filter({ hasText: "402" });
    await expect(cleanRow).toContainText("245,05");
    await expect(cleanRow.getByTestId("nfse-confidence")).toContainText("95%");
    await expect(cleanRow.getByTestId("nfse-open-source")).toHaveAttribute(
      "href",
      "https://mock-nfse-api.test/invoices/402/content",
    );

    // Low-confidence row is flagged for review, not shown as trustworthy.
    const lowRow = page.getByTestId("nfse-row").filter({ hasText: "14521" });
    await expect(lowRow.getByTestId("nfse-low-confidence")).toContainText("baixa");
    await expect(lowRow.getByTestId("nfse-confidence")).toHaveCount(0);

    // Review backlog pill reflects exactly the rows needing a human.
    await expect(page.getByTestId("nfse-review-count")).toContainText(
      String(PENDING_REVIEW_COUNT),
    );
  });

  test("out-of-range confidence is flagged for review and never rendered as high confidence", async ({
    page,
  }) => {
    await mockExtractionsRead(page, [...EXTRACTION_ROWS]);
    await signIn(page);
    await page.goto("/nfse");

    const outOfRangeRow = page.getByTestId("nfse-row").filter({ hasText: "2551" });
    // 1.5 -> "150%", but it must carry the low/review treatment, not the green badge.
    await expect(outOfRangeRow.getByTestId("nfse-low-confidence")).toContainText("baixa");
    await expect(outOfRangeRow.getByTestId("nfse-confidence")).toHaveCount(0);
  });

  test("a javascript: source_url is never rendered as a clickable link (stored-XSS guard)", async ({
    page,
  }) => {
    await mockExtractionsRead(page, [...EXTRACTION_ROWS]);
    await signIn(page);
    await page.goto("/nfse");

    const maliciousRow = page.getByTestId("nfse-row").filter({ hasText: "9999" });
    await expect(maliciousRow).toBeVisible();
    // No anchor at all for the unsafe URL — the cell falls back to an em dash.
    await expect(maliciousRow.getByTestId("nfse-open-source")).toHaveCount(0);
    await expect(maliciousRow.locator("a")).toHaveCount(0);
  });

  test("review filter narrows the table to only rows needing a human", async ({ page }) => {
    await mockExtractionsRead(page, [...EXTRACTION_ROWS]);
    await signIn(page);
    await page.goto("/nfse");

    await expect(page.getByTestId("nfse-row")).toHaveCount(EXTRACTION_ROWS.length);

    await page.getByTestId("nfse-review-filter").check();

    // Only the low (14521) and out-of-range (2551) rows survive the filter.
    await expect(page.getByTestId("nfse-row")).toHaveCount(PENDING_REVIEW_COUNT);
    await expect(page.getByTestId("nfse-row").filter({ hasText: "14521" })).toHaveCount(1);
    await expect(page.getByTestId("nfse-row").filter({ hasText: "2551" })).toHaveCount(1);
    await expect(page.getByTestId("nfse-row").filter({ hasText: "402" })).toHaveCount(0);
  });

  test("'Scan now' triggers the nfse-ingest workflow via the Edge Function", async ({ page }) => {
    await mockExtractionsRead(page, [...EXTRACTION_ROWS]);

    let triggeredDefinition: string | undefined;
    await page.route("**/functions/v1/trigger-workflow", async (route) => {
      const body = route.request().postDataJSON() as {
        definition_name?: string;
        input?: Record<string, unknown>;
      };
      triggeredDefinition = body.definition_name;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflow_id: "wf-nfse-e2e-1", run_id: "run-nfse-e2e-1" }),
      });
    });

    await signIn(page);
    await page.goto("/nfse");

    await page.getByTestId("nfse-scan-now-button").click();

    await expect(page.getByTestId("nfse-scan-message")).toContainText("wf-nfse-e2e-1");
    await expect(page.getByTestId("nfse-scan-error")).toHaveCount(0);
    expect(triggeredDefinition).toBe("nfse-ingest");
  });

  test("shows an actionable empty state when no invoices have been ingested", async ({ page }) => {
    await mockExtractionsRead(page, []);
    await signIn(page);
    await page.goto("/nfse");

    await expect(page.getByTestId("nfse-empty")).toBeVisible();
    await expect(page.getByTestId("nfse-table")).toHaveCount(0);
  });
});

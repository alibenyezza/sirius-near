import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request, type Route } from "playwright/test";
import { USDC_DECIMALS } from "@/lib/evm/usdc";
import { mockSigningWallet, walletAddress } from "./helpers/wallet";

/**
 * Publication en deux étapes (docs/passage-mainnet/07-upload.md), API simulée.
 *
 * Le wallet signe réellement le challenge d'authentification (délégation runner comprise) ;
 * le fichier est réellement chiffré dans le navigateur pour une clé P-256 générée par le
 * test. Aucun appel n'atteint la base, l'enclave ni la chaîne.
 */

const EXAMPLE = readFileSync("public/examples/regression/housing-prices-train.csv");
const DATASET_ID = "cmg2upload0000000000001";

function usdc(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  return (BigInt(whole) * BigInt(10) ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, "0") || "0")).toString();
}

/** Point public P-256 non compressé (65 octets, préfixe 0x04), tel que `encryptDatasetForRunner` l'attend. */
function ingressPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url");
}

function csv(rows: number, target: (row: number) => string): string {
  const lines = Array.from({ length: rows }, (_, row) => `${row},${(row * 7) % 13},${target(row)}`);
  return `x1,x2,y\n${lines.join("\n")}\n`;
}

interface Captured {
  draft: Record<string, unknown> | null;
  upload: Request | null;
  listed: boolean;
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await page.getByRole("button", { name: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`, exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
}

async function mockPublicationApi(page: Page, options: { challengeDays?: number } = {}): Promise<Captured> {
  const captured: Captured = { draft: null, upload: null, listed: false };
  await mockSigningWallet(page, {
    api: async (path: string, route: Route) => {
      const request = route.request();
      if (path === "/api/datasets" && request.method() === "POST") {
        captured.draft = request.postDataJSON() as Record<string, unknown>;
        return route.fulfill({
          status: 201,
          json: {
            datasetId: DATASET_ID,
            ingressKey: { version: 1, publicKey: ingressPublicKey(), origin: new URL(request.url()).origin },
            priceUsdcAtomic: usdc("12.5"),
            challengeDays: options.challengeDays ?? 3,
            sizeBytes: EXAMPLE.byteLength,
            model: { modelId: "linear_regression", modelVersion: "1.0.0" },
            category: "Finance",
            listingDays: 90,
            listingExpiresAt: "2027-01-02T10:00:00.000Z",
            trainingConsentAt: "2026-10-04T10:00:00.000Z",
            trainingConsentVersion: "2026-10-04",
          },
        });
      }
      if (path === "/api/datasets" && request.method() === "GET") return route.fulfill({ json: [] });
      if (path === `/api/datasets/${DATASET_ID}/upload`) {
        captured.upload = request;
        return route.fulfill({ json: { id: DATASET_ID, status: "DRAFT" } });
      }
      if (path === `/api/datasets/${DATASET_ID}/list`) {
        captured.listed = true;
        return route.fulfill({ json: { reconciled: true } });
      }
      return route.fulfill({ json: {} });
    },
  });
  return captured;
}

async function fillStepOne(page: Page) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.getByRole("button", { name: "Load the example dataset" }).click();
  await expect(page.getByText("File accepted by the browser check.")).toBeVisible();
  await expect(page.getByText("Data rows").locator("..").getByText("112", { exact: true })).toBeVisible();
  await expect(page.getByText("Target column").locator("..").getByText("price_eur", { exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Housing prices Lyon");
  await page.getByLabel("Category").selectOption("Finance");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("sirius-ui");
  });
});

test("l'étape 1 refuse un fichier invalide avec la raison exacte, avant tout envoi", async ({ page }) => {
  let apiCalls = 0;
  await page.route("**/api/**", (route) => {
    apiCalls += 1;
    return route.fulfill({ json: { known: true } });
  });
  await page.goto("/datasets/new");
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
  await expect(page.getByText(/CSV up to 3 MB, 100 to 20,000 rows/)).toBeVisible();

  const file = page.locator('input[type="file"]');
  await file.setInputFiles({ name: "tiny.csv", mimeType: "text/csv", buffer: Buffer.from(csv(2, () => "1")) });
  await expect(page.locator("main").getByRole("alert")).toHaveText("Not enough rows: 2, minimum 100 for this number of features.");
  await expect(page.getByRole("button", { name: "Continue to pricing" })).toBeDisabled();

  await file.setInputFiles({ name: "dup.csv", mimeType: "text/csv", buffer: Buffer.from(csv(150, (row) => String(row)).replace("x1,x2,y", "x1,x1,y")) });
  await expect(page.locator("main").getByRole("alert")).toHaveText("Invalid header: every column needs a name, with no duplicates.");

  await file.setInputFiles({ name: "continuous.csv", mimeType: "text/csv", buffer: Buffer.from(csv(150, (row) => String(row * 3))) });
  await expect(page.getByText("File accepted by the browser check.")).toBeVisible();
  await page.getByLabel("Training profile").selectOption("logistic_regression");
  await expect(page.locator("main").getByRole("alert")).toHaveText("For logistic regression, the target column “y” must contain only 0 and 1, with both classes present.");
  await page.getByLabel("Training profile").selectOption("linear_regression");
  await expect(page.getByText("File accepted by the browser check.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to pricing" })).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill("Continuous");
  await expect(page.getByRole("button", { name: "Continue to pricing" })).toBeDisabled();
  await page.getByLabel("Category").selectOption("Other");
  await expect(page.getByRole("button", { name: "Continue to pricing" })).toBeEnabled();
  const before = apiCalls;
  await file.setInputFiles({ name: "empty.csv", mimeType: "text/csv", buffer: Buffer.alloc(0) });
  await expect(page.locator("main").getByRole("alert")).toHaveText("The file is empty.");
  expect(apiCalls).toBe(before);
});

test("publie en deux étapes : contrôle, sécurisation, prix décomposé, consentement, scellement et titre", async ({ page }) => {
  const captured = await mockPublicationApi(page);
  await signIn(page);
  await page.goto("/datasets/new");
  await fillStepOne(page);
  await page.getByRole("button", { name: "Continue to pricing" }).click();

  // Transition réelle : empreinte SHA-256 calculée sur l'appareil, au moins deux secondes.
  await expect(page.getByRole("heading", { name: "Securing on your device" })).toBeVisible();
  const started = Date.now();
  await expect(page.getByText(/Local fingerprint: [0-9a-f]{64}/)).toBeVisible();
  const priceField = page.getByLabel("What I want to earn per loan (USDC)");
  await expect(priceField).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  await expect(page.getByText("Step 2 of 2")).toBeVisible();

  // Décomposition en direct, minimum affiché, saisie sous le plancher refusée.
  await priceField.fill("0.0001");
  await expect(page.getByText("Invalid amount: check the bounds and the number of decimals.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish the dataset" })).toBeDisabled();
  await priceField.fill("12.5");
  const breakdown = page.getByRole("region", { name: "Price breakdown" });
  await expect(breakdown.getByText("You receive").locator("..").getByText("12.50 USDC")).toBeVisible();
  await expect(breakdown.getByText("Borrower pays").locator("..").getByText("12.50 USDC")).toBeVisible();
  await expect(breakdown.getByText("Minimum set by the tariff: 0.001 USDC.")).toBeVisible();
  await expect(page.getByText(/escrow safety delay is set by Sirius to 3 days/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "30 days (default)" })).toBeChecked();
  await page.getByRole("radio", { name: "90 days", exact: true }).check();
  await expect(page.getByText(/Sirius currently trains baseline models/)).toBeVisible();
  const consent = page.getByRole("checkbox", { name: /Allow Sirius to use this dataset, inside the enclave only/ });
  await expect(consent).not.toBeChecked();
  await consent.check();

  await page.getByRole("button", { name: "Publish the dataset" }).click();
  await expect(page).toHaveURL(/\/datasets$/, { timeout: 20_000 });

  // Le serveur reçoit les termes du formulaire, sans délai de sécurité choisi par le client.
  expect(captured.draft).toEqual({
    name: "Housing prices Lyon",
    sizeBytes: EXAMPLE.byteLength,
    priceUsdc: "12.5",
    category: "Finance",
    listingDays: 90,
    trainingConsent: true,
    modelId: "linear_regression",
  });
  expect(captured.draft).not.toHaveProperty("challengeDays");
  // L'enveloppe est chiffrée dans le navigateur et autorisée par la délégation runner.
  expect(captured.upload).not.toBeNull();
  expect(captured.upload?.headers()["x-sirius-runner-grant"]).toBeTruthy();
  const envelope = (captured.upload?.postDataJSON() as { envelope: Record<string, string> }).envelope;
  expect(envelope.version).toBe(1);
  expect(envelope.ciphertext.length).toBeGreaterThan(EXAMPLE.byteLength);
  expect(envelope.ciphertext).not.toContain(EXAMPLE.toString("utf8").slice(0, 20));
  expect(captured.listed).toBe(true);
});

test("un délai de sécurité renvoyé différent de 3 jours arrête la publication avant tout chiffrement", async ({ page }) => {
  const captured = await mockPublicationApi(page, { challengeDays: 7 });
  await signIn(page);
  await page.goto("/datasets/new");
  await fillStepOne(page);
  await page.getByRole("button", { name: "Continue to pricing" }).click();
  const priceField = page.getByLabel("What I want to earn per loan (USDC)");
  await expect(priceField).toBeVisible({ timeout: 10_000 });
  await priceField.fill("12.5");
  await page.getByRole("button", { name: "Publish the dataset" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Inconsistent escrow safety delay");
  await expect(page.getByRole("list", { name: "Publication progress" }).locator("li").first()).toHaveAttribute("data-state", "failed");
  expect(captured.draft).not.toBeNull();
  expect(captured.upload).toBeNull();
  expect(captured.listed).toBe(false);
  await expect(page.getByRole("button", { name: "Publish the dataset" })).toBeEnabled();
});

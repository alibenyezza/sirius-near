// N4 — page Train : catalogue retiré, self training réservé à l'équipe, états des emprunts,
// ré-entraînement et remboursement des échecs. L'API est simulée : aucun appel n'atteint la base.
import { expect, test, type Page } from "playwright/test";

const ME = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"9".repeat(64)}`;
const TX = `0x${"e".repeat(64)}`;

const ownDataset = {
  id: "own-dataset", name: "Équipe dataset", provider: ME, status: "PRIVATE", modelId: "linear_regression", modelVersion: "1.0.0",
  ipfsCid: "bafy-fixture", runnerReceipt: "receipt", evmDatasetId: `0x${"12".repeat(32)}`, sizeBytes: 100, metrics: { rowCount: 200, columnCount: 4 },
};

function loan(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, datasetId: `dataset-${id}`, borrower: ME, provider: OTHER, amountUsdcAtomic: "1000000000000000000",
    modelId: "linear_regression", modelVersion: "1.0.0", status: "ESCROWED", evmLockTxHash: TX, evmLoanKey: KEY,
    settleTxHash: null, cancelTxHash: null, modelCid: null, runnerReceipt: null, evmDeadline: "2026-10-01T10:00:00.000Z",
    createdAt: "2026-09-25T10:00:00.000Z", dataset: { name: `Dataset ${id}`, runnerReceipt: null }, refundable: false, ...overrides,
  };
}

interface Options { admin?: boolean; loans?: unknown[] }

async function install(page: Page, { admin = false, loans = [] }: Options = {}) {
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    calls.push(`${route.request().method()} ${url.pathname}${url.search}`);
    switch (url.pathname) {
      case "/api/admin/me": return route.fulfill({ json: { admin } });
      case "/api/loans": return route.fulfill({ json: loans });
      case "/api/datasets": return route.fulfill({ json: [ownDataset] });
      case "/api/train": return route.fulfill({ json: [] });
      case "/api/auth/session": return route.fulfill({ json: { authenticated: false } });
      default: return route.fulfill({ json: { known: true } });
    }
  });
  return calls;
}

async function connect(page: Page) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "borrower"), ME);
}

const card = (page: Page, name: string) => page.getByRole("heading", { name, exact: true }).locator("../../../..");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("sirius-ui"));
});

test("un non-admin ne voit ni catalogue ni self training, et lit l'encart de contact", async ({ page }) => {
  const calls = await install(page, { admin: false });
  await page.goto("/train");
  await connect(page);
  const contact = page.getByTestId("own-data-contact");
  await expect(contact).toHaveText("Want to train on your own data? Contact us at sirius.data.contact@gmail.com.", { timeout: 30_000 });
  await expect(contact.getByRole("link", { name: "sirius.data.contact@gmail.com" })).toHaveAttribute("href", "mailto:sirius.data.contact@gmail.com");
  await expect(page.getByTestId("self-training")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My data", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Borrow", exact: true })).toHaveCount(0);
  await expect(page.getByText("Équipe dataset")).toHaveCount(0);
  // Aucun appel de self training ni de catalogue n'est émis pour un non-admin.
  expect(calls.filter((call) => /\/api\/(datasets|train)/.test(call))).toEqual([]);
});

test("une réponse d'administration en erreur masque le self training et l'encart", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/me") return route.fulfill({ status: 500, json: { error: "boom" } });
    return route.fulfill({ json: path === "/api/loans" ? [] : { known: true } });
  });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByText("No training run yet.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("self-training")).toHaveCount(0);
  await expect(page.getByTestId("own-data-contact")).toHaveCount(0);
});

test("un admin garde le self training et ne voit pas l'encart de contact", async ({ page }) => {
  await install(page, { admin: true });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByTestId("self-training")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Équipe dataset", exact: true })).toBeVisible();
  await expect(page.getByTestId("own-data-contact")).toHaveCount(0);
});

test("les emprunts affichent leur état lisible", async ({ page }) => {
  await install(page, {
    loans: [
      loan("a", { status: "SUBMITTING" }),
      loan("b", { status: "ESCROWED" }),
      loan("c", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy" }),
      loan("d", { status: "ESCROWED", refundable: true }),
      loan("e", { status: "CANCELLED", cancelTxHash: TX }),
      loan("f", { status: "SETTLING", settleTxHash: TX, modelCid: "bafy", runnerReceipt: "receipt" }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  await expect(card(page, "Dataset a")).toContainText("Payment awaiting finality", { timeout: 30_000 });
  await expect(card(page, "Dataset b")).toContainText("In progress");
  await expect(card(page, "Dataset c")).toContainText("Completed");
  await expect(card(page, "Dataset d")).toContainText("Failed");
  await expect(card(page, "Dataset e")).toContainText("Refunded");
  await expect(card(page, "Dataset f")).toContainText("Payment awaiting finality");
});

test("Retrain n'apparaît que sur un emprunt terminé de l'emprunteur, avec l'avertissement à côté", async ({ page }) => {
  await install(page, {
    loans: [
      loan("done", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy" }),
      loan("running", { status: "TRAINING" }),
      loan("failed", { status: "ESCROWED", refundable: true }),
      loan("refunded", { status: "CANCELLED", cancelTxHash: TX }),
      loan("provider-view", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy", borrower: OTHER, provider: ME }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const done = card(page, "Dataset done");
  await expect(done.getByRole("button", { name: "Retrain", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(done.getByTestId("retrain-panel")).toContainText("Linear and logistic regression are deterministic: retraining on the same data gives the same model.");
  await expect(done.getByTestId("retrain-panel")).toContainText("Retrain only if the dataset has changed.");
  for (const name of ["running", "failed", "refunded", "provider-view"]) {
    await expect(card(page, `Dataset ${name}`).getByRole("button", { name: "Retrain", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Retrain", exact: true })).toHaveCount(1);
});

test("Refund n'apparaît que pour un échec sans modèle livré, avec l'explication", async ({ page }) => {
  await install(page, {
    loans: [
      loan("failed", { status: "ESCROWED", refundable: true }),
      loan("in-time", { status: "ESCROWED", refundable: false }),
      loan("settled", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy", refundable: true }),
      loan("prepared", { status: "TRAINING", modelCid: "bafy", runnerReceipt: "receipt", refundable: true }),
      loan("rescue", { status: "TRAINING", modelCid: "bafy", runnerReceipt: null, refundable: true }),
      loan("settling", { status: "SETTLING", settleTxHash: TX, modelCid: "bafy", runnerReceipt: "receipt", refundable: true }),
      loan("refunded", { status: "CANCELLED", cancelTxHash: TX, refundable: true }),
      loan("provider-view", { status: "ESCROWED", refundable: true, borrower: OTHER, provider: ME }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const failed = card(page, "Dataset failed");
  await expect(failed.getByRole("button", { name: "Refund", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(failed.getByTestId("refund-explanation")).toContainText("no model was delivered");
  await expect(failed.getByTestId("refund-explanation")).toContainText("everything you paid except, where applicable, the compute actually consumed, as measured by the enclave");
  // Échu avec capsule (avec ou sans reçu) et sans release diffusé : le contrat refuse désormais le
  // règlement, remboursement de secours et plus de bouton « Finalize settlement » (audit A-05, A-10).
  for (const name of ["rescue", "prepared"]) {
    const stuck = card(page, `Dataset ${name}`);
    await expect(stuck.getByRole("button", { name: "Refund", exact: true })).toBeVisible();
    await expect(stuck.getByTestId("refund-explanation")).toContainText("settlement can no longer be completed");
    await expect(stuck).toContainText("Failed");
    await expect(stuck.getByRole("button", { name: "Finalize settlement", exact: true })).toHaveCount(0);
  }
  // Release déjà diffusé : réconciliation seulement, jamais de remboursement.
  await expect(card(page, "Dataset settling").getByRole("button", { name: "Reconcile settlement", exact: true })).toBeVisible();
  for (const name of ["in-time", "settled", "settling", "refunded", "provider-view"]) {
    await expect(card(page, `Dataset ${name}`).getByRole("button", { name: "Refund", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Refund", exact: true })).toHaveCount(3);
  await expect(page.getByTestId("refund-explanation")).toHaveCount(3);
});

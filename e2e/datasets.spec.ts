import { expect, test, type Page } from "playwright/test";
import { openLayoutPage } from "./helpers/layout";

const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const CREATED_AT = "2026-10-01T12:00:00.000Z";
const dataset = {
  id: "dataset-valid-draft",
  name: "Valid draft",
  description: null,
  provider: PROVIDER,
  status: "DRAFT",
  category: null,
  ipfsCid: "bafy-fixture",
  merkleRoot: null,
  evmDatasetId: null as string | null,
  evmMintTxHash: null,
  sizeBytes: 15_000,
  metrics: { rowCount: 480, columnCount: 7 },
  modelId: "logistic_regression" as string | null,
  modelVersion: "1.0.0" as string | null,
  priceUsdcAtomic: "20000000000000000000",
  listingExpiresAt: null,
  createdAt: CREATED_AT,
};
type Fixture = typeof dataset;

const fixtures: Fixture[] = [
  dataset,
  { ...dataset, id: "dataset-legacy-draft", name: "Legacy draft", modelId: null, modelVersion: null },
  { ...dataset, id: "dataset-invalid-version", name: "Invalid profile version", modelVersion: "0.1.0" },
  {
    ...dataset, id: "dataset-legacy-deleted", name: "Deleted legacy dataset", status: "DELETED",
    evmDatasetId: `0x${"a".repeat(64)}`, modelId: null, modelVersion: null,
  },
  {
    ...dataset, id: "dataset-legacy-suspended", name: "Suspended legacy dataset", status: "SUSPENDED",
    evmDatasetId: `0x${"b".repeat(64)}`, modelId: null, modelVersion: null,
  },
];

const DISPLAY_STATUS: Record<string, string> = { DRAFT: "pending", DELETED: "destroyed", SUSPENDED: "failed" };

/** Vue du propriétaire telle que la renvoie `GET /api/datasets/[id]/settings`. */
function ownerView(fixture: Fixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    description: fixture.description,
    status: fixture.status,
    displayStatus: DISPLAY_STATUS[fixture.status],
    category: fixture.category,
    modelId: fixture.modelId,
    modelVersion: fixture.modelVersion,
    sizeBytes: fixture.sizeBytes,
    rowCount: fixture.metrics.rowCount,
    columnCount: fixture.metrics.columnCount,
    priceUsdcAtomic: fixture.priceUsdcAtomic,
    ipfsCid: fixture.ipfsCid,
    merkleRoot: fixture.merkleRoot,
    evmDatasetId: fixture.evmDatasetId,
    evmMintTxHash: fixture.evmMintTxHash,
    deletionPending: fixture.status === "DELETED" && fixture.evmDatasetId !== null,
    canRelist: true,
    listedAt: null,
    listingExpiresAt: null,
    listingExpired: false,
    keyDestroyedAt: null,
    consent: { givenAt: null, version: null, revokedAt: null, active: false },
    createdAt: fixture.createdAt,
    updatedAt: fixture.createdAt,
  };
}

const emptyStats = {
  borrowCount: 0, inFlightCount: 0, trainingsSucceeded: 0, trainingsRefunded: 0, earnedAtomic: "0", inEscrowAtomic: "0",
  unreadableAmounts: 0, lastBorrowAt: null, truncated: false, tokenDecimals: 18,
  weekly: Array.from({ length: 8 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 8, 1 + 7 * index)).toISOString(),
    end: new Date(Date.UTC(2026, 8, 8 + 7 * index)).toISOString(),
    count: 0,
  })),
};

/** Carte de la mosaïque : l'élément de liste qui contient le titre du dataset. */
function card(page: Page, name: string) {
  return page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/** Ouvre la fiche depuis la mosaïque (navigation côté client : la session de test est conservée). */
async function openDetail(page: Page, name: string) {
  await card(page, name).getByRole("link", { name, exact: true }).click();
  // Première visite de la route dynamique : `next dev` peut la compiler à ce moment-là.
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function backToMosaic(page: Page) {
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Valid draft", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sirius.locale", "fr");
    localStorage.removeItem("sirius-ui");
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const detail = /^\/api\/datasets\/([^/]+)\/(settings|stats)$/.exec(path);
    if (path === "/api/datasets") {
      await route.fulfill({ json: fixtures });
    } else if (path === "/api/loans") {
      await route.fulfill({ json: [] });
    } else if (detail && route.request().method() === "GET") {
      const fixture = fixtures.find((candidate) => candidate.id === decodeURIComponent(detail[1]));
      if (!fixture) await route.fulfill({ status: 404, json: { error: "Dataset introuvable" } });
      else await route.fulfill({ json: detail[2] === "settings" ? ownerView(fixture) : emptyStats });
    } else if (path === "/api/account/status") {
      await route.fulfill({ json: { known: true } });
    } else {
      await route.abort();
    }
  });
  await openLayoutPage(page, "/datasets", 16);
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), PROVIDER);
  await expect(page.getByRole("heading", { name: "Valid draft", exact: true })).toBeVisible();
});

test("la publication exige un profil valide mais la suppression du brouillon reste accessible", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(card(page, "Valid draft").getByText("Binary logistic regression v1.0.0", { exact: true })).toBeVisible();
  for (const name of ["Legacy draft", "Invalid profile version"]) {
    await expect(card(page, name).getByText("Missing profile", { exact: true })).toBeVisible();
    await expect(card(page, name).getByText(/Legacy dataset without a valid profile/)).toBeVisible();
    // Sur la carte aussi, la publication est bloquée.
    await expect(card(page, name).getByRole("button", { name: "Re-upload required", exact: true })).toBeDisabled();
  }
  await expect(card(page, "Valid draft").getByRole("button", { name: "Publish title", exact: true })).toBeEnabled();

  for (const name of ["Legacy draft", "Invalid profile version"]) {
    await openDetail(page, name);
    // Publication bloquée : profil d'entraînement absent ou inconnu.
    await expect(page.getByRole("button", { name: "Re-upload required", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Publish title", exact: true })).toHaveCount(0);
    // Suppression du brouillon toujours possible, derrière la double confirmation.
    await page.getByRole("button", { name: "Destroy this dataset…", exact: true }).click();
    const confirm = page.getByRole("button", { name: "Destroy permanently", exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/To confirm, type the dataset name/).fill(name);
    await expect(confirm).toBeEnabled();
    await backToMosaic(page);
  }

  await openDetail(page, "Valid draft");
  await expect(page.getByRole("button", { name: "Publish title", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Destroy this dataset…", exact: true })).toBeEnabled();
});

test("un ancien dataset suspendu peut être supprimé sans être remis en publication", async ({ page }) => {
  await expect(card(page, "Suspended legacy dataset").getByText(/Archived by Sirius/)).toBeVisible();
  await openDetail(page, "Suspended legacy dataset");
  await expect(page.getByRole("button", { name: "Destroy this dataset…", exact: true })).toBeEnabled();
  for (const name of ["Publish title", "Put back online", "Pause", "Make private"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
});

test("une erreur de finalisation garde la fiche et permet de réessayer", async ({ page }) => {
  await page.route("**/api/datasets/dataset-legacy-deleted", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ status: 503, json: { error: "Contrats EVM Sirius indisponibles ou incompatibles" } });
  });
  await expect(card(page, "Deleted legacy dataset").getByText("Deletion to finalize.", { exact: true })).toBeVisible();
  await openDetail(page, "Deleted legacy dataset");
  await expect(page.getByText(/current EVM registry/)).toBeVisible();
  await page.getByRole("button", { name: "Finalize deletion…", exact: true }).click();
  await page.getByLabel(/To confirm, type the dataset name/).fill("Deleted legacy dataset");
  await page.getByRole("button", { name: "Finalize deletion", exact: true }).click();
  await expect(page.getByText("Sirius EVM contracts are unavailable or incompatible", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize deletion…", exact: true })).toBeEnabled();
});

import { expect, test, type Page, type Route } from "playwright/test";
import { formatUsdcAtomic, USDC_DECIMALS } from "@/lib/evm/usdc";

const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";

/**
 * Les montants se dérivent de la précision du jeton au lieu d'être écrits en atomes.
 *
 * L'USDC du testnet Robinhood expose 18 décimales, celui de référence en expose 6.
 * Un « 1750000 » figé ici valait 1,75 USDC sous l'ancienne hypothèse et s'affiche
 * « 0.00000000000175 » sous la nouvelle — un test rouge qui accuse l'interface alors
 * que c'est la fixture qui a vieilli. En passant par les mêmes fonctions que
 * l'application, le test ne peut plus diverger d'elle en silence.
 */
function usdc(montant: string): string {
  const [entier, decimales = ""] = montant.split(".");
  return (BigInt(entier) * BigInt(10) ** BigInt(USDC_DECIMALS)
    + BigInt(decimales.padEnd(USDC_DECIMALS, "0") || "0")).toString();
}

const PRIX_ATOMIQUE = usdc("1.75");
const PRIX_AFFICHE = `${formatUsdcAtomic(PRIX_ATOMIQUE)} USDC`;

interface DatasetFixture {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: "LISTED";
  sizeBytes: number;
  priceUsdcAtomic: string;
  challengeDays: number;
  metrics: { rowCount: number; columnCount: number };
}

const listedDataset: DatasetFixture = {
  id: "dataset-listed",
  name: "Mobilité urbaine Europe",
  description: "Trajets agrégés par zone",
  provider: PROVIDER,
  status: "LISTED",
  sizeBytes: 1_250_000,
  priceUsdcAtomic: PRIX_ATOMIQUE,
  challengeDays: 7,
  metrics: { rowCount: 48_000, columnCount: 24 },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function connect(page: Page, address: string, role: "provider" | "borrower") {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate(
    ({ wallet, walletRole }) => window.__SIRIUS_E2E__?.connect(wallet, walletRole),
    { wallet: address, walletRole: role },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("sirius-ui");
    localStorage.removeItem("sirius-favorites");
  });
});

test("affiche le tableau de bord EVM d'un wallet authentifié", async ({ page }) => {
  await page.route("**/api/reputation", (route) => json(route, {
    provider: { score: 50, completedLoans: 3, cancelledEscrows: 0, evidenceCount: 3 },
    borrower: { score: 25, completedLoans: 1, cancelledEscrows: 0, evidenceCount: 1 },
  }));

  await page.goto("/dashboard");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("EVM trust")).toBeVisible();
  await page.getByRole("link", { name: "Marketplace" }).first().click();
  await expect(page).toHaveURL(/\/marketplace$/);
});

/** Carte de la réponse publique `GET /api/marketplace` (facturation v6 : le total est le prix du dataset). */
function catalogueItem(dataset: DatasetFixture) {
  return {
    id: dataset.id, name: dataset.name, category: "mobility", modelId: "linear_regression", modelVersion: "1.0.0",
    rowCount: dataset.metrics.rowCount, columnCount: dataset.metrics.columnCount, sizeBytes: dataset.sizeBytes,
    providerPriceAtomic: dataset.priceUsdcAtomic, priceAtomic: dataset.priceUsdcAtomic, priceKind: "borrowerPays",
    borrowCount: 0, verified: true, listedAt: "2026-10-01T00:00:00.000Z",
  };
}

function catalogue(items: unknown[]) {
  return {
    items, total: items.length, page: 1, pageCount: 1, pageSize: 24, truncated: false,
    token: { symbol: "USDC", decimals: USDC_DECIMALS }, kybAvailable: true,
    computeFees: { linear_regression: { kind: "none", atomic: "0" }, logistic_regression: { kind: "none", atomic: "0" } },
  };
}

test("priorise les favoris du catalogue USDC", async ({ page }) => {
  const another = { ...listedDataset, id: "dataset-other", name: "Crédit PME France", priceUsdcAtomic: usdc("2.5") };
  await page.route((url) => url.pathname === "/api/marketplace", (route) => json(route, catalogue([catalogueItem(another), catalogueItem(listedDataset)])));

  await page.goto("/marketplace");
  await expect(page.getByText("Crédit PME France")).toBeVisible();
  // Montant affiché par la carte partagée : au moins deux décimales, symbole du jeton renvoyé par l'API.
  await expect(page.getByText("1.75 USDC", { exact: true })).toBeVisible();
  expect(PRIX_AFFICHE).toBe("1.75 USDC");

  const targetCard = page.getByRole("listitem").filter({ hasText: "Mobilité urbaine Europe" });
  await targetCard.getByRole("button", { name: "Add to favorites" }).click();
  await expect(page.locator("main h3").first()).toHaveText("Mobilité urbaine Europe");
});

test("présente des preuves vérifiables sur EVM", async ({ page }) => {
  const lockTxHash = `0x${"a".repeat(64)}`;
  const settleTxHash = `0x${"b".repeat(64)}`;
  const mintTxHash = `0x${"c".repeat(64)}`;
  await page.route("**/api/audit", (route) => json(route, {
    network: "testnet",
    loans: [{
      id: "loan-audit",
      borrower: BORROWER,
      provider: PROVIDER,
      amountUsdcAtomic: PRIX_ATOMIQUE,
      status: "SETTLED",
      evmLockTxHash: lockTxHash,
      settleTxHash,
      auditReceipt: null,
      cancelTxHash: null,
      attestationHash: "d".repeat(64),
      attestationComposeHash: null,
      evmDeadline: "2026-08-10T12:00:00.000Z",
      createdAt: "2026-08-03T12:00:00.000Z",
      settledAt: "2026-08-03T12:05:00.000Z",
      dataset: {
        name: listedDataset.name,
        evmDatasetId: `0x${"e".repeat(64)}`,
        evmMintTxHash: mintTxHash,
      },
    }],
  }));

  await page.goto("/explorer");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();
  await expect(page.getByText(`${formatUsdcAtomic(PRIX_ATOMIQUE)} test USDC`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Verify Lock USDC on EVM" }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${lockTxHash}`);
  await expect(page.getByRole("link", { name: "Verify Release USDC on EVM" }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${settleTxHash}`);
});

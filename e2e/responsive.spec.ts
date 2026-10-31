import { expect, test, type Page } from "playwright/test";
import { openLayoutPage } from "./helpers/layout";

const WALLET = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const LONG_NAME = `Dataset_${"credit_default_".repeat(12)}`;
const SCREENS = [
  ...[320, 390, 640, 768, 1024, 1440].map((width) => ({ name: `${width}px`, width, fontSize: 16 })),
  { name: "390px, texte agrandi", width: 390, fontSize: 20 },
];

const dataset = {
  id: "responsive-logistic",
  name: "credit default",
  description: `Provenance_${"donnees_synthetiques_".repeat(15)}`,
  provider: PROVIDER,
  status: "LISTED",
  sizeBytes: 13_517,
  priceUsdcAtomic: "10000000000000000000",
  challengeDays: 7,
  metrics: { rowCount: 480, columnCount: 7 },
  modelId: "logistic_regression",
  modelVersion: "1.0.0",
  ipfsCid: "bafy-layout-fixture",
  evmDatasetId: `0x${"a".repeat(64)}`,
  runnerReceipt: "layout-fixture",
};

const linearDataset = {
  ...dataset,
  id: "responsive-linear",
  name: "Energy-demand-Test",
  description: "Jeu de données de consommation énergétique",
  modelId: "linear_regression",
};

const loans = ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING", "SETTLED", "CANCELLED"].map((status) => ({
  id: `responsive-loan-${status}`,
  datasetId: dataset.id,
  borrower: WALLET,
  dataset: { name: `${status} ${LONG_NAME}`, runnerReceipt: dataset.runnerReceipt },
  amountUsdcAtomic: dataset.priceUsdcAtomic,
  modelId: dataset.modelId,
  modelVersion: dataset.modelVersion,
  status,
  evmLockTxHash: null,
  evmLoanKey: status === "PENDING" || status === "SUBMITTING" ? null : `0x${"9".repeat(64)}`,
  settleTxHash: status === "SETTLED" ? `0x${"e".repeat(64)}` : null,
  cancelTxHash: null,
  modelCid: status === "SETTLING" ? "bafy-layout-model" : null,
  runnerReceipt: status === "SETTLING" ? "layout-fixture" : null,
  evmDeadline: "2026-09-12T12:00:00.000Z",
  createdAt: "2026-09-05T12:00:00.000Z",
  refundable: false,
}));

/** Réponse de `GET /api/marketplace` (facturation v6 : le total affiché est le prix du dataset). */
function catalogueBody(datasets: Array<typeof dataset>) {
  const items = datasets.map((entry) => ({
    id: entry.id,
    name: entry.name,
    category: "finance",
    modelId: entry.modelId,
    modelVersion: entry.modelVersion,
    rowCount: entry.metrics.rowCount,
    columnCount: entry.metrics.columnCount,
    sizeBytes: entry.sizeBytes,
    providerPriceAtomic: entry.priceUsdcAtomic,
    priceAtomic: entry.priceUsdcAtomic,
    priceKind: "borrowerPays",
    borrowCount: 12_345,
    verified: true,
    listedAt: "2026-09-05T12:00:00.000Z",
  }));
  return {
    items, total: items.length, page: 1, pageCount: 1, pageSize: 24, truncated: false,
    token: { symbol: "USDC", decimals: 18 }, kybAvailable: true,
    computeFees: { linear_regression: { kind: "none", atomic: "0" }, logistic_regression: { kind: "none", atomic: "0" } },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("sirius-favorites");
    localStorage.removeItem("sirius-ui");
  });
  // Aucun appel non simulé ne doit atteindre la base, le runner ou la chaîne.
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    switch (url.pathname) {
      case "/api/marketplace":
        body = catalogueBody([dataset, linearDataset]);
        break;
      case `/api/marketplace/${dataset.id}`:
      case `/api/marketplace/${linearDataset.id}`:
        body = {
          dataset: {
            ...catalogueBody([linearDataset]).items[0],
            description: dataset.description,
            provider: PROVIDER,
            challengeDays: 3,
            settledCount: 1,
            refundedCount: 0,
            successRate: 1,
            computeFee: { kind: "none", atomic: "0" },
          },
          token: { symbol: "USDC", decimals: 18 },
          kybAvailable: true,
          billingMode: "v6",
        };
        break;
      case "/api/datasets":
        body = url.searchParams.has("status")
          ? [dataset, linearDataset]
          : [
            { ...dataset, name: LONG_NAME, provider: WALLET },
            { ...linearDataset, provider: WALLET },
            { ...dataset, id: "responsive-draft", name: `Brouillon ${LONG_NAME}`, status: "DRAFT", ipfsCid: null },
          ];
        break;
      case "/api/admin/me":
        body = { admin: true };
        break;
      case "/api/account/status":
        body = { known: true };
        break;
      case "/api/loans":
        body = [
          ...loans,
          { ...loans[2], id: "responsive-refundable", dataset: { name: `Remboursable ${LONG_NAME}` }, refundable: true },
        ];
        break;
      case "/api/train":
        body = [{
          id: "responsive-self-job",
          dataset: { name: `Self-train ${LONG_NAME}` },
          status: "DONE",
          modelId: dataset.modelId,
          modelVersion: dataset.modelVersion,
          modelCid: "bafy-layout-model",
          runnerReceipt: null,
          metrics: { accuracy: 0.812345 },
          createdAt: "2026-09-05T12:00:00.000Z",
        }];
        break;
      case "/api/audit":
        body = {
          network: "testnet",
          loans: [{
            ...loans[5],
            borrower: WALLET,
            provider: PROVIDER,
            dataset: { name: LONG_NAME, evmDatasetId: dataset.evmDatasetId, evmMintTxHash: `0x${"b".repeat(64)}` },
            evmLockTxHash: `0x${"c".repeat(64)}`,
            settleTxHash: `0x${"d".repeat(64)}`,
            auditReceipt: null,
            attestationHash: "e".repeat(64),
            attestationComposeHash: null,
            settledAt: "2026-09-05T12:01:00.000Z",
          }],
        };
        break;
      default:
        await route.abort();
        return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
});

async function connect(page: Page) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "borrower"), WALLET);
}

async function expectContainedLayout(page: Page) {
  const issues = await page.locator("main").evaluate((main) => {
    const issues: string[] = [];
    const visible = (element: Element) => element.getClientRects().length > 0;
    const describe = (element: Element) => `${element.tagName}: ${element.textContent?.trim().slice(0, 65)}`;
    const elements = main.querySelectorAll("h1,h2,h3,p,span,dl,dt,dd,input,select,button,a,code");
    for (const element of elements) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      let card = element.parentElement;
      while (card && card !== main && !card.classList.contains("bg-surface/50")) card = card.parentElement;
      const bounds = (card ?? main).getBoundingClientRect();
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
        issues.push(`Hors carte : ${describe(element)}`);
      }
      if (rect.left < -1 || rect.right > window.innerWidth + 1) {
        issues.push(`Hors écran : ${describe(element)}`);
      }
      const style = getComputedStyle(element);
      if (!["INPUT", "SELECT"].includes(element.tagName) && style.display !== "inline" && style.textOverflow !== "ellipsis"
        && element.scrollWidth > element.clientWidth + 1) {
        issues.push(`Texte débordant : ${describe(element)}`);
      }
    }
    for (const parent of main.querySelectorAll("div,dl")) {
      if (!["flex", "inline-flex", "grid"].includes(getComputedStyle(parent).display)) continue;
      const children = [...parent.children].filter(visible);
      for (let i = 0; i < children.length; i++) {
        const left = children[i].getBoundingClientRect();
        for (const other of children.slice(i + 1)) {
          const right = other.getBoundingClientRect();
          const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          if (overlapX > 1 && overlapY > 1) {
            issues.push(`Chevauchement : ${describe(children[i])} / ${describe(other)}`);
          }
        }
      }
    }
    return issues;
  });
  expect(issues, `Affichage à ${page.viewportSize()?.width}px`).toEqual([]);
}

for (const screen of SCREENS) {
  test.describe(`responsive : ${screen.name}`, () => {
    test.use({ viewport: { width: screen.width, height: 900 } });

    test("les profils du catalogue restent dans leur carte", async ({ page }) => {
      await openLayoutPage(page, "/marketplace", screen.fontSize);
      await expect(page.getByRole("heading", { name: dataset.name, exact: true })).toBeVisible();
      await expect(page.getByText("Binary logistic regression v1.0.0", { exact: true })).toBeVisible();
      await expectContainedLayout(page);

      const card = page.getByRole("listitem").filter({ hasText: linearDataset.name });
      await card.getByRole("button", { name: "Add to favorites" }).click();
      await expect(card.getByRole("button", { name: "Remove from favorites" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("main h3").first()).toHaveText(linearDataset.name);
      // L'emprunt se fait depuis la fiche, lisible et contenue à toutes les largeurs.
      await card.getByRole("link", { name: linearDataset.name }).click();
      await expect(page.getByRole("heading", { name: linearDataset.name, level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "Borrow", exact: true })).toBeEnabled();
      await expectContainedLayout(page);
    });

    test("titres et actions des datasets ne se chevauchent pas", async ({ page }) => {
      await openLayoutPage(page, "/datasets", screen.fontSize);
      await connect(page);
      await expect(page.getByRole("heading", { name: LONG_NAME, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Incomplete upload" })).toBeDisabled();
      await expectContainedLayout(page);
    });

    test("tous les états des prêts et la récupération du lock restent lisibles", async ({ page }) => {
      await openLayoutPage(page, "/train", screen.fontSize);
      await connect(page);
      await expect(page.getByRole("heading", { name: `PENDING ${LONG_NAME}`, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: `Self-train ${LONG_NAME}`, exact: true })).toBeVisible();
      await expectContainedLayout(page);

      const pending = page.getByRole("heading", { name: `PENDING ${LONG_NAME}`, exact: true }).locator("../../../..");
      await expect(pending.getByRole("button", { name: "Recover lock" })).toBeDisabled();
      await pending.getByPlaceholder("Lock transaction hash").fill(`0x${"f".repeat(64)}`);
      await expect(pending.getByRole("button", { name: "Recover lock" })).toBeEnabled();
      await expectContainedLayout(page);

      // Catalogue retiré de la page Train : l'emprunt part de la marketplace.
      await expect(page.getByRole("button", { name: "Borrow", exact: true })).toHaveCount(0);
      const refundable = page.getByRole("heading", { name: `Remboursable ${LONG_NAME}`, exact: true }).locator("../../../..");
      await expect(refundable.getByRole("button", { name: "Refund", exact: true })).toBeVisible();
      await expect(refundable.getByTestId("refund-explanation")).toBeVisible();
      await expectContainedLayout(page);

      const settled = page.getByRole("heading", { name: `SETTLED ${LONG_NAME}`, exact: true }).locator("../../../..");
      await settled.getByRole("button", { name: "Retrain", exact: true }).click();
      await expect(settled.getByRole("button", { name: "View the quote and retrain" })).toBeVisible();
      await expectContainedLayout(page);
    });

    test("le sélecteur de profil, le fichier et son contrôle restent dans le formulaire", async ({ page }) => {
      await openLayoutPage(page, "/datasets/new", screen.fontSize);
      await page.getByLabel("Training profile").selectOption("logistic_regression");
      await page.locator('input[type="file"]').setInputFiles({
        name: `${LONG_NAME}.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from("feature,target\n1,0\n2,1\n"),
      });
      await expect(page.getByLabel("Training profile")).toHaveValue("logistic_regression");
      await expect(page.getByLabel("Training profile").locator("option:checked")).toHaveText("Binary logistic regression · v1.0.0");
      await expect(page.getByText("— 480 training rows, separate test set.")).toBeVisible();
      // Le contrôle du navigateur refuse le fichier avec sa raison, sans sortir de la carte.
      await expect(page.locator("main").getByRole("alert")).toHaveText("Not enough rows: 2, minimum 100 for this number of features.");
      await expect(page.getByText(`${LONG_NAME}.csv`)).toBeVisible();
      await expectContainedLayout(page);
    });

    test("les preuves d’audit restent dans leur carte", async ({ page }) => {
      await openLayoutPage(page, "/explorer", screen.fontSize);
      await connect(page);
      await expect(page.getByRole("heading", { name: LONG_NAME, exact: true })).toBeVisible();
      await expectContainedLayout(page);
      await expect(page.getByRole("link", { name: "Verify Lock USDC on EVM" }))
        .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/0x${"c".repeat(64)}`);
    });
  });
}

// N3 — Marketplace publique : grille, filtres et fiche lisibles sans wallet, emprunt depuis la fiche.
// Toutes les routes API sont simulées : aucun appel ne doit atteindre la base, le runner ou la chaîne.
import { expect, test, type Page, type Request, type Route } from "playwright/test";

const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const DECIMALS = 18;
const E18 = BigInt(10) ** BigInt(DECIMALS);
const PRICE = (BigInt(175) * E18 / BigInt(100)).toString(); // 1.75 USDC
const COMPUTE = (BigInt(3) * E18).toString();
const TOKEN = { symbol: "USDC", decimals: DECIMALS };

const item = {
  id: "dataset-public", name: "Mobilité urbaine Europe", category: "mobility", modelId: "linear_regression", modelVersion: "1.0.0",
  rowCount: 4_800, columnCount: 24, sizeBytes: 1_250_000, providerPriceAtomic: PRICE,
  priceAtomic: (BigInt(PRICE) + BigInt(COMPUTE)).toString(), priceKind: "borrowerPays", borrowCount: 7, verified: true,
  listedAt: "2026-10-01T00:00:00.000Z",
};
const other = { ...item, id: "dataset-finance", name: "Crédit PME France", category: "finance", verified: false, borrowCount: 2 };

function catalogue(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    items, total: items.length, page: 1, pageCount: 1, pageSize: 24, truncated: false, token: TOKEN, kybAvailable: true,
    computeFees: { linear_regression: { kind: "quoted", atomic: COMPUTE }, logistic_regression: { kind: "quoted", atomic: COMPUTE } },
    ...extra,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    dataset: {
      ...item, description: "Trajets agrégés par zone\n<script>alert(1)</script>", provider: PROVIDER, challengeDays: 3,
      settledCount: 3, refundedCount: 1, successRate: 0.75, computeFee: { kind: "quoted", atomic: COMPUTE }, ...overrides,
    },
    token: TOKEN,
    kybAvailable: true,
    billingMode: "v7",
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Simule l'API et enregistre chaque appel ; tout chemin inattendu reçoit une 404. */
async function installApi(page: Page, handlers: Record<string, (url: URL) => { body: unknown; status?: number }>) {
  const requests: Request[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    const handler = handlers[url.pathname];
    if (!handler) return json(route, { error: "non simulé" }, 404);
    const { body, status } = handler(url);
    return json(route, body, status);
  });
  return requests;
}

const paths = (requests: Request[]) => requests.map((request) => `${request.method()} ${new URL(request.url()).pathname}`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("sirius-ui");
    localStorage.removeItem("sirius-favorites");
  });
});

test("sans wallet : la grille et la fiche se lisent, aucun appel privé n'est fait", async ({ page }) => {
  const requests = await installApi(page, {
    "/api/marketplace": () => ({ body: catalogue([item, other]) }),
    [`/api/marketplace/${item.id}`]: () => ({ body: detail() }),
  });
  await page.goto("/marketplace");
  await expect(page.getByRole("heading", { name: "Available datasets" })).toBeVisible();
  const card = page.getByRole("listitem").filter({ hasText: item.name });
  await expect(card.getByText("4.75 USDC", { exact: true })).toBeVisible();
  await expect(card.getByText("Verified provider")).toBeVisible();
  await expect(card.getByText("Mobility")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: other.name }).getByText("Unverified provider")).toBeVisible();
  await expect(page.getByText("Prices include each model's indicative compute fee")).toBeVisible();

  await card.getByRole("link", { name: item.name }).click();
  // Premier passage en développement : la route de la fiche se compile pendant la navigation.
  await expect(page).toHaveURL(new RegExp(`/marketplace/${item.id}$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: item.name, level: 1 })).toBeVisible();
  // La description est rendue comme du texte, jamais comme du HTML.
  await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
  const price = page.getByRole("region", { name: "Price breakdown" });
  await expect(price.getByText("Provider receives")).toBeVisible();
  await expect(price.getByText("1.75 USDC", { exact: true })).toBeVisible();
  await expect(price.getByText("3.00 USDC", { exact: true })).toBeVisible();
  await expect(price.getByText("4.75 USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("75% (3 of 4 completed loans)")).toBeVisible();
  await expect(page.getByText("If the loan is not settled after 3 days, you can recover your funds from the Train page.")).toBeVisible();
  await expect(page.getByText("Each new training is a new loan.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "View the on-chain proof" })).toHaveAttribute("href", `/proof/${item.id}`);
  await expect(page.getByText("0x930f…318b")).toBeVisible();
  await expect(page.getByRole("link", { name: "sirius.data.contact@gmail.com" })).toHaveAttribute("href", "mailto:sirius.data.contact@gmail.com");

  // La connexion n'est demandée qu'au clic : sans wallet installé, le clic l'annonce, rien ne part.
  await page.getByRole("button", { name: "Borrow" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No wallet detected" })).toBeVisible();
  const called = paths(requests);
  for (const forbidden of ["GET /api/loans", "POST /api/loans", "GET /api/account/status", "GET /api/datasets"]) {
    expect(called, forbidden).not.toContain(forbidden);
  }
  // Aucune lecture publique ne transporte d'identifiant de wallet.
  for (const request of requests) expect(request.url()).not.toContain("address=");
});

test("filtres : catégorie, modèle, recherche, vérifiés, fourchettes et tri passent à l'API et à l'URL", async ({ page }) => {
  const requests = await installApi(page, {
    "/api/marketplace": (url) => ({ body: catalogue(url.searchParams.get("category") === "finance" ? [other] : [item, other]) }),
  });
  await page.goto("/marketplace");
  await expect(page.getByRole("listitem")).toHaveCount(2);
  const lastQuery = () => new URL(requests.filter((r) => new URL(r.url()).pathname === "/api/marketplace").at(-1)!.url()).searchParams;

  await page.getByRole("combobox", { name: "Category" }).selectOption("finance");
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("finance");
  await expect(page).toHaveURL(/category=finance/);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  expect(lastQuery().get("category")).toBe("finance");

  await page.getByRole("combobox", { name: "Model" }).selectOption("logistic_regression");
  await expect(page).toHaveURL(/model=logistic_regression/);

  // Frappe interrompue par l'envoi de la recherche : aucun caractère perdu, le champ ne se vide pas.
  const search = page.getByRole("searchbox", { name: "Search datasets" });
  await search.pressSequentially("crédit");
  await expect(page).toHaveURL(/q=cr%C3%A9dit(&|$)/);
  await expect(search).toHaveValue("crédit");
  await search.pressSequentially(" pme", { delay: 150 });
  await expect(search).toHaveValue("crédit pme");
  await expect(page).toHaveURL(/q=cr%C3%A9dit\+pme|q=cr%C3%A9dit%20pme/);
  await expect(search).toHaveValue("crédit pme");
  expect(lastQuery().get("q")).toBe("crédit pme");

  await page.getByRole("checkbox", { name: "Verified providers only" }).click();
  await expect(page.getByRole("checkbox", { name: "Verified providers only" })).toBeChecked();
  await expect(page).toHaveURL(/verified=1/);

  await page.getByRole("button", { name: "Total price (USDC)" }).click();
  const priceRange = page.getByRole("group", { name: "Total price (USDC)" });
  await priceRange.getByPlaceholder("Min").fill("1.5");
  await priceRange.getByPlaceholder("Max").fill("20");
  await priceRange.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/minPrice=1\.5/);
  await expect(page).toHaveURL(/maxPrice=20/);

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("price");
  await expect(page).toHaveURL(/sort=price/);
  expect(lastQuery().get("sort")).toBe("price");
  expect(lastQuery().get("category")).toBe("finance");

  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/marketplace\?sort=price$/);
  // La réinitialisation vide aussi le champ, et la recherche effacée n'est pas renvoyée ensuite.
  await expect(search).toHaveValue("");
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/marketplace\?sort=price$/);
});

test("une erreur de paramètre est affichée, un dataset hors ligne a une fiche d'absence", async ({ page }) => {
  await installApi(page, {
    "/api/marketplace": () => ({ body: { error: "Prix invalide" }, status: 400 }),
    "/api/marketplace/dataset-paused": () => ({ body: { error: "Dataset introuvable" }, status: 404 }),
  });
  await page.goto("/marketplace?minPrice=abc");
  await expect(page.getByRole("alert").filter({ hasText: "Invalid price" })).toBeVisible();
  await page.goto("/marketplace/dataset-paused");
  await expect(page.getByRole("heading", { name: "Dataset unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Borrow" })).toHaveCount(0);
});

test("fournisseur sans KYB valide et facturation v6 : emprunt désactivé, texte d'échec adapté", async ({ page }) => {
  await installApi(page, {
    [`/api/marketplace/${item.id}`]: () => ({ body: { ...detail({ verified: false, computeFee: { kind: "none", atomic: "0" } }), billingMode: "v6" } }),
  });
  await page.goto(`/marketplace/${item.id}`);
  await expect(page.getByRole("button", { name: "Borrow" })).toBeDisabled();
  await expect(page.getByText("Borrowing unavailable: the provider’s verification attestation is missing or expired.")).toBeVisible();
  await expect(page.getByText("No compute fee is charged: the locked amount is returned in full.", { exact: false })).toBeVisible();
  await expect(page.getByText("Only the compute actually consumed is retained", { exact: false })).toHaveCount(0);
});

test("frais de calcul inconnus : la fiche n'invente pas de total et renvoie au devis", async ({ page }) => {
  await installApi(page, {
    [`/api/marketplace/${item.id}`]: () => ({ body: detail({ computeFee: { kind: "unknown", atomic: null }, priceAtomic: PRICE, priceKind: "providerReceives", verified: null, successRate: null, settledCount: 0, refundedCount: 0 }) }),
  });
  await page.goto(`/marketplace/${item.id}`);
  await expect(page.getByText("Shown in the quote", { exact: true })).toBeVisible();
  await expect(page.getByText("1.75 USDC", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Price breakdown" })).toHaveCount(0);
  await expect(page.getByText("No completed loan yet")).toBeVisible();
  await expect(page.getByText("Status unavailable")).toBeVisible();
});

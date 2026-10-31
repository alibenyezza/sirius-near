import { expect, test, type Page } from "playwright/test";

const ADDRESS = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";
const SHORT = "0x2f9B…D13D";

test.describe.configure({ timeout: 90_000 });

async function openApp(page: Page, path: string) {
  await page.route("**/api/**", (route) => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.addInitScript(() => {
    // Solde de 12,5 jetons (18 décimales sur le testnet) pour la lecture du bouton profil.
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_call") return `0x${(BigInt(125) * BigInt(10) ** BigInt(17)).toString(16).padStart(64, "0")}`;
          if (method === "eth_getBalance") return "0x0";
          return [];
        },
      },
    });
  });
  await page.goto(path);
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), ADDRESS);
}

test("le menu latéral n'a plus de lien Wallet", async ({ page }) => {
  await openApp(page, "/explorer");
  await expect(page.locator("aside").getByRole("link", { name: "Wallet", exact: true })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("link", { name: "Explorer", exact: true })).toBeVisible();
});

test("le bouton profil donne le réseau, l'adresse, le solde et les liens, puis mène au Wallet", async ({ page }) => {
  await openApp(page, "/explorer");
  const button = page.getByTestId("profile-button");
  await expect(button).toContainText(SHORT);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();

  const panel = page.getByRole("dialog", { name: "Profile menu" });
  await expect(panel.getByTestId("network-badge")).toHaveText("Robinhood Chain testnet");
  await expect(panel.getByTestId("network-badge")).toHaveAttribute("data-network", "testnet");
  await expect(panel.getByTestId("profile-address")).toHaveText(SHORT);
  await expect(panel.getByTestId("profile-balance")).toHaveText("12.5 test USDC");
  const explorer = panel.getByRole("link", { name: "Explorer", exact: true });
  await expect(explorer).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/address/${ADDRESS}`);
  await expect(explorer).toHaveAttribute("rel", "noopener noreferrer");
  await expect(panel.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "/settings");
  await expect(panel.getByRole("link", { name: "Verification", exact: true })).toHaveAttribute("href", "/kyb");
  await expect(panel.getByRole("button", { name: "Guided tour", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Log out", exact: true })).toBeVisible();

  await panel.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page).toHaveURL(/\/wallet$/);
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
});

test("Échap ferme le menu et rend le focus au bouton", async ({ page }) => {
  await openApp(page, "/explorer");
  await page.getByTestId("profile-button").click();
  const panel = page.getByRole("dialog", { name: "Profile menu" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("profile-button")).toBeFocused();
});

test("« Guided tour » relance le guide Sirio depuis l'accueil, sans message « bientôt disponible »", async ({ page }) => {
  // Le guide est neutralisé dans la suite e2e sauf marqueur explicite ; ici il a déjà été passé,
  // et la visite de la page Explorer déjà vue : seule la relance doit le faire réapparaître, à sa première étape.
  await page.addInitScript(() => {
    localStorage.setItem("sirius-guide-e2e", "1");
    localStorage.setItem("sirius-guide:anonymous", JSON.stringify({ v: 1, arrivalSeen: true, tourIndex: 0, tourDone: false, skipped: true, minimized: false, pages: { explorer: true } }));
  });
  await openApp(page, "/explorer");
  const guide = page.getByRole("region", { name: "Sirio, the Sirius guide" });
  await expect(page.getByTestId("guide-bubble")).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByTestId("profile-button").click();
  await page.getByRole("button", { name: "Guided tour", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-phase", "arrival");
  await expect(guide.getByRole("heading", { name: "Hi, I’m Sirio." })).toBeVisible();
  await expect(guide.getByRole("button", { name: "Let’s go", exact: true })).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(page.getByText("The guided tour will be available soon.")).toHaveCount(0);
});

test("accueil passé : Sirio fait la visite de la page Explorer à la première ouverture, puis la note vue", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sirius-guide-e2e", "1");
    localStorage.setItem("sirius-guide:anonymous", JSON.stringify({ v: 1, arrivalSeen: true, tourIndex: 0, tourDone: false, skipped: true, minimized: false }));
  });
  await openApp(page, "/explorer");
  const guide = page.getByRole("region", { name: "Sirio, the Sirius guide" });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-phase", "page");
  await expect(guide).toHaveAttribute("data-page", "explorer");
  await expect(guide.getByRole("heading", { name: "Explorer" })).toBeVisible();
  // Arrêt suivant : le résumé en chiffres, mis en lumière par le voile.
  await page.getByTestId("guide-page-next").click();
  await expect(guide.getByRole("heading", { name: "In numbers" })).toBeVisible();
  await expect(page.locator("[data-guide-spotlight]")).toBeVisible();
  await page.getByTestId("guide-page-skip").click();
  await expect(guide).toHaveCount(0);
  // Page notée vue : la visite ne se rouvre pas d'elle-même, le bouton « ? » la rejoue.
  await page.reload();
  await expect(page.getByTestId("guide-bubble")).toBeVisible();
  await expect(guide).toHaveCount(0);
  await page.getByTestId("guide-page-help").click();
  await expect(guide).toHaveAttribute("data-phase", "page");
});

test("un abonné à l'événement de visite guidée est prévenu et le menu se ferme", async ({ page }) => {
  await openApp(page, "/explorer");
  await page.evaluate(() => {
    (window as unknown as { tourStarts: number }).tourStarts = 0;
    window.addEventListener("sirius:guided-tour:start", (event) => {
      event.preventDefault();
      (window as unknown as { tourStarts: number }).tourStarts += 1;
    });
  });
  await page.getByTestId("profile-button").click();
  await page.getByRole("button", { name: "Guided tour", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { tourStarts: number }).tourStarts)).toBe(1);
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
});

test("sur testnet, la page Wallet garde le faucet et n'affiche pas de QR code de réception", async ({ page }) => {
  await openApp(page, "/wallet");
  await expect(page.getByRole("button", { name: "Add funds", exact: true })).toBeVisible();
  await expect(page.getByTestId("receive-funds")).toHaveCount(0);
  await expect(page.getByTestId("receive-qr")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View on explorer", exact: true }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/address/${ADDRESS}`);
});

test("sans connexion, aucun bouton profil", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.goto("/explorer");
  await expect(page.getByTestId("profile-button")).toHaveCount(0);
});

for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 800 }]) {
  test(`le bouton profil ne recouvre pas le contenu de la page à ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page, "/explorer");
    const button = await page.getByTestId("profile-button").boundingBox();
    const main = await page.locator("main").boundingBox();
    expect(button && main && button.y + button.height <= main.y + 1).toBe(true);
  });
}

test("wallet sur un autre réseau : avertissement, solde masqué et aucune lecture du solde", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.addInitScript((address) => {
    const calls = { eth_call: 0 };
    (window as unknown as { walletCalls: typeof calls }).walletCalls = calls;
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        async request({ method }: { method: string }) {
          // 0x1237 = 4663, le mainnet, alors que le site est sur testnet.
          if (method === "eth_chainId") return "0x1237";
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
          if (method === "eth_call") { calls.eth_call += 1; return `0x${"0".repeat(64)}`; }
          if (method === "eth_getBalance") return "0x0";
          return [];
        },
        on() {},
        removeListener() {},
      },
    });
  }, ADDRESS.toLowerCase());
  await page.goto("/explorer");
  await page.getByTestId("profile-button").click();
  const panel = page.getByRole("dialog", { name: "Profile menu" });
  await expect(panel.getByRole("alert")).toHaveText("Wrong network — switch your wallet to testnet.");
  await expect(panel.getByTestId("profile-balance")).toHaveText("—");
  // Le badge reste celui du site, pas celui du wallet.
  await expect(panel.getByTestId("network-badge")).toHaveAttribute("data-network", "testnet");
  expect(await page.evaluate(() => (window as unknown as { walletCalls: { eth_call: number } }).walletCalls.eth_call)).toBe(0);
});

test("une déconnexion externe ferme le menu : la reconnexion ne le rouvre pas tout seul", async ({ page }) => {
  await openApp(page, "/explorer");
  await page.getByTestId("profile-button").click();
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toBeVisible();
  await page.evaluate(() => window.__SIRIUS_E2E__?.disconnect());
  await expect(page.getByTestId("profile-button")).toHaveCount(0);
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), ADDRESS);
  await expect(page.getByTestId("profile-button")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
});

import { expect, test, type Page, type Route } from "playwright/test";

const ADDRESS = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";

test.describe.configure({ timeout: 90_000 });

type Handler = (route: Route) => Promise<void> | void;

/** Toutes les routes d'API sont simulées ; `handlers` remplace une route précise. */
async function open(page: Page, path: string, options: { connect?: boolean; handlers?: Record<string, Handler> } = {}) {
  const handlers = options.handlers ?? {};
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const handler = handlers[pathname];
    if (handler) return handler(route);
    return route.fulfill({ json: { authenticated: false, known: false } });
  });
  await page.goto(path);
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  if (options.connect !== false) await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), ADDRESS);
}

test("/settings sans connexion : message de connexion, réseau affiché, éléments Soon grisés", async ({ page }) => {
  await open(page, "/settings", { connect: false });
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByTestId("settings-signed-out")).toContainText("Connect a wallet to save your settings.");
  await expect(page.getByTestId("settings-network")).toHaveText("Robinhood Chain testnet");
  // Sur testnet, pas de lien vers le testnet.
  await expect(page.getByRole("link", { name: "Try it on testnet" })).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  const soon = page.getByTestId("soon-item");
  await expect(soon).toHaveCount(3);
  await expect(soon.filter({ hasText: "Notifications" })).toContainText("Soon");
  await expect(page.getByRole("button", { name: "Restart guided tour" })).toBeVisible();
});

test("/settings connecté : la langue s'enregistre via PATCH /api/profile et le guide Sirio se relance", async ({ page }) => {
  const patches: unknown[] = [];
  // Guide neutralisé dans la suite e2e sauf marqueur explicite ; déjà passé : seule la relance l'affiche.
  await page.addInitScript(() => {
    localStorage.setItem("sirius-guide-e2e", "1");
    localStorage.setItem("sirius-guide:anonymous", JSON.stringify({ v: 1, arrivalSeen: true, tourIndex: 0, tourDone: false, skipped: true, minimized: false }));
  });
  await open(page, "/settings", {
    handlers: {
      "/api/profile": async (route) => {
        if (route.request().method() === "PATCH") {
          patches.push(route.request().postDataJSON());
          return route.fulfill({ json: { settings: { language: "en" } } });
        }
        return route.fulfill({ json: { settings: {} } });
      },
    },
  });
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Language saved.");
  expect(patches).toEqual([{ settings: { language: "en" } }]);
  await expect(save).toBeDisabled();

  const guide = page.getByRole("region", { name: "Sirio, the Sirius guide" });
  await expect(guide).toHaveCount(0);
  await page.getByRole("button", { name: "Restart guided tour" }).click();
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute("data-phase", "arrival");
  await expect(guide.getByRole("button", { name: "Let’s go", exact: true })).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(page.getByText("The guided tour will be available soon.")).toHaveCount(0);
});

test("/settings : un échec d'enregistrement est signalé sans bloquer la page", async ({ page }) => {
  await open(page, "/settings", {
    handlers: {
      "/api/profile": (route) => (route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, json: { error: "Erreur interne" } })
        : route.fulfill({ json: { settings: {} } })),
    },
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Could not save your settings. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart guided tour" })).toBeEnabled();
});

test("/kyb sans connexion : invitation à se connecter et éléments Soon", async ({ page }) => {
  await open(page, "/kyb", { connect: false });
  await expect(page.getByTestId("kyb-signed-out")).toContainText("Connect a wallet to see your verification status.");
  await expect(page.getByTestId("soon-item")).toHaveCount(2);
  await expect(page.getByTestId("kyb-status")).toHaveCount(0);
});

test("/kyb non vérifié : formulaire d'invitation et adresse de contact", async ({ page }) => {
  await open(page, "/kyb", {
    handlers: { "/api/kyb/status": (route) => route.fulfill({ json: { valid: false, expiresAt: null, revoked: false } }) },
  });
  await expect(page.getByTestId("kyb-status")).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("kyb-status")).toContainText("Not verified");
  await expect(page.getByLabel("Invitation code")).toBeVisible();
  await expect(page.getByTestId("kyb-contact")).toContainText("No invitation? Write to us:");
  await expect(page.getByRole("link", { name: "sirius.data.contact@gmail.com" }))
    .toHaveAttribute("href", "mailto:sirius.data.contact@gmail.com");
});

test("/kyb vérifié : date d'expiration affichée, pas de formulaire", async ({ page }) => {
  await open(page, "/kyb", {
    handlers: { "/api/kyb/status": (route) => route.fulfill({ json: { valid: true, expiresAt: 1_798_761_600, revoked: false } }) },
  });
  await expect(page.getByTestId("kyb-status")).toHaveAttribute("data-state", "verified");
  await expect(page.getByTestId("kyb-expiry")).toHaveText("Attestation valid until January 1, 2027 (UTC).");
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
});

test("/kyb : une lecture en échec n'affiche ni « vérifié » ni formulaire, et propose de réessayer", async ({ page }) => {
  let failing = true;
  await open(page, "/kyb", {
    handlers: {
      "/api/kyb/status": (route) => (failing
        ? route.fulfill({ status: 503, json: { error: "Statut de vérification indisponible" } })
        : route.fulfill({ json: { valid: true, expiresAt: 1_798_761_600, revoked: false } })),
    },
  });
  await expect(page.getByTestId("kyb-status")).toHaveAttribute("data-state", "unknown");
  await expect(page.getByLabel("Invitation code")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("kyb-status")).toHaveAttribute("data-state", "verified");
});

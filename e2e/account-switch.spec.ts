import { expect, test, type Page, type Route } from "playwright/test";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const label = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

interface AuditWallet {
  emit: (event: string, value: unknown) => void;
  count: () => number;
}
declare global {
  interface Window {
    __walletAudit: { a: AuditWallet; b: AuditWallet; announce: () => void };
  }
}

async function wallets(page: Page, late = false) {
  await page.route("**/api/**", route => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.addInitScript(({ addresses, late }) => {
    if (late) localStorage.setItem("sirius.wallet.rdns", "audit.b");
    const make = (address: string) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      return {
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_accounts") return late ? [address] : [];
          if (method === "eth_requestAccounts") return [address];
          if (method === "wallet_requestPermissions") return [];
          throw new Error(method);
        },
        on(event: string, listener: (value: unknown) => void) {
          const group = listeners.get(event) ?? new Set();
          group.add(listener);
          listeners.set(event, group);
        },
        removeListener(event: string, listener: (value: unknown) => void) { listeners.get(event)?.delete(listener); },
        emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); },
        count() { return listeners.get("accountsChanged")?.size ?? 0; },
      };
    };
    const a = make(addresses[0]);
    const b = make(addresses[1]);
    const announce = () => {
      for (const [key, provider] of [["a", a], ["b", b]] as const) {
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
          info: { uuid: key, rdns: `audit.${key}`, name: `Audit ${key.toUpperCase()}`, icon: "" }, provider,
        } }));
      }
    };
    window.__walletAudit = { a, b, announce };
    if (!late) {
      Object.defineProperty(window, "ethereum", { value: a, configurable: true });
      window.addEventListener("eip6963:requestProvider", announce);
    }
  }, { addresses: [A, B], late });
}

test("écoute le wallet choisi et conserve un changement de compte suivi immédiatement du réseau", async ({ page }) => {
  await wallets(page);
  await page.goto("/docs");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Audit B", exact: true }).click();
  await expect(page.getByRole("button", { name: label(B), exact: true })).toBeVisible();
  expect(await page.evaluate(() => [window.__walletAudit.a.count(), window.__walletAudit.b.count()])).toEqual([0, 1]);
  await page.evaluate((address) => {
    window.__walletAudit.b.emit("accountsChanged", [address]);
    window.__walletAudit.b.emit("chainChanged", "0x1237");
    window.__walletAudit.a.emit("accountsChanged", ["0x4444444444444444444444444444444444444444"]);
  }, C);
  await page.getByRole("button", { name: label(C), exact: true }).click();
  await expect(page.getByText("Robinhood Chain · mainnet", { exact: true })).toBeVisible();
});

test("restaure le wallet choisi lorsqu'il est annoncé après le montage", async ({ page }) => {
  await wallets(page, true);
  await page.goto("/docs");
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await page.evaluate(() => window.__walletAudit.announce());
  await expect(page.getByRole("button", { name: label(B), exact: true })).toBeVisible();
  expect(await page.evaluate(() => [window.__walletAudit.a.count(), window.__walletAudit.b.count()])).toEqual([0, 1]);
});

for (const pagination of [false, true]) {
  test(`ignore la réponse datasets du compte précédent (${pagination ? "pagination" : "chargement initial"})`, async ({ page }) => {
    const delayed: Route[] = [];
    let releaseRequested: () => void;
    const requested = new Promise<void>(resolve => { releaseRequested = resolve; });
    const fixture = (owner: string) => ({ id: `dataset-${owner}`, name: `Dataset ${owner}`, status: "DRAFT",
      modelId: "linear_regression", modelVersion: "1.0.0", ipfsCid: "fixture", sizeBytes: 100 });
    let ownerB = false;
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/datasets") return route.fulfill({ json: { known: true } });
      if (ownerB) return route.fulfill({ json: [fixture("B")] });
      if (pagination && !url.searchParams.has("cursor")) return route.fulfill({ json: [fixture("A")], headers: { "x-sirius-next-cursor": "page-2" } });
      delayed.push(route);
      releaseRequested();
    });
    await page.goto("/datasets");
    await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
    await page.evaluate(address => window.__SIRIUS_E2E__?.connect(address, "provider"), A);
    // La mosaïque suit elle-même les curseurs (tri sur l'ensemble des datasets) : avec
    // pagination, c'est la requête de la seconde page du compte A qui reste en suspens.
    await requested;
    if (pagination) {
      expect(delayed.map(route => new URL(route.request().url()).searchParams.get("cursor"))).toEqual(["page-2"]);
    }
    ownerB = true;
    await page.evaluate(address => window.__SIRIUS_E2E__?.connect(address, "provider"), B);
    await expect(page.getByRole("heading", { name: "Dataset B", exact: true })).toBeVisible();
    await Promise.all(delayed.map(route => route.fulfill({ json: [fixture("A-late")] }).catch(() => {})));
    await expect(page.getByRole("heading", { name: /^Dataset A/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dataset B", exact: true })).toBeVisible();
    // Aucun état de pagination du compte A ne survit au changement (ancien bouton « Show more »).
    await expect(page.getByText(/most recent datasets are shown/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
  });
}

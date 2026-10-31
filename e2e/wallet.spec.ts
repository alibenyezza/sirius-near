import { expect, test, type Page } from "playwright/test";
import { mockSigningWallet as mockWallet, walletAddress as address } from "./helpers/wallet";

const walletLabel = `${address.slice(0, 6)}…${address.slice(-4)}`;

async function openAccount(page: Page) {
  await page.getByRole("button", { name: walletLabel, exact: true }).click();
}

test("permet de signer depuis l’accueil sans redirection automatique", async ({ page }) => {
  const wallet = await mockWallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect.poll(wallet.signatureCount).toBe(1);
  await expect(page.getByRole("menu")).toBeHidden();
  await openAccount(page);
  await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("garde l’accueil et la session après plusieurs rechargements", async ({ page }) => {
  const wallet = await mockWallet(page, { connected: true });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await page.getByRole("link", { name: "Sirius", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  for (let reload = 0; reload < 2; reload += 1) {
    await page.reload();
    await openAccount(page);
    await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }
  expect(wallet.signatureCount()).toBe(1);
});

test("affiche la cause du refus du challenge", async ({ page }) => {
  await mockWallet(page, { connected: true, challengeError: "Origine de requête non autorisée" });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toHaveText("Request origin not allowed");
});

test("permet de réessayer après une signature refusée", async ({ page }) => {
  const wallet = await mockWallet(page, { connected: true, rejectFirstSignature: true });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toContainText("rejected");
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await openAccount(page);
  await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
  expect(wallet.signatureCount()).toBe(1);
});

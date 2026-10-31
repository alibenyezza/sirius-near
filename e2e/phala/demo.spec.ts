import { expect, test, type Page } from "playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mockSigningWallet } from "../helpers/wallet";

const owner = `0x${"12".repeat(20)}`;
const context = `self-train:${owner}:demo-job`;
let deliveryScript = "";

test.beforeAll(async () => {
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const { build } = createRequire(require.resolve("tsx"))("esbuild");
  const result = await build({ entryPoints: ["src/lib/phala-demo/delivery-client.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
  deliveryScript = result.outputFiles[0].text;
});

async function mock(page: Page, phase = "closed") {
  await page.route("**/__delivery-test.js", (route) => route.fulfill({ contentType: "application/javascript", body: deliveryScript }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/phala-demo/session") return route.fulfill({ json: { phase, available: phase === "open", sessionRevision: 1 } });
    if (path === "/api/train") return route.fulfill({ json: [] });
    if (path === "/api/phala-demo/operator") return route.fulfill({ status: 403, json: { error: "Commande réservée aux opérateurs Sirius" } });
    return route.fulfill({ json: { authenticated: false, known: true } });
  });
}

async function connect(page: Page) {
  await page.waitForFunction(() => !!window.__SIRIUS_E2E__);
  await page.evaluate((address) => window.__SIRIUS_E2E__!.connect(address), owner);
}

async function operatorController(page: Page, code: string, allowed = true) {
  const received: string[] = [];
  await page.route("**/api/phala-demo/operator", (route) => {
    const sent = route.request().headers()["x-sirius-operator-code"] ?? "";
    received.push(sent);
    if (!allowed) return route.fulfill({ status: 403, json: { error: "Commande réservée aux opérateurs Sirius" } });
    if (sent !== code) return route.fulfill({ status: 403, json: { error: "Code opérateur invalide" } });
    return route.fulfill({ json: { revision: 1, phase: "closed", available: false, changedAt: 0, activeOperations: 0, usedOperations: 0, funding: "credits" } });
  });
  return received;
}

test("page fermée en anglais, exemple visible et conservé à la connexion, aucun lien opérateur", async ({ page }) => {
  await mock(page);
  await page.goto("/phala");
  await expect(page.getByText("Demo closed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this example" }).first().click();
  await expect(page.getByText("✓ housing.csv")).toBeVisible();
  await connect(page);
  await expect(page.getByRole("button", { name: "Example selected ✓" })).toBeVisible();
  await expect(page.getByText("✓ housing.csv")).toBeVisible();
  await expect(page.getByLabel("Target column")).toHaveValue("price_eur");
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /operator/i })).toHaveCount(0);
});

test("CSV personnel : cible explicite et interface mobile sans débordement", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, "open"); await page.goto("/phala"); await connect(page);
  await page.getByLabel("Your CSV · 3 MB maximum").setInputFiles({ name: "personal.csv", mimeType: "text/csv", buffer: Buffer.from("target,feature\n2,1\n4,2") });
  await expect(page.getByText("✓ personal.csv")).toBeVisible();
  await page.getByLabel("Target column").selectOption("target");
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("accès opérateur non listé : visiteur refusé même avec un code", async ({ page }) => {
  await mock(page); await operatorController(page, "operator-code-123", false);
  await page.goto("/operator");
  await expect(page.getByRole("button", { name: "Connect operator wallet" })).toBeVisible();
  await connect(page);
  await page.getByLabel("Access code").fill("operator-code-123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This command is restricted to Sirius operators" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
});

test("accès opérateur : mauvais code refusé, bon code transmis à chaque requête", async ({ page }) => {
  await mock(page); const received = await operatorController(page, "operator-code-123");
  await page.goto("/operator"); await connect(page);
  await page.getByLabel("Access code").fill("wrong-code-456");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid operator code" })).toBeVisible();
  await page.getByLabel("Access code").fill("operator-code-123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeEnabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  // Au moins un tick de polling (5 s) : le code accompagne aussi les lectures périodiques.
  await expect.poll(() => received.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  expect(received[0]).toBe("wrong-code-456");
  expect(received.slice(1).every((sent) => sent === "operator-code-123")).toBe(true);
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByLabel("Access code")).toBeVisible();
});

test("un seul bouton connecte le wallet puis signe, sans perdre l’exemple choisi", async ({ page }) => {
  const wallet = await mockSigningWallet(page, { api: async (path, route) => {
    if (path === "/api/phala-demo/session") return route.fulfill({ json: { phase: "open", available: true, sessionRevision: 1 } });
    if (path === "/api/train") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  } });
  await page.goto("/phala");
  await page.getByRole("button", { name: "Use this example" }).first().click();
  await expect(page.getByText("✓ housing.csv")).toBeVisible();
  await page.getByRole("button", { name: "Connect my testnet wallet" }).click();
  await expect.poll(wallet.signatureCount).toBe(1);
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeEnabled();
  await expect(page.getByText("✓ housing.csv")).toBeVisible();
});

test("IndexedDB conserve la vraie clé non exportable après rechargement, Phala fermé", async ({ page }) => {
  await mock(page); await page.goto("/phala");
  const publicKey = await page.evaluate(async (address) => {
    const path = "/__delivery-test.js";
    const { prepareDemoDelivery } = await import(path);
    return (await prepareDemoDelivery("demo-job", address)).publicKey as string;
  }, owner);
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(publicKey, "base64url"));
  const salt = randomBytes(16); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(`sirius-runner-delivery-v1:${context}`), 32)), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update("synthetic-model-key"), cipher.final(), cipher.getAuthTag()]);
  const envelope = { version: 1, ephemeralPublicKey: ephemeral.getPublicKey().toString("base64url"), salt: salt.toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await page.reload();
  const result = await page.evaluate(async ({ owner, publicKey, envelope }) => {
    const path = "/__delivery-test.js";
    const { openDemoDelivery } = await import(path);
    const value = await openDemoDelivery("demo-job", owner, publicKey, envelope);
    let denied = false;
    try { await openDemoDelivery("demo-job", `0x${"34".repeat(20)}`, publicKey, envelope); } catch { denied = true; }
    return { value, denied };
  }, { owner, publicKey, envelope });
  expect(result).toEqual({ value: "synthetic-model-key", denied: true });
});

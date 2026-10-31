import { expect, test } from "playwright/test";

/**
 * Certificat d'exécution public (N6). Les e2e ne touchent pas la base : seuls les chemins
 * qui répondent avant toute lecture sont couverts ici (identifiant hors format). Les états
 * « prêt », « pas encore disponible » et la vérification de quote sont couverts par les
 * tests unitaires de `src/lib/certificate/`.
 */

test("certificat : identifiant hors format → 404, sans session ni appel API depuis le navigateur", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url());
  });
  const response = await page.goto("/certificate/not%20a%20loan!");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("Executed inside an Intel TDX enclave")).toHaveCount(0);
  await expect(page.getByText("Download raw attestation")).toHaveCount(0);
  expect(apiCalls).toEqual([]);
});

test("attestation brute : identifiant hors format → 404 JSON, sans cache", async ({ request }) => {
  const response = await request.get("/api/certificate/bad%21id/attestation");
  expect(response.status()).toBe(404);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Certificate not found" });
});

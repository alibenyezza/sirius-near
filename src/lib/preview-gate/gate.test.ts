import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  CLOSED_API_BODY,
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  PREVIEW_KEY_MIN_LENGTH,
  PUBLIC_DIRECTORIES,
  PUBLIC_PAGES,
  ROOT_FILES,
  decidePreviewGate,
  isPreviewGateExempt,
  isPublicPage,
  isStaticFilePath,
  previewCookieValid,
  previewCookieValue,
  previewGateStartupNotice,
  previewKeyMatches,
  readPreviewGateConfig,
} from "./gate";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHORT_KEY = "trop-courte-pour-une-porte-31ch";
const ACTIVE = { SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: KEY };

const PAGES = ["/", "/dashboard", "/datasets", "/datasets/new", "/marketplace", "/train", "/wallet", "/settings", "/kyb", "/explorer", "/status", "/docs", "/phala", "/operator", "/certificate/abc", "/proof/42", "/nimporte-quoi"];
const APIS = ["/api", "/api/auth/verify", "/api/auth/session", "/api/auth/logout", "/api/train", "/api/datasets", "/api/datasets/x/upload", "/api/loans", "/api/marketplace", "/api/admin/me", "/api/kyb/demo", "/api/faucet", "/api/phala-demo/drain", "/api/auth/challenge/", "/api/auth/challenge/x", "/api/auth/challenge.json"];

test("configuration : interrupteur strict, clé de 32 caractères minimum", () => {
  assert.deepEqual(readPreviewGateConfig({}), { active: false, key: null });
  assert.deepEqual(readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "1", SIRIUS_PREVIEW_KEY: KEY }), { active: false, key: KEY });
  assert.deepEqual(readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "TRUE", SIRIUS_PREVIEW_KEY: KEY }), { active: false, key: KEY });
  assert.deepEqual(readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: " true ", SIRIUS_PREVIEW_KEY: ` ${KEY} ` }), { active: true, key: KEY });
  assert.deepEqual(readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: SHORT_KEY }), { active: true, key: null });
  assert.equal(SHORT_KEY.length, PREVIEW_KEY_MIN_LENGTH - 1);
  assert.deepEqual(readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: "a".repeat(PREVIEW_KEY_MIN_LENGTH) }), { active: true, key: "a".repeat(PREVIEW_KEY_MIN_LENGTH) });
  assert.equal(PREVIEW_COOKIE_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
  assert.deepEqual(CLOSED_API_BODY, { error: "Sirius ouvre bientôt" });
});

test("porte désactivée : tout est ouvert, cookie ou pas", async () => {
  for (const env of [{}, { SIRIUS_PREVIEW_KEY: KEY }, { SIRIUS_PREVIEW_GATE: "false", SIRIUS_PREVIEW_KEY: KEY }]) {
    const config = readPreviewGateConfig(env);
    for (const path of [...PAGES, ...APIS, "/preview", "/coming-soon", "/_next/static/chunks/app.js"]) {
      assert.equal(await decidePreviewGate(config, path, null), "open", `${JSON.stringify(env)} ${path}`);
      assert.equal(await decidePreviewGate(config, path, "forgé"), "open", `${JSON.stringify(env)} ${path}`);
    }
  }
});

test("porte active sans cookie : pages en attente, API fermées", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  for (const path of PAGES) assert.equal(await decidePreviewGate(config, path, null), "wait", path);
  for (const path of APIS) assert.equal(await decidePreviewGate(config, path, null), "closed", path);
  for (const path of APIS) assert.equal(await decidePreviewGate(config, path, ""), "closed", path);
});

test("porte active avec cookie valide : tout est ouvert", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  const cookie = await previewCookieValue(KEY);
  for (const path of [...PAGES, ...APIS]) assert.equal(await decidePreviewGate(config, path, cookie), "open", path);
  assert.equal(await previewCookieValid(KEY, cookie), true);
});

test("cookie forgé, tronqué, ou dérivé d'une autre clé : refusé", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  const cookie = await previewCookieValue(KEY);
  const other = await previewCookieValue(`${KEY}x`);
  assert.notEqual(cookie, other);
  for (const forged of [KEY, "true", "1", cookie.slice(0, -1), `${cookie}0`, cookie.toUpperCase(), other, "a".repeat(cookie.length)]) {
    assert.equal(await previewCookieValid(KEY, forged), false, forged);
    assert.equal(await decidePreviewGate(config, "/dashboard", forged), "wait", forged);
    assert.equal(await decidePreviewGate(config, "/api/train", forged), "closed", forged);
  }
});

test("clé trop courte : porte active mais fermée à tous, même avec le cookie dérivé de cette clé", async () => {
  const config = readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: SHORT_KEY });
  assert.equal(config.active, true);
  assert.equal(config.key, null);
  const cookie = await previewCookieValue(SHORT_KEY);
  assert.equal(await previewCookieValid(config.key, cookie), false);
  assert.equal(await previewKeyMatches(config.key, SHORT_KEY), false);
  assert.equal(await decidePreviewGate(config, "/", cookie), "wait");
  assert.equal(await decidePreviewGate(config, "/api/auth/verify", cookie), "closed");
  // Clé absente : même fermeture.
  const sansCle = readPreviewGateConfig({ SIRIUS_PREVIEW_GATE: "true" });
  assert.equal(await decidePreviewGate(sansCle, "/", null), "wait");
  assert.equal(await decidePreviewGate(sansCle, "/api/train", null), "closed");
});

test("liste blanche : test de fumée, conditions, page d'attente et route de la clé", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  for (const path of ["/api/auth/challenge", "/preview"]) {
    assert.equal(isPreviewGateExempt(path), true, path);
    assert.equal(isPublicPage(path), false, path);
    assert.equal(await decidePreviewGate(config, path, null), "allow", path);
  }
  // Pages publiques : servies à leur adresse, mais rendues nues (sans portefeuille) sans cookie.
  for (const path of ["/terms", "/terms/", "/privacy", "/privacy/", "/legal", "/legal/", "/coming-soon", "/coming-soon/"]) {
    assert.equal(isPreviewGateExempt(path), true, path);
    assert.equal(isPublicPage(path), true, path);
    assert.equal(await decidePreviewGate(config, path, null), "public", path);
    assert.equal(await decidePreviewGate(config, path, "forgé"), "public", path);
  }
  assert.deepEqual([...PUBLIC_PAGES].sort(), ["/coming-soon", "/coming-soon/", "/legal", "/legal/", "/privacy", "/privacy/", "/terms", "/terms/"]);
  // Rien d'autre sous /api, même à un caractère près.
  for (const path of APIS) assert.equal(isPreviewGateExempt(path), false, path);
  for (const path of ["/preview/", "/preview/x", "/termsx", "/terms/x", "/coming-soon/x", "/Terms", "/terms.html", "/privacyx", "/privacy/x", "/Privacy", "/legalx", "/legal/x", "/legal.html"]) {
    assert.equal(isPreviewGateExempt(path), false, path);
    assert.equal(isPublicPage(path), false, path);
    assert.equal(await decidePreviewGate(config, path, null), "wait", path);
  }
});

test("liste blanche avec cookie valide : « open », l'équipe voit /terms avec le site complet", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  const cookie = await previewCookieValue(KEY);
  for (const path of ["/terms", "/privacy", "/legal", "/coming-soon", "/preview", "/api/auth/challenge", "/_next/static/chunks/app.js", "/images/avatar-noe.png"]) {
    assert.equal(await decidePreviewGate(config, path, cookie), "open", path);
  }
});

test("fichiers statiques : chunks Next, favicon, images et exemples de public/ restent servis", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  for (const path of ["/_next/static/chunks/app.js", "/_next/static/css/app.css", "/_next/image", "/favicon.ico", "/icon.png", "/apple-icon.png", "/opengraph-image.png", "/twitter-image.png", "/file.svg", "/globe.svg", "/next.svg", "/vercel.svg", "/window.svg", "/images/avatar-noe.png", "/images/devinci-blockchain.png", "/examples/README.md", "/examples/regression/housing-prices-train.csv", "/examples/benchmarks/industrial-yield-test.csv"]) {
    assert.equal(isPreviewGateExempt(path), true, path);
    assert.equal(await decidePreviewGate(config, path, null), "allow", path);
  }
  // Une extension ne suffit pas sous /api ni avec une remontée de chemin.
  for (const path of ["/api/models/x.json", "/../x.png", "/images/../secret.png", "/examples/../../etc/passwd.txt", "/dashboard", "/certificate/abc"]) {
    assert.equal(isPreviewGateExempt(path), false, path);
  }
});

test("une extension n'exempte pas une route dynamique ni la page 404 : liste fermée, pas d'heuristique", async () => {
  const config = readPreviewGateConfig(ACTIVE);
  // Chemins vérifiés par les relecteurs sur la branche : ils rendaient la coquille du site.
  const contournements = ["/marketplace/x.png", "/datasets/abc.csv", "/proof/x.y", "/x.png", "/certificate/abc.pdf", "/dashboard.html", "/index.html", "/robots.txt", "/sitemap.xml", "/train/model.json", "/wallet/receive.svg", "/favicon.ico/x.png", "/icon.png/", "/images", "/images/", "/examples", "/examples/", "/images/.hidden.png", "/images/x", "/images/x.", "/images/x/", "/images//x.png", "/images/./x.png", "/examples/regression/", "/imagesx/x.png", "/Images/x.png", "/examples/x.PNG/y"];
  for (const path of contournements) {
    assert.equal(isPreviewGateExempt(path), false, path);
    assert.equal(isStaticFilePath(path), false, path);
    assert.equal(await decidePreviewGate(config, path, null), "wait", path);
  }
  // Avec le cookie, ces mêmes adresses sont ouvertes comme n'importe quelle page.
  const cookie = await previewCookieValue(KEY);
  for (const path of contournements) assert.equal(await decidePreviewGate(config, path, cookie), "open", path);
});

test("liste des fichiers racine et dossiers de public/ : exactement ceux du dépôt", () => {
  // Lue sur disque : un fichier ajouté à `public/` ou une icône ajoutée à `src/app` sans
  // mise à jour de la liste fait échouer ce test, plutôt que d'être réécrit vers la page
  // d'attente en production.
  const root = resolve(import.meta.dirname, "../../..");
  const publicEntries = readdirSync(resolve(root, "public"), { withFileTypes: true });
  const publicFiles = publicEntries.filter((entry) => entry.isFile()).map((entry) => `/${entry.name}`);
  const publicDirectories = publicEntries.filter((entry) => entry.isDirectory()).map((entry) => `/${entry.name}/`);
  const metadataIcons = readdirSync(resolve(root, "src/app"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(favicon\.ico|(apple-)?icon\.[a-z]+|(opengraph|twitter)-image\.[a-z]+)$/.test(entry.name))
    .map((entry) => `/${entry.name}`);
  assert.deepEqual([...ROOT_FILES].sort(), [...publicFiles, ...metadataIcons].sort());
  assert.deepEqual([...PUBLIC_DIRECTORIES].sort(), publicDirectories.sort());
  assert.deepEqual([...ROOT_FILES].sort(), ["/apple-icon.png", "/favicon.ico", "/file.svg", "/globe.svg", "/icon.png", "/next.svg", "/opengraph-image.png", "/twitter-image.png", "/vercel.svg", "/window.svg"]);
  assert.deepEqual([...PUBLIC_DIRECTORIES], ["/images/", "/examples/"]);
  for (const directory of PUBLIC_DIRECTORIES) assert.match(directory, /^\/[a-z]+\/$/);
  for (const file of ROOT_FILES) assert.match(file, /^\/[a-z-]+\.[a-z]+$/);
  // Une extension en majuscules reste un fichier ; un segment ne commence jamais par un point.
  assert.equal(isStaticFilePath("/examples/regression/HOUSING.CSV"), true);
  assert.equal(isStaticFilePath("/examples/.env"), false);
  assert.equal(isStaticFilePath("/FAVICON.ICO"), false);
});

test("comparaison de la clé : exacte, sans tolérance", async () => {
  assert.equal(await previewKeyMatches(KEY, KEY), true);
  for (const candidate of [null, undefined, "", KEY.slice(0, -1), `${KEY}0`, KEY.toUpperCase(), ` ${KEY}`, "a".repeat(KEY.length)]) {
    assert.equal(await previewKeyMatches(KEY, candidate), false, String(candidate));
  }
  assert.equal(await previewKeyMatches(null, KEY), false);
});

test("le cookie ne contient jamais la clé", async () => {
  const cookie = await previewCookieValue(KEY);
  assert.match(cookie, /^[0-9a-f]{64}$/);
  assert.equal(cookie.includes(KEY), false);
  assert.equal(KEY.includes(cookie), false);
  assert.equal(cookie, await previewCookieValue(KEY), "dérivation déterministe");
});

test("avis de démarrage : nomme les variables, jamais la clé", () => {
  assert.equal(previewGateStartupNotice({}), null);
  assert.equal(previewGateStartupNotice({ SIRIUS_PREVIEW_KEY: KEY }), null);
  const sansCle = previewGateStartupNotice({ SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: SHORT_KEY });
  assert.match(sansCle ?? "", /fermé à tous/);
  assert.equal((sansCle ?? "").includes(SHORT_KEY), false);
  const avecCle = previewGateStartupNotice(ACTIVE);
  assert.match(avecCle ?? "", /page d'attente/);
  assert.equal((avecCle ?? "").includes(KEY), false);
});

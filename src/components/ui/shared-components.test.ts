import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { STATUS_DOT_CLASS, STATUS_KINDS, STATUS_META } from "./status";

/**
 * Rend les composants partagés dans un processus sans la condition `react-server`
 * (voir `shared-components.render.tsx`) puis vérifie le HTML produit.
 */
const script = fileURLToPath(new URL("./shared-components.render.tsx", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = { ...process.env, NODE_OPTIONS: "" };
const child = spawnSync(process.execPath, ["--import", "tsx", script], {
  cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
});
assert.equal(child.status, 0, `le rendu a échoué : ${child.stderr}`);
const html = JSON.parse(child.stdout) as Record<string, string>;

function page(name: string): string {
  assert.ok(Object.hasOwn(html, name), `cas absent : ${name}`);
  return html[name];
}

test("DisclaimerNote : textes communs, un seul lien mailto vers le contact, pas de HTML injecté", () => {
  const out = page("note-default");
  assert.match(out, /<aside role="note"/);
  assert.match(out, /Sirius currently trains baseline models/);
  assert.match(out, /Need a stronger model or specific data\? Contact us at <a href="mailto:sirius\.data\.contact@gmail\.com"[^>]*>sirius\.data\.contact@gmail\.com<\/a>\./);
  assert.equal(out.match(/href=/g)?.length, 1);
  assert.doesNotMatch(out, /dangerouslySetInnerHTML|<script/i);
});

test("DisclaimerNote : variantes info et warning, messages au choix, contenu de page échappé", () => {
  const info = page("note-info");
  const warning = page("note-warning");
  assert.match(info, /data-variant="info"/);
  assert.match(warning, /data-variant="warning"/);
  assert.notEqual(info.match(/class="[^"]*"/)?.[0], warning.match(/class="[^"]*"/)?.[0]);
  assert.match(info, /Beta: instant on-chain wallet verification, capped amounts per loan and in total\./);
  assert.doesNotMatch(info, /mailto:/, "pas de lien quand le texte ne mentionne pas le contact");
  assert.match(warning, /CSV up to 3 MB, 100 to 20,000 rows, numeric columns, up to 31 input features\. Linear and logistic regression are deterministic/);
  assert.match(page("note-children-hostile"), /&lt;b onmouseover=&quot;x&quot;&gt;/);
  assert.doesNotMatch(page("note-children-hostile"), /<b /);
  assert.doesNotMatch(page("note-empty"), /<p>/);
});

test("DisclaimerNote : un identifiant répété n'est affiché qu'une fois", () => {
  assert.equal(page("note-duplicates").match(/Beta: instant on-chain wallet verification/g)?.length, 1);
});

test("DisclaimerNote : un identifiant inconnu venu de l'extérieur est ignoré, sans exception", () => {
  assert.match(page("note-unknown-id"), /Beta: instant on-chain wallet verification/);
});

test("StatusPill : libellé visible pour chacun des huit états, point décoratif masqué", () => {
  const labels = {
    online: "Online", borrowed: "Borrowed", paused: "Paused", expired: "Expired",
    destroyed: "Destroyed", pending: "Pending", failed: "Failed", refunded: "Refunded",
  } as const;
  for (const status of STATUS_KINDS) {
    const out = page(`pill-${status}`);
    assert.ok(out.includes(`${labels[status]}</span>`), status);
    assert.match(out, /aria-hidden="true"/);
    assert.match(out, new RegExp(`data-status="${status}"`));
  }
});

test("StatusPill : couleur du badge et du point propres à chaque état", () => {
  for (const status of STATUS_KINDS) {
    const out = page(`pill-${status}`);
    const { variant } = STATUS_META[status];
    // Le point décoratif porte exactement la classe de couleur de sa variante.
    const dotClasses = out.match(/<span aria-hidden="true" class="([^"]*)"/)?.[1].split(" ");
    assert.ok(dotClasses, `point absent : ${status}`);
    assert.ok(dotClasses.includes(STATUS_DOT_CLASS[variant]), `${status} : point ${STATUS_DOT_CLASS[variant]}`);
    const otherDots = Object.values(STATUS_DOT_CLASS).filter((cls) => cls !== STATUS_DOT_CLASS[variant]);
    assert.ok(!dotClasses.some((cls) => otherDots.includes(cls)), `${status} : point d'une autre couleur`);
    // Le badge porte la bordure de sa variante.
    const border = { default: "border-white/10", accent: "border-accent/40", positive: "border-positive/40", negative: "border-negative/40", muted: "border-muted/40", warning: "border-yellow-400/40" }[variant];
    assert.ok(out.includes(` ${border} `), `${status} : bordure ${border}`);
  }
});

test("StatusPill : état inconnu → « Unknown status », la valeur brute n'apparaît nulle part", () => {
  const out = page("pill-unknown");
  assert.match(out, /Unknown status/);
  assert.match(out, /data-status="unknown"/);
  assert.doesNotMatch(out, /script|alert/);
});

test("PriceBreakdown : exemple 20 + 3 = 23 USDG, minimum affiché", () => {
  const out = page("price-example");
  assert.match(out, /<dt[^>]*>Provider receives<\/dt><dd[^>]*>20\.00 USDG<\/dd>/);
  assert.match(out, /<dt[^>]*>Compute fee \(Phala enclave\)<\/dt><dd[^>]*>3\.00 USDG<\/dd>/);
  assert.match(out, /<dt[^>]*>Borrower pays<\/dt><dd[^>]*>23\.00 USDG<\/dd>/);
  assert.match(out, /Minimum set by the tariff: 0\.001 USDG\./);
  assert.doesNotMatch(out, /role="alert"/);
  assert.match(out, /<section aria-label="Price breakdown"/);
});

test("PriceBreakdown : perspectives fournisseur et emprunteur", () => {
  const provider = page("price-provider");
  const borrower = page("price-borrower");
  assert.match(provider, />You receive</);
  assert.match(provider, />Borrower pays</);
  assert.match(borrower, />Provider receives</);
  assert.match(borrower, />You pay</);
  assert.doesNotMatch(provider, /Minimum/);
});

test("PriceBreakdown : 18 décimales (testnet) sans décalage", () => {
  const out = page("price-testnet-18");
  assert.match(out, />20\.00 USDC</);
  assert.match(out, />3\.00 USDC</);
  assert.match(out, />23\.00 USDC</);
});

test("PriceBreakdown : sous le minimum → alerte ; entrées invalides → « — » et alerte, sans exception", () => {
  assert.match(page("price-below-minimum"), /role="alert"[^>]*>Below the minimum set by the tariff: 0\.001 USDG\./);
  const invalid = page("price-invalid-amount");
  assert.equal(invalid.match(/>—</g)?.length, 3);
  assert.match(invalid, /role="alert"[^>]*>Amount unavailable: invalid value\./);
  const badDecimals = page("price-invalid-decimals");
  assert.match(badDecimals, /Amount unavailable/);
  assert.doesNotMatch(badDecimals, /USDG</);
});

test("PriceBreakdown : frais de calcul ou minimum invalides → « — » partout et alerte, sans exception", () => {
  const compute = page("price-invalid-compute");
  assert.equal(compute.match(/>—</g)?.length, 3);
  assert.match(compute, /role="alert"[^>]*>Amount unavailable/);
  const minimum = page("price-invalid-minimum");
  assert.equal(minimum.match(/>—</g)?.length, 3);
  assert.match(minimum, /Amount unavailable/);
  assert.doesNotMatch(minimum, /20\.00 USDG/, "aucun montant partiel quand une entrée est invalide");
});

test("PriceBreakdown : le montant reste à droite même quand le libellé passe à la ligne", () => {
  const out = page("price-example");
  assert.equal(out.match(/<dd class="ml-auto text-right /g)?.length, 3);
});

test("DatasetCard : taille négative, infinie ou nulle → « — »", () => {
  const out = page("card-bad-size");
  assert.equal(out.match(/<span>8 columns<\/span><span>—<\/span>/g)?.length, 3);
  assert.doesNotMatch(out, /Infinity|-5 B/);
});

test("PriceBreakdown : minimum nul affiché (« 0.00 »), jamais un « 0 » brut ni une alerte", () => {
  const out = page("price-minimum-zero");
  assert.equal(out.match(/Minimum set by the tariff: 0\.00 USDG\./g)?.length, 2);
  assert.doesNotMatch(out, /role="alert"|<p>0<\/p>|>0</);
});

test("PriceBreakdown : plus grand montant admis, exact et avec retour à la ligne autorisé", () => {
  const out = page("price-max-uint96");
  assert.match(out, />79,228,162,514,264,337,593,543\.950335 USDG</);
  assert.match(out, /<section [^>]*wrap-anywhere/);
});

test("DatasetCard : version de modèle inconnue, absente ou nulle → « Missing profile » (jamais un profil valide)", () => {
  const out = page("card-model-version");
  assert.equal(out.match(/Missing profile/g)?.length, 3);
  assert.doesNotMatch(out, /Binary logistic regression|v1\.0\.0/);
});

test("DatasetCard : taille non entière → « — » ; nom vide → « Untitled dataset » (le lien garde un nom accessible)", () => {
  assert.match(page("card-float-size"), /<span>8 columns<\/span><span>—<\/span>/);
  const out = page("card-blank-name");
  assert.match(out, /<a [^>]*href="\/datasets\/abc"[^>]*>Untitled dataset<\/a>/);
  assert.match(out, /title="Untitled dataset"/);
});

test("PriceBreakdown : le symbole est échappé", () => {
  const out = page("price-hostile-symbol");
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x&gt;/);
});

test("DatasetCard : toutes les informations de la mosaïque", () => {
  const out = page("card-full");
  const id = out.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(id, "aria-labelledby manquant");
  assert.match(out, /role="article"/);
  assert.ok(out.includes(`<h3 id="${id}"`), "le titre porte l'identifiant référencé");
  assert.match(out, /<a [^>]*href="\/datasets\/abc"[^>]*>Retail churn<\/a>/);
  assert.match(out, /Online<\/span>/);
  assert.match(out, />Commerce</);
  assert.match(out, /Binary logistic regression v1\.0\.0/);
  assert.match(out, /12,345 rows/);
  assert.match(out, /8 columns/);
  assert.match(out, /<dt[^>]*>Borrower pays<\/dt><dd[^>]*>23\.00 USDG<\/dd>/);
  assert.match(out, /<dt[^>]*>Borrows<\/dt><dd[^>]*>12<\/dd>/);
  assert.match(out, /<dt[^>]*>Total earned<\/dt><dd[^>]*>240\.00 USDG<\/dd>/);
  assert.match(out, />Verified provider</);
});

test("DatasetCard : champs optionnels absents, prix côté fournisseur", () => {
  const minimal = page("card-minimal");
  assert.match(minimal, /Borrows<\/dt><dd[^>]*>1<\/dd>/);
  assert.doesNotMatch(minimal, /Total earned|KYB|<a /);
  assert.match(minimal, /Provider receives/);
  assert.match(minimal, /Missing profile/);
  assert.match(minimal, /— rows/);
  const empty = page("card-empty");
  assert.match(empty, /Borrows<\/dt><dd[^>]*>0<\/dd>/);
  assert.match(empty, /<dd[^>]*>—<\/dd>/);
  assert.match(page("card-unverified"), />Unverified provider</);
  assert.match(page("card-null-revenue"), /Total earned<\/dt><dd[^>]*>—<\/dd>/);
});

test("DatasetCard : contenus utilisateur échappés, liens non sûrs ignorés, profil inconnu signalé", () => {
  const out = page("card-hostile");
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /href=/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /Missing profile/);
  assert.match(out, /<dd[^>]*>—<\/dd>/);
  assert.match(out, /Borrows<\/dt><dd[^>]*>—<\/dd>/);
  for (const name of ["card-href-protocol-relative", "card-href-absolute", "card-href-backslash"]) {
    assert.doesNotMatch(page(name), /href=/, name);
  }
});

test("DatasetCard : l'état affiché suit la prop (en pause, détruit)", () => {
  assert.match(page("card-minimal"), /data-status="paused"[^>]*>.*Paused<\/span>/);
  assert.match(page("card-destroyed"), /data-status="destroyed"[^>]*>.*Destroyed<\/span>/);
  assert.doesNotMatch(page("card-destroyed"), /Online/);
});

test("DatasetCard : prix et revenus invalides → « — » sur la ligne concernée, jamais 0", () => {
  const out = page("card-invalid-amounts");
  assert.match(out, /Borrower pays<\/dt><dd[^>]*>—<\/dd>/);
  assert.match(out, /Total earned<\/dt><dd[^>]*>—<\/dd>/);
  assert.doesNotMatch(out, /USDG/);
});

test("DatasetCard : le lien du titre couvre toute la carte (lien étiré), un seul lien par carte", () => {
  const out = page("card-full");
  assert.match(out, /<a [^>]*after:absolute after:inset-0[^>]*href="\/datasets\/abc"/);
  assert.equal(out.match(/<a /g)?.length, 1);
  assert.match(out, /class="[^"]*\brelative\b/);
});

test("DatasetCard : décimales et symbole du jeton respectés (18 décimales, USDC)", () => {
  const out = page("card-testnet-18");
  assert.match(out, /<dt[^>]*>Borrower pays<\/dt><dd[^>]*>20\.00 USDC<\/dd>/);
  assert.match(out, /<dt[^>]*>Total earned<\/dt><dd[^>]*>240\.00 USDC<\/dd>/);
  assert.doesNotMatch(out, /USDG/);
});

test("DatasetCard : taille du fichier affichée à côté des lignes et colonnes, « — » si absente", () => {
  assert.match(page("card-size"), /<span>8 columns<\/span><span>3\.0 MB<\/span>/);
  assert.match(page("card-no-size"), /<span>8 columns<\/span><span>—<\/span>/);
});

test("DatasetCard : pas de badge de catégorie vide", () => {
  assert.doesNotMatch(page("card-no-category"), /Commerce/);
  assert.equal((page("card-no-category").match(/rounded-full border/g) ?? []).length, 2, "pastille d'état et modèle seulement");
});

test("DisclaimerNote : variante inconnue → variante info", () => {
  assert.match(page("note-unknown-variant"), /data-variant="info"/);
});

test("DatasetCard : deux cartes ont des identifiants de titre distincts", () => {
  const ids = [...page("card-pair").matchAll(/<h3 id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("DatasetAddTile : lien vers l'upload, symbole décoratif ; sans chemin sûr, tuile inactive", () => {
  const out = page("tile");
  assert.match(out, /<a [^>]*href="\/datasets\/new"/);
  assert.match(out, /<span aria-hidden="true"[^>]*>\+<\/span>/);
  assert.match(out, />Publish a dataset</);
  const inert = page("tile-unsafe");
  assert.doesNotMatch(inert, /<a |href=/);
  assert.match(inert, /data-disabled="true"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PREVIEW_COOKIE, PREVIEW_COOKIE_MAX_AGE_SECONDS } from "@/lib/preview-gate/gate";

/**
 * Tests par inspection de source, comme pour les conditions : la politique de
 * confidentialité est un composant serveur. On vérifie ses clauses clés, et surtout que les
 * durées annoncées suivent le code (cookies, défis de connexion) plutôt qu'une recopie.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const privacy = read("./page.tsx").replace(/\s+/g, " ");
// Texte affiché seulement : les commentaires (en français) décrivent ce qui est exclu.
const privacyText = privacy.replace(/\/\*[\s\S]*?\*\//g, "");
const session = read("../../lib/auth/session.ts");
const challenge = read("../../lib/auth/challenge.ts");
const embedded = read("../../lib/wallet/embedded.ts");
const rateLimit = read("../../lib/http/rate-limit.ts");

test("confidentialité : responsable Sirius, contact par la constante", () => {
  assert.match(privacy, /Sirius is the controller/);
  assert.match(privacy, /mailto:\$\{CONTACT_EMAIL\}/);
  assert.doesNotMatch(privacy, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "aucune adresse électronique écrite en dur");
});

test("confidentialité : durées des cookies et des défis conformes au code", () => {
  assert.match(session, /const COOKIE = "sirius_session";/);
  assert.match(session, /const TTL_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(privacy, /sirius_session, which keeps you signed in for 24 hours/);
  assert.match(privacy, /The session cookie lasts 24 hours/);
  assert.equal(PREVIEW_COOKIE, "sirius_preview");
  assert.equal(PREVIEW_COOKIE_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
  assert.match(privacy, /sirius_preview, which gives the team access to the site before it opens to the public and lasts 7 days/);
  assert.match(challenge, /const TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(challenge, /authChallenge\.deleteMany\(\{ where: \{ expiresAt: \{ lte: new Date\(\) \} \} \}\)/);
  assert.match(privacy, /A sign-in challenge expires after 5 minutes and expired challenges are deleted/);
});

test("confidentialité : journal des accès 24 mois, comme les conditions", () => {
  assert.match(privacy, /Kept for 24 months after the access, then deleted/);
  assert.match(read("../terms/page.tsx"), /kept for 24 months after the access, then deleted/);
});

test("confidentialité : IP en mémoire seulement, e-mail Google jamais envoyé, télémétrie Web3Auth coupée", () => {
  // L'IP ne sert qu'à la clé de limitation de débit, tenue en mémoire.
  assert.match(rateLimit, /return `ip:\$\{value\.toLowerCase\(\)\}`;/);
  assert.match(privacy, /uses the IP address only in memory to limit the request rate and does not store it in its database/);
  assert.match(embedded, /Jamais transmise au serveur/);
  assert.match(embedded, /disableAnalytics: true/);
  assert.match(privacy, /never sent to Sirius' servers or stored by Sirius/);
  assert.match(privacy, /Web3Auth's analytics are switched off/);
});

test("confidentialité : bases légales, sous-traitants, transferts et droits", () => {
  for (const basis of [/Performance of the contract/, /Legitimate interest/, /relies on your consent/]) assert.match(privacy, basis);
  for (const provider of ["Vercel", "Neon", "Pinata", "Phala Cloud", "OVHcloud", "Web3Auth", "Alchemy"]) assert.match(privacy, new RegExp(provider));
  assert.match(privacy, /standard contractual clauses/);
  assert.match(privacy, /access, rectify and erase your data, to restrict or object to its processing, and to data portability/);
  assert.match(privacy, /CNIL/);
});

test("confidentialité : données on-chain publiques et ineffaçables, jamais de nom ni d'e-mail on-chain", () => {
  assert.match(privacy, /public and permanent/);
  assert.match(privacy, /Sirius never writes names or email addresses on-chain/);
  assert.match(privacy, /Datasets you publish/);
  assert.match(privacy, /encrypted in your browser before upload and decrypted only inside the training enclave/);
});

test("confidentialité : cookies strictement nécessaires, aucun traceur dans le code", () => {
  assert.match(privacy, /only strictly necessary cookies/);
  assert.match(privacy, /no analytics, advertising or tracking cookies/);
  const pkg = JSON.parse(read("../../../package.json")) as { dependencies?: Record<string, string> };
  const tracking = /analytics|speed-insights|posthog|plausible|mixpanel|segment|gtag|hotjar|sentry|amplitude|matomo/i;
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((name) => tracking.test(name)), []);
  assert.doesNotMatch(read("../layout.tsx"), /googletagmanager|gtag\(|@vercel\/analytics|posthog|plausible/);
});

test("confidentialité : aucune donnée personnelle des fondateurs, aucun texte d'attente", () => {
  assert.doesNotMatch(privacy, /\bAli\b|Ben ?Yezza|Noé|\bNoe\b|CHAAIISE/i);
  assert.doesNotMatch(privacyText, /SIREN|SIRET|\+33|\bTBD\b|\bTODO\b|placeholder|lorem|XXX/i);
});

test("confidentialité : page serveur sans composant client, lisible sans les fournisseurs du site", () => {
  assert.doesNotMatch(privacy, /"use client"/);
  assert.doesNotMatch(privacy, /from "@\/components\/wallet|viem|useLocale|LocaleProvider|ConnectButton|useStore|useEffect|useState/);
});

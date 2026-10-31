import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Tests par inspection de source, comme pour les conditions : la page des mentions légales
 * est un composant serveur, on vérifie son texte. Sirius n'est pas une société immatriculée :
 * aucune donnée personnelle des fondateurs, aucun champ d'attente.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const legal = read("./page.tsx").replace(/\s+/g, " ");
// Texte affiché seulement : les commentaires (en français) décrivent ce qui est exclu.
const legalText = legal.replace(/\/\*[\s\S]*?\*\//g, "");

test("mentions légales : éditeur Sirius et adresse de contact par la constante", () => {
  assert.match(legal, /published by Sirius/);
  assert.match(legal, /import \{ CONTACT_EMAIL \} from "@\/lib\/copy\/disclaimers"/);
  assert.match(legal, /mailto:\$\{CONTACT_EMAIL\}/);
  // Aucune adresse électronique écrite en dur : seule la constante fait foi.
  assert.doesNotMatch(legal, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
});

test("mentions légales : hébergeurs et prestataires réellement utilisés", () => {
  assert.match(legal, /Vercel Inc\., 440 N Barranca Ave #4133, Covina, CA 91723, USA/);
  assert.match(legal, /Phala Cloud, operated by Phala Network/);
  for (const provider of ["Neon", "Pinata", "OVHcloud", "Web3Auth", "Alchemy"]) assert.match(legal, new RegExp(provider));
});

test("mentions légales : aucune donnée personnelle des fondateurs, aucun texte d'attente", () => {
  assert.doesNotMatch(legalText, /\bAli\b|Ben ?Yezza|Noé|\bNoe\b|CHAAIISE/i);
  assert.doesNotMatch(legalText, /SIREN|SIRET|RCS|share capital|capital of|\+33|\bphone\b|telephone|home address/i);
  assert.doesNotMatch(legalText, /\bTBD\b|\bTODO\b|placeholder|lorem|XXX|to be (completed|confirmed)/i);
});

test("mentions légales : page serveur sans composant client, lisible sans les fournisseurs du site", () => {
  assert.doesNotMatch(legal, /"use client"/);
  assert.doesNotMatch(legal, /from "@\/components\/wallet|web3auth"|viem|useLocale|LocaleProvider|ConnectButton|useStore|useEffect|useState/);
});

test("pied de page : liens conditions, confidentialité et mentions légales sur le cadre, l'état et la page d'attente", () => {
  const links = read("../../components/layout/LegalLinks.tsx");
  for (const href of ["/terms", "/privacy", "/legal"]) assert.match(links, new RegExp(`href: "${href}"`));
  assert.doesNotMatch(links, /"use client"|useLocale|useState|useEffect/, "utilisable dans les pages serveur nues");
  for (const file of ["../../components/layout/AppShell.tsx", "../status/page.tsx", "../coming-soon/page.tsx"]) {
    assert.match(read(file), /<LegalLinks\b/, file);
  }
});

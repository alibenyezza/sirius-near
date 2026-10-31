import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Rend la vue du certificat dans un processus sans la condition `react-server` (voir
 * `certificate-view.render.tsx`) puis vérifie le HTML produit pour chaque état.
 */
const script = fileURLToPath(new URL("./certificate-view.render.tsx", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawnSync(process.execPath, ["--import", "tsx", script], {
  cwd: root,
  env: { ...process.env, NODE_OPTIONS: "" },
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 120_000,
});
assert.equal(child.status, 0, `le rendu a échoué : ${child.stderr}`);
const html = JSON.parse(child.stdout) as Record<string, string>;

function page(name: string): string {
  assert.ok(Object.hasOwn(html, name), `cas absent : ${name}`);
  return html[name];
}

const HEADLINE = "Executed inside an Intel TDX enclave on Phala Cloud";

test("certificat vérifié : titre, mesures, règlement, lien de preuve et téléchargement", () => {
  const out = page("verified");
  assert.match(out, /data-verdict="verified"/);
  assert.ok(out.includes(HEADLINE));
  assert.match(out, />Retail churn</);
  assert.match(out, /href="\/proof\/cdataset"/);
  assert.match(out, /bafy-model/);
  assert.match(out, /2026-10-03 08:15 UTC/);
  assert.match(out, new RegExp(`href="https://explorer\\.testnet\\.chain\\.robinhood\\.com/tx/0x(12){32}" target="_blank" rel="noreferrer noopener"`));
  assert.match(out, /href="\/api\/certificate\/cloan1\/attestation" download=""/);
  assert.match(out, /Download raw attestation \(JSON\)/);
  for (const label of ["MRTD", "RTMR3", "Compose hash"]) assert.ok(out.includes(`>${label}<`), label);
  assert.equal(out.match(/data-pin="match"/g)?.length, 2);
  // RTMR3 n'est pas épinglé : la page ne prétend jamais qu'il correspond à une valeur attendue.
  assert.match(out, /data-pin="event-log">Not pinned: changes at every restart, checked by the event log replay</);
  assert.equal(out.match(/data-check-state="pass"/g)?.length, 4);
  assert.match(out, /data-plain-summary/);
  assert.match(out, /whoever rented it received the trained model, never the data/);
});

test("échec, attente, erreur, sans quote : jamais le titre d'exécution vérifiée", () => {
  for (const name of ["failed", "hard-failed", "pending", "error", "unattested"]) {
    const out = page(name);
    assert.equal(out.includes(HEADLINE), false, name);
    assert.equal(out.includes("data-plain-summary"), false, `${name} : pas de résumé affirmatif`);
    assert.match(out, /Download raw attestation \(JSON\)/, name);
  }
  assert.match(page("hard-failed"), /data-verdict="failed"/);
  assert.match(page("hard-failed"), /Enclave execution not confirmed/);
  assert.match(page("failed"), /data-verdict="incomplete"/);
  assert.match(page("failed"), /may have been upgraded/);
  assert.match(page("failed"), /data-pin="mismatch"/);
  assert.match(page("pending"), /Reload this page in a few minutes/);
  assert.match(page("unattested"), /No hardware attestation recorded/);
  assert.equal(page("unattested").includes("Settlement recorded"), false, "date absente : ligne omise");
  assert.match(page("no-explorer"), new RegExp(`0x(12){32}`));
  assert.equal(page("no-explorer").includes("target=\"_blank\""), false, "sans explorateur : pas de lien");
  assert.equal(page("error").includes("MRTD"), false);
});

test("débit dépassé : message clair, aucun détail", () => {
  const out = page("busy");
  assert.match(out, /Too many requests/);
  for (const leak of ["Retail churn", "bafy", "0x", "/proof/"]) assert.equal(out.includes(leak), false, leak);
});

test("pas encore disponible : message clair, aucun détail du prêt", () => {
  const out = page("unavailable");
  assert.match(out, /Certificate not available yet/);
  for (const leak of ["Retail churn", "bafy", "0x", "/proof/", "/api/certificate"]) {
    assert.equal(out.includes(leak), false, leak);
  }
});

test("contenu fourni par l'utilisateur échappé", () => {
  const out = page("hostile");
  assert.equal(out.includes("<img src=x"), false);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.doesNotMatch(out, /<script|dangerouslySetInnerHTML/i);
});

test("aucune page ne contient d'adresse complète ni de champ interne", () => {
  for (const out of Object.values(html)) {
    // Les seules chaînes 0x + 40 hexadécimaux possibles seraient des adresses : il n'y en a pas.
    const withoutTx = out.replaceAll(`0x${"12".repeat(32)}`, "");
    assert.doesNotMatch(withoutTx, /0x[0-9a-fA-F]{40}/);
    for (const internal of ["borrower", "provider", "amountUsdc", "auditReceipt", "runnerReceipt", "releaseEnvelopeHash"]) {
      assert.equal(out.includes(internal), false, internal);
    }
  }
});

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { signToken } from "../auth/hmac";
import { AppError } from "../app-error";
import { translateEnglish } from "../i18n/english";
import { buildRelayUrl, cardAvailable, onrampOptions, onrampUrl, parseOnrampRequest } from "./onramp";
import { GET as getOptions } from "../../app/api/onramp/options/route";
import { GET as getLegacy, POST } from "../../app/api/onramp/route";

const SESSION = `0x${"ab".repeat(20)}`;
const ATTACKER = `0x${"cd".repeat(20)}`;
const ORIGIN = "https://sirius.test";
const LIVE = { NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_live_abc", MOONPAY_SECRET_KEY: "sk_live_secret" };

const KEYS = ["EVM_NETWORK", "NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY", "MOONPAY_SECRET_KEY", "SIRIUS_SESSION_SECRET", "SIRIUS_APP_ORIGIN"] as const;
let saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  process.env.SIRIUS_SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.SIRIUS_APP_ORIGIN = ORIGIN;
  Object.assign(process.env, values);
}

beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); setEnv({}); });
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function cookie(address = SESSION): string {
  const now = Date.now();
  return `sirius_session=${signToken({ address, source: "external", iat: now, exp: now + 60_000 }, "sirius-session")}`;
}

function post(body: unknown, { auth = true, origin = ORIGIN }: { auth?: boolean; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.cookie = cookie();
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}/api/onramp`, { method: "POST", headers, body: JSON.stringify(body) });
}

function code(fn: () => unknown): number | null {
  try { fn(); return null; } catch (err) { return err instanceof AppError ? err.status : -1; }
}

// --- Options -----------------------------------------------------------------

test("options testnet : faucet seul", () => {
  assert.deepEqual(onrampOptions("testnet", LIVE), { network: "testnet", faucet: true, card: false, transfer: false, bridge: false, minCardUsd: 5 });
});

test("options mainnet : transfert et pont, carte selon les clés", () => {
  assert.deepEqual(onrampOptions("mainnet", LIVE), { network: "mainnet", faucet: false, card: true, transfer: true, bridge: false, minCardUsd: 5 });
  assert.equal(onrampOptions("mainnet", {}).card, false);
});

test("carte : clé live et secret obligatoires, sandbox refusée sur mainnet", () => {
  assert.equal(cardAvailable("mainnet", LIVE), true);
  assert.equal(cardAvailable("mainnet", { ...LIVE, NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_test_abc" }), false);
  assert.equal(cardAvailable("mainnet", { ...LIVE, MOONPAY_SECRET_KEY: undefined }), false);
  assert.equal(cardAvailable("mainnet", { ...LIVE, MOONPAY_SECRET_KEY: "  " }), false);
  assert.equal(cardAvailable("mainnet", { MOONPAY_SECRET_KEY: "sk" }), false);
  assert.equal(cardAvailable("testnet", LIVE), false);
});

test("GET /api/onramp/options est public et suit l'environnement", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  let res = await getOptions();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { network: "mainnet", faucet: false, card: true, transfer: true, bridge: false, minCardUsd: 5 });

  setEnv({ EVM_NETWORK: "mainnet", NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test" });
  res = await getOptions();
  assert.equal((await res.json()).card, false);

  setEnv({ EVM_NETWORK: "testnet", ...LIVE });
  res = await getOptions();
  assert.deepEqual(await res.json(), { network: "testnet", faucet: true, card: false, transfer: false, bridge: false, minCardUsd: 5 });
});

// --- Validation ----------------------------------------------------------------

test("montant par carte : fini, entre 5 et 10 000", () => {
  for (const amount of [5, 10_000, 42.5]) assert.equal(code(() => parseOnrampRequest({ method: "card", asset: "USDG", amount })), null);
  for (const amount of [4.99, 10_000.01, 0, -5, Number.NaN, Infinity, "10", null, undefined]) {
    assert.equal(code(() => parseOnrampRequest({ method: "card", asset: "USDG", amount })), 400, String(amount));
  }
});

test("montant du pont : fini, entre 1 et 100 000", () => {
  for (const amount of [1, 100_000, 3.25]) assert.equal(code(() => parseOnrampRequest({ method: "bridge", asset: "ETH", amount })), null);
  for (const amount of [0.99, 100_000.01, Infinity, "5"]) {
    assert.equal(code(() => parseOnrampRequest({ method: "bridge", asset: "ETH", amount })), 400, String(amount));
  }
});

test("méthode et jeton inconnus refusés", () => {
  assert.equal(code(() => parseOnrampRequest({ method: "wire", asset: "USDG", amount: 10 })), 400);
  assert.equal(code(() => parseOnrampRequest({ method: "card", asset: "USDC", amount: 10 })), 400);
  assert.equal(code(() => parseOnrampRequest({ method: "card", asset: "usdg", amount: 10 })), 400);
});

test("les messages d'erreur ont leur traduction anglaise", () => {
  for (const message of [
    "Achat par carte indisponible", "Pont indisponible sur ce réseau", "Méthode d'ajout de fonds invalide",
    "Jeton d'ajout de fonds invalide", "Montant invalide", "Montant par carte invalide : entre 5 et 10 000 USD",
    "Montant du pont invalide : entre 1 et 100 000 USDC",
  ]) assert.notEqual(translateEnglish(message), message, message);
});

// --- Construction des URL -------------------------------------------------------------

test("lien Relay pré-rempli vers USDG ou ETH natif", () => {
  const usdg = new URL(buildRelayUrl(SESSION, "USDG", 25.5));
  assert.equal(usdg.origin + usdg.pathname, "https://relay.link/bridge/robinhood");
  assert.equal(usdg.searchParams.get("fromChainId"), "8453");
  assert.equal(usdg.searchParams.get("fromCurrency"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(usdg.searchParams.get("toCurrency"), "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(usdg.searchParams.get("amount"), "25.5");
  assert.equal(usdg.searchParams.get("tradeType"), "EXACT_INPUT");
  assert.equal(usdg.searchParams.get("toAddress"), SESSION);
  const eth = new URL(buildRelayUrl(SESSION, "ETH", 100_000));
  assert.equal(eth.searchParams.get("toCurrency"), "0x0000000000000000000000000000000000000000");
  assert.equal(eth.searchParams.get("amount"), "100000");
});

test("URL MoonPay signée : actif Robinhood, montant USD, signature vérifiable", () => {
  setEnv(LIVE);
  for (const [asset, currency] of [["USDG", "usdg_robinhood"], ["ETH", "eth_robinhood"]] as const) {
    const url = new URL(onrampUrl("mainnet", SESSION, { method: "card", asset, amount: 20 }));
    assert.equal(url.origin, "https://buy.moonpay.com");
    assert.equal(url.searchParams.get("apiKey"), "pk_live_abc");
    assert.equal(url.searchParams.get("currencyCode"), currency);
    assert.equal(url.searchParams.get("baseCurrencyAmount"), "20");
    assert.equal(url.searchParams.get("walletAddress"), SESSION);
    const signature = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    assert.equal(signature, createHmac("sha256", "sk_live_secret").update(url.search).digest("base64"));
  }
});

test("carte indisponible ou testnet : 503", () => {
  setEnv({ NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test" });
  assert.equal(code(() => onrampUrl("mainnet", SESSION, { method: "card", asset: "USDG", amount: 20 })), 503);
  setEnv(LIVE);
  assert.equal(code(() => onrampUrl("testnet", SESSION, { method: "card", asset: "USDG", amount: 20 })), 503);
  assert.equal(code(() => onrampUrl("testnet", SESSION, { method: "bridge", asset: "USDG", amount: 20 })), 503);
});

// --- Route POST -------------------------------------------------------------------

test("POST sans session : 401", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  const res = await POST(post({ method: "bridge", asset: "USDG", amount: 10 }, { auth: false }));
  assert.equal(res.status, 401);
});

test("POST d'une origine étrangère : 403", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  assert.equal((await POST(post({ method: "bridge", asset: "USDG", amount: 10 }, { origin: "https://evil.test" }))).status, 403);
  assert.equal((await POST(post({ method: "bridge", asset: "USDG", amount: 10 }, { origin: null }))).status, 403);
});

test("POST : l'adresse vient de la session, jamais du corps", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  const bridge = await POST(post({ method: "bridge", asset: "USDG", amount: 10, walletAddress: ATTACKER, toAddress: ATTACKER }));
  assert.equal(bridge.status, 200);
  const bridgeUrl = new URL((await bridge.json()).url);
  assert.equal(bridgeUrl.searchParams.get("toAddress"), SESSION);

  const card = await POST(post({ method: "card", asset: "ETH", amount: 50, walletAddress: ATTACKER }));
  assert.equal(card.status, 200);
  const body = await card.json();
  assert.deepEqual(Object.keys(body), ["url"]);
  assert.equal(new URL(body.url).searchParams.get("walletAddress"), SESSION);
  assert.ok(!body.url.toLowerCase().includes(ATTACKER.slice(2)));
});

test("POST : montant hors bornes 400, carte indisponible 503 avec le message attendu", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  assert.equal((await POST(post({ method: "card", asset: "USDG", amount: 4 }))).status, 400);
  assert.equal((await POST(post({ method: "bridge", asset: "USDG", amount: 100_001 }))).status, 400);

  setEnv({ EVM_NETWORK: "mainnet", NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test" });
  const res = await POST(post({ method: "card", asset: "USDG", amount: 20 }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Achat par carte indisponible" });
});

test("POST sur testnet : 503 pour les deux méthodes", async () => {
  setEnv({ EVM_NETWORK: "testnet", ...LIVE });
  assert.equal((await POST(post({ method: "card", asset: "USDG", amount: 20 }))).status, 503);
  assert.equal((await POST(post({ method: "bridge", asset: "USDG", amount: 20 }))).status, 503);
});

// --- GET historique ------------------------------------------------------------------

test("GET historique inchangé : pont Across sur mainnet, MoonPay usdc sur testnet", async () => {
  setEnv({ EVM_NETWORK: "mainnet", ...LIVE });
  const get = () => new Request(`${ORIGIN}/api/onramp?amount=12`, { headers: { cookie: cookie() } });
  let res = await getLegacy(get());
  assert.deepEqual(await res.json(), { url: "https://app.across.to/bridge", kind: "bridge" });

  setEnv({ EVM_NETWORK: "testnet", NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_test_abc", MOONPAY_SECRET_KEY: "sk_test" });
  res = await getLegacy(get());
  const body = await res.json();
  assert.equal(body.kind, "buy");
  const url = new URL(body.url);
  assert.equal(url.origin, "https://buy-sandbox.moonpay.com");
  assert.equal(url.searchParams.get("currencyCode"), "usdc");
  assert.equal(url.searchParams.get("walletAddress"), SESSION);
  assert.equal(url.searchParams.get("baseCurrencyAmount"), "12");

  assert.equal((await getLegacy(new Request(`${ORIGIN}/api/onramp`))).status, 401);
});

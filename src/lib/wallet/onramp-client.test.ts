import assert from "node:assert/strict";
import { test } from "node:test";
import { addFundsOptions } from "@/components/wallet/add-funds";
import {
  AMOUNT_DECIMALS,
  DEFAULT_MIN_CARD_USD,
  fallbackOnrampOptions,
  fetchOnrampOptions,
  fundingChoices,
  openOnrampUrl,
  parseAmount,
  requestOnrampUrl,
  safeOnrampUrl,
  type OnrampOptions,
} from "./onramp-client";

interface Call { input: string; init?: RequestInit }

/** `fetch` simulé : enregistre les appels, répond par la fonction donnée. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MAINNET_OPTIONS: OnrampOptions = { network: "mainnet", faucet: false, card: true, transfer: true, bridge: true, minCardUsd: 30 };

// ---- Options ----

test("options : la réponse du serveur est reprise telle quelle", async () => {
  const { impl, calls } = fakeFetch(() => json(MAINNET_OPTIONS));
  assert.deepEqual(await fetchOnrampOptions("mainnet", impl), MAINNET_OPTIONS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/onramp/options");
  assert.equal(calls[0].init?.method ?? "GET", "GET");
});

test("options : champs en trop ignorés, seuls les champs du contrat sont gardés", async () => {
  const { impl } = fakeFetch(() => json({ ...MAINNET_OPTIONS, address: "0xabc", extra: 1 }));
  assert.deepEqual(await fetchOnrampOptions("mainnet", impl), MAINNET_OPTIONS);
});

test("options : route absente (404) → repli du réseau, sans carte", async () => {
  const { impl } = fakeFetch(() => json({ error: "Not found" }, 404));
  const options = await fetchOnrampOptions("mainnet", impl);
  assert.deepEqual(options, { network: "mainnet", faucet: false, bridge: false, transfer: true, card: false, minCardUsd: DEFAULT_MIN_CARD_USD });
  assert.deepEqual(fundingChoices(options), ["transfer"]);
});

test("options : panne réseau, 401, 500, HTML ou forme inattendue → repli", async () => {
  const responses: (() => Response | Promise<Response>)[] = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => json({ error: "Non authentifié" }, 401),
    () => json({ error: "boom" }, 500),
    () => new Response("<!doctype html><p>404</p>", { status: 200 }),
    () => json({ ...MAINNET_OPTIONS, card: "true" }),
    () => json({ ...MAINNET_OPTIONS, minCardUsd: -1 }),
    () => json({ ...MAINNET_OPTIONS, network: "devnet" }),
    () => json(null),
  ];
  for (const respond of responses) {
    const { impl } = fakeFetch(respond);
    assert.deepEqual(await fetchOnrampOptions("mainnet", impl), fallbackOnrampOptions("mainnet"));
  }
});

test("options : un serveur d'un autre réseau que le build n'ouvre pas la carte", async () => {
  const { impl } = fakeFetch(() => json({ ...MAINNET_OPTIONS, network: "testnet" }));
  const options = await fetchOnrampOptions("mainnet", impl);
  assert.equal(options.card, false);
  assert.equal(options.network, "mainnet");
});

test("repli : celui de addFundsOptions, carte toujours fermée", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const fallback = fallbackOnrampOptions(network);
    assert.equal(fallback.card, false);
    assert.equal(fallback.network, network);
    for (const key of ["faucet", "bridge", "transfer"] as const) assert.equal(fallback[key], addFundsOptions(network)[key]);
  }
});

// ---- Choix selon le réseau ----

test("choix : seuls ceux à true, dans l'ordre carte, wallet, chaîne ; jamais le faucet", () => {
  assert.deepEqual(fundingChoices(MAINNET_OPTIONS), ["card", "transfer", "bridge"]);
  assert.deepEqual(fundingChoices({ ...MAINNET_OPTIONS, card: false }), ["transfer", "bridge"]);
  assert.deepEqual(fundingChoices({ ...MAINNET_OPTIONS, bridge: false, transfer: false }), ["card"]);
  assert.deepEqual(fundingChoices({ ...MAINNET_OPTIONS, faucet: true, card: false, transfer: false, bridge: false }), []);
});

test("choix : sur mainnet sans la route, transfert seul ; sur testnet, aucun (le faucet garde son bouton)", () => {
  assert.deepEqual(fundingChoices(fallbackOnrampOptions("mainnet")), ["transfer"]);
  assert.deepEqual(fundingChoices(fallbackOnrampOptions("testnet")), []);
  assert.equal(fallbackOnrampOptions("testnet").faucet, true);
});

// ---- Demande d'URL ----

test("demande : POST JSON avec méthode, jeton et montant, sans aucune adresse", async () => {
  const { impl, calls } = fakeFetch(() => json({ url: "https://buy.moonpay.com/?signature=abc" }));
  const request = { method: "card", asset: "USDG", amount: 50, address: "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d", walletAddress: "0xdead" };
  const url = await requestOnrampUrl(request as unknown as Parameters<typeof requestOnrampUrl>[0], impl);
  assert.equal(url, "https://buy.moonpay.com/?signature=abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/api/onramp");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "application/json");
  const sent = calls[0].init?.body;
  assert.equal(typeof sent, "string");
  assert.deepEqual(JSON.parse(sent as string), { method: "card", asset: "USDG", amount: 50 });
  assert.doesNotMatch(sent as string, /0x[0-9a-f]{4}|address/i);
  assert.ok(!calls[0].input.includes("0x"), "aucune adresse dans l'URL non plus");
});

test("demande : pont en ETH, corps exact", async () => {
  const { impl, calls } = fakeFetch(() => json({ url: "https://relay.link/bridge/robinhood?fromChainId=8453" }));
  await requestOnrampUrl({ method: "bridge", asset: "ETH", amount: 25 }, impl);
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { method: "bridge", asset: "ETH", amount: 25 });
});

test("demande : l'erreur du serveur est rendue telle quelle, pour être traduite à l'affichage", async () => {
  const { impl } = fakeFetch(() => json({ error: "Montant inférieur au minimum" }, 400));
  await assert.rejects(requestOnrampUrl({ method: "card", asset: "USDG", amount: 5 }, impl), { message: "Montant inférieur au minimum" });
});

test("demande : erreur sans corps lisible, route absente ou panne réseau → message générique", async () => {
  for (const respond of [() => new Response("oops", { status: 500 }), () => json({}, 404), () => json({ error: 42 }, 400)]) {
    const { impl } = fakeFetch(respond);
    await assert.rejects(requestOnrampUrl({ method: "card", asset: "USDG", amount: 50 }, impl), { message: "Ajout de fonds indisponible" });
  }
  const { impl } = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(requestOnrampUrl({ method: "bridge", asset: "USDG", amount: 50 }, impl), { message: "Service d’ajout de fonds injoignable" });
});

test("demande : une URL non https ou absente est refusée, jamais ouverte", async () => {
  for (const url of [undefined, "", "javascript:alert(1)", "http://buy.moonpay.com", "data:text/html,x", "/relative", "https://user:pw@evil.example"]) {
    const { impl } = fakeFetch(() => json({ url }));
    await assert.rejects(requestOnrampUrl({ method: "card", asset: "USDG", amount: 50 }, impl), { message: "Réponse du service d’ajout de fonds invalide" }, String(url));
  }
});

test("URL sûre : https absolue seulement", () => {
  assert.equal(safeOnrampUrl("https://buy.moonpay.com/?a=1"), "https://buy.moonpay.com/?a=1");
  assert.equal(safeOnrampUrl("JAVASCRIPT:alert(1)"), null);
  assert.equal(safeOnrampUrl(42), null);
});

test("ouverture : nouvel onglet, noopener et noreferrer", () => {
  const opened: unknown[][] = [];
  openOnrampUrl("https://buy.moonpay.com/", { open: (...args: unknown[]) => { opened.push(args); return null; } } as Pick<Window, "open">);
  assert.deepEqual(opened, [["https://buy.moonpay.com/", "_blank", "noopener,noreferrer"]]);
});

// ---- Montants ----

test("montant : virgule ou point, minimum de la carte, décimales bornées", () => {
  assert.deepEqual(parseAmount("50", { decimals: 2, min: 20 }), { ok: true, amount: 50 });
  assert.deepEqual(parseAmount(" 20,5 ", { decimals: 2, min: 20 }), { ok: true, amount: 20.5 });
  assert.deepEqual(parseAmount("19.99", { decimals: 2, min: 20 }), { ok: false, error: "Montant inférieur au minimum" });
  assert.deepEqual(parseAmount("", { decimals: 2 }), { ok: false, error: "Indique un montant" });
  for (const bad of ["0", "-5", "1e3", "abc", "1.234", "0x10", "Infinity", "1.2.3"]) {
    assert.equal(parseAmount(bad, { decimals: 2 }).ok, false, bad);
  }
  assert.deepEqual(parseAmount("0.000001", { decimals: 6 }), { ok: true, amount: 0.000001 });
  assert.deepEqual(parseAmount("2000000", { decimals: 2 }), { ok: false, error: "Montant trop élevé" });
  // Carte en dollars, pont en USDC de Base (même pour recevoir de l'ETH) : centimes seulement.
  assert.equal(AMOUNT_DECIMALS, 2);
  assert.equal(parseAmount("0.015", { decimals: AMOUNT_DECIMALS }).ok, false);
});

// ---- Contrat avec le serveur (slice F1) ----

test("contrat : les options produites par le serveur sont acceptées telles quelles", async () => {
  const { onrampOptions } = await import("@/lib/onramp/onramp");
  const env = { NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY: "pk_live_x", MOONPAY_SECRET_KEY: "sk_live_x" };
  for (const [network, serverEnv] of [["mainnet", env], ["mainnet", {}], ["testnet", env]] as const) {
    const server = onrampOptions(network, serverEnv);
    const { impl } = fakeFetch(() => json(server));
    assert.deepEqual(await fetchOnrampOptions(network, impl), server);
  }
});

test("contrat : le corps envoyé passe la validation du serveur, carte et pont, USDG et ETH", async () => {
  const { parseOnrampRequest } = await import("@/lib/onramp/onramp");
  for (const request of [
    { method: "card", asset: "USDG", amount: 5 },
    { method: "card", asset: "ETH", amount: 50.5 },
    { method: "bridge", asset: "USDG", amount: 1 },
    { method: "bridge", asset: "ETH", amount: 25 },
  ] as const) {
    const { impl, calls } = fakeFetch(() => json({ url: "https://example.com/" }));
    await requestOnrampUrl(request, impl);
    const sent = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    assert.deepEqual(parseOnrampRequest(sent), request);
  }
});

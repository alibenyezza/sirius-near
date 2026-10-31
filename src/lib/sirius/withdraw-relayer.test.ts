import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, parseEther, parseUnits, type Hex } from "viem";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import type { CreditHolder, RelayerChain, WithdrawEstimate, WithdrawRelayerConfig } from "./withdraw-relayer";

let createWithdrawRelayer: typeof import("./withdraw-relayer").createWithdrawRelayer;
let withdrawRelayerConfig: typeof import("./withdraw-relayer").withdrawRelayerConfig;
let withdrawRevert: typeof import("./withdraw-relayer").withdrawRevert;

before(async () => {
  // Le client Prisma exige une URL à l'import ; aucune requête n'est émise par ces tests.
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  ({ createWithdrawRelayer, withdrawRelayerConfig, withdrawRevert } = await import("./withdraw-relayer"));
});

const KEY = `0x${"ab".repeat(32)}`;
const ESCROW = `0x${"11".repeat(20)}` as Hex;
const OLD_ESCROW = `0x${"44".repeat(20)}` as Hex;
const usdc = (value: string, decimals = 18) => parseUnits(value, decimals);
const holder = (account: string, escrow = ESCROW): CreditHolder => ({ key: `${escrow}:${account}`, escrow, account: account as Hex });
const ALICE = holder(`0x${"a1".repeat(20)}`);
const BOB = holder(`0x${"b2".repeat(20)}`);
const CAROL = holder(`0x${"c3".repeat(20)}`, OLD_ESCROW);
// Coût maximal d'un retrait dans ces tests : 100 000 gas à 1 gwei = 0,0001 ETH.
const ESTIMATE: WithdrawEstimate = { gas: BigInt(100_000), maxFeePerGas: BigInt(1_000_000_000), maxPriorityFeePerGas: BigInt(0) };
const MAX_COST = parseEther("0.0001");
const FEE = parseEther("0.00004");

function config(dailyGas = "0.01"): WithdrawRelayerConfig {
  const parsed = withdrawRelayerConfig({ SIRIUS_WITHDRAW_RELAYER_ENABLED: "true", SIRIUS_WITHDRAW_RELAYER_KEY: KEY,
    SIRIUS_WITHDRAW_RELAYER_MIN_USDC: "1", SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH: dailyGas });
  assert.ok(parsed);
  return parsed;
}

function fakeChain(credits: Map<string, bigint>, overrides: Partial<RelayerChain> = {}) {
  const sent: string[] = [];
  const pending = new Map<Hex, string>();
  let reserve = parseEther("1");
  const chain: RelayerChain = {
    creditOf: async (escrow, account) => credits.get(`${escrow}:${account}`) ?? BigInt(0),
    decimals: async (escrow) => (escrow === OLD_ESCROW ? 6 : 18),
    estimate: async (escrow, account) => ((credits.get(`${escrow}:${account}`) ?? BigInt(0)) > BigInt(0) ? ESTIMATE : "empty"),
    balance: async () => reserve,
    send: async (escrow, account) => {
      const hash = `0x${String(sent.length + 1).padStart(64, "0")}` as Hex;
      sent.push(`${escrow}:${account}`);
      pending.set(hash, `${escrow}:${account}`);
      return hash;
    },
    receipt: async (hash) => {
      reserve -= FEE;
      credits.set(pending.get(hash)!, BigInt(0));
      return { success: true, fee: FEE };
    },
    ...overrides,
  };
  return { chain, sent, setReserve: (value: bigint) => { reserve = value; } };
}

const DAY = new Date("2026-09-26T12:00:00Z");

test("désactivé par défaut ; seuil et plafond explicites, clé dédiée", () => {
  assert.equal(withdrawRelayerConfig({}), null);
  assert.equal(withdrawRelayerConfig({ SIRIUS_WITHDRAW_RELAYER_ENABLED: "false", SIRIUS_WITHDRAW_RELAYER_KEY: "x" }), null);
  const base = { SIRIUS_WITHDRAW_RELAYER_ENABLED: "true", SIRIUS_WITHDRAW_RELAYER_KEY: KEY,
    SIRIUS_WITHDRAW_RELAYER_MIN_USDC: "0.5", SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH: "0.002" };
  const parsed = withdrawRelayerConfig(base);
  assert.equal(parsed?.minimumUsdc, "0.5");
  assert.equal(parsed?.dailyGasWei, parseEther("0.002"));
  for (const [name, value, pattern] of [
    ["SIRIUS_WITHDRAW_RELAYER_ENABLED", "1", /true ou false/],
    ["SIRIUS_WITHDRAW_RELAYER_KEY", "", /malformée/],
    ["SIRIUS_WITHDRAW_RELAYER_KEY", "0x1234", /malformée/],
    ["SIRIUS_FAUCET_KEY", KEY.toUpperCase().replace("0X", "0x"), /dédiée/],
    ["SIRIUS_KYB_VERIFIER_KEY", KEY, /dédiée/],
    ["SIRIUS_WITHDRAW_RELAYER_MIN_USDC", "", /MIN_USDC/],
    ["SIRIUS_WITHDRAW_RELAYER_MIN_USDC", "0", /MIN_USDC/],
    ["SIRIUS_WITHDRAW_RELAYER_MIN_USDC", "0.0000001", /MIN_USDC/],
    ["SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH", "", /DAILY_GAS_ETH/],
    ["SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH", "0.0", /DAILY_GAS_ETH/],
    ["SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH", "100", /DAILY_GAS_ETH/],
  ] as const) {
    assert.throws(() => withdrawRelayerConfig({ ...base, [name]: value }), pattern, `${name}=${value}`);
  }
});

test("retire les crédits au-dessus du seuil, du plus important au plus faible, toutes précisions confondues", async () => {
  const credits = new Map([[ALICE.key, usdc("2")], [BOB.key, usdc("0.5")], [CAROL.key, usdc("5", 6)]]);
  const { chain, sent } = fakeChain(credits);
  await createWithdrawRelayer(config(), chain, async () => [ALICE, BOB, CAROL]).run(() => false, DAY);
  assert.deepEqual(sent, [CAROL.key, ALICE.key]);
  assert.equal(credits.get(BOB.key), usdc("0.5"));
});

test("relit le crédit juste avant l'envoi et ne mémorise pas un crédit déjà retiré", async () => {
  const credits = new Map([[ALICE.key, usdc("3")]]);
  let reads = 0;
  const { chain, sent } = fakeChain(credits, {
    // Premier relevé à 3 USDC, puis retrait manuel du titulaire avant la relecture.
    creditOf: async () => (reads++ === 0 ? usdc("3") : BigInt(0)),
  });
  const relayer = createWithdrawRelayer(config(), chain, async () => [ALICE]);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, []);

  const later = fakeChain(new Map([[ALICE.key, usdc("4")]]));
  let estimates = 0;
  later.chain.estimate = async () => (estimates++ === 0 ? "empty" : ESTIMATE);
  const again = createWithdrawRelayer(config(), later.chain, async () => [ALICE]);
  await again.run(() => false, DAY);
  await again.run(() => false, DAY);
  assert.deepEqual(later.sent, [ALICE.key]);
});

test("un refus du contrat ou une transaction rejetée ne sont jamais retentés", async () => {
  const credits = new Map([[ALICE.key, usdc("2")], [BOB.key, usdc("2")]]);
  const { chain, sent } = fakeChain(credits, {
    estimate: async (escrow, account) => (`${escrow}:${account}` === ALICE.key ? "rejected" : ESTIMATE),
    receipt: async () => ({ success: false, fee: FEE }),
  });
  const relayer = createWithdrawRelayer(config(), chain, async () => [ALICE, BOB]);
  await relayer.run(() => false, DAY);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, [BOB.key]);
});

test("le plafond du jour bloque l'envoi suivant puis se renouvelle le lendemain", async () => {
  const credits = new Map([[ALICE.key, usdc("3")], [BOB.key, usdc("2")]]);
  const { chain, sent } = fakeChain(credits);
  // Couvre un retrait au pire coût (0,0001), pas un second après les 0,00004 réellement dépensés.
  const relayer = createWithdrawRelayer(config("0.00012"), chain, async () => [ALICE, BOB]);
  await relayer.run(() => false, DAY);
  await relayer.run(() => false, new Date("2026-09-26T23:59:00Z"));
  assert.deepEqual(sent, [ALICE.key]);
  await relayer.run(() => false, new Date("2026-09-27T00:01:00Z"));
  assert.deepEqual(sent, [ALICE.key, BOB.key]);
});

test("réserve insuffisante ou arrêt demandé : aucun envoi supplémentaire", async () => {
  const low = fakeChain(new Map([[ALICE.key, usdc("2")]]));
  low.setReserve(MAX_COST - BigInt(1));
  await createWithdrawRelayer(config(), low.chain, async () => [ALICE]).run(() => false, DAY);
  assert.deepEqual(low.sent, []);

  const stopping = fakeChain(new Map([[ALICE.key, usdc("3")], [BOB.key, usdc("2")]]));
  let stop = false;
  const original = stopping.chain.receipt;
  stopping.chain.receipt = async (hash) => { stop = true; return original(hash); };
  await createWithdrawRelayer(config(), stopping.chain, async () => [ALICE, BOB]).run(() => stop, DAY);
  assert.deepEqual(stopping.sent, [ALICE.key]);
});

test("un reçu perdu compte le pire coût, interrompt la passe et n'est pas renvoyé", async () => {
  const credits = new Map([[ALICE.key, usdc("3")], [BOB.key, usdc("2")]]);
  const { chain, sent } = fakeChain(credits, { receipt: async () => { throw new Error("timeout"); } });
  // Plafond de deux pires coûts : le premier reçu perdu en consomme un.
  const relayer = createWithdrawRelayer(config("0.0002"), chain, async () => [ALICE, BOB]);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, [ALICE.key]);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, [ALICE.key, BOB.key]);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, [ALICE.key, BOB.key]);
});

test("une lecture en échec écarte le crédit pour la passe seulement", async () => {
  const credits = new Map([[CAROL.key, usdc("5", 6)]]);
  let decimalsCalls = 0;
  const { chain, sent } = fakeChain(credits, {
    decimals: async () => { if (decimalsCalls++ === 0) throw new Error("RPC indisponible"); return 6; },
  });
  const relayer = createWithdrawRelayer(config(), chain, async () => [CAROL]);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, []);
  await relayer.run(() => false, DAY);
  assert.deepEqual(sent, [CAROL.key]);
});

test("seul un revert du contrat est définitif ; « rien à retirer » n'est pas un échec", () => {
  const reverted = (data: Hex) => new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: siriusescrowAbi, data, functionName: "withdrawFor" }),
    { abi: siriusescrowAbi, functionName: "withdrawFor", args: [ALICE.account], contractAddress: ESCROW },
  );
  assert.equal(withdrawRevert(reverted(encodeErrorResult({ abi: siriusescrowAbi, errorName: "NothingToWithdraw" }))), "empty");
  // Selector Error(string) : un jeton qui refuse le transfert, par exemple une adresse bloquée.
  assert.equal(withdrawRevert(reverted(`0x08c379a0${"00".repeat(96)}` as Hex)), "rejected");
  assert.equal(withdrawRevert(new HttpRequestError({ url: "https://rpc.invalid" })), null);
  assert.equal(withdrawRevert(new Error("timeout")), null);
});

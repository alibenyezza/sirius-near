// B2.3 — Scénarios navigateur du parcours v7, runner et chaîne simulés (matrice N3, N4, I3, I4, I5, I8).
// Le wallet est un faux fournisseur EIP-1193 : il répond aux lectures de contrat, enregistre les
// transactions envoyées et confirme les reçus. Le devis est signé avec la clé d'un runner de test.
import { expect, test, type Page, type Route } from "playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { quoteAuthorizationTypedData, type ComputeQuote, type SignedComputeQuote } from "@/lib/billing/quote";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusescrowv7Abi } from "@/lib/evm/abi/siriusescrowv7";

declare global {
  interface Window {
    v7Transactions: Array<{ to: string; data: Hex; from: string }>;
    v7Switch: () => void;
  }
}

const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const OTHER = "0x2222222222222222222222222222222222222222";
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const RECIPIENT = "0x7777777777777777777777777777777777777777";
const ESCROW = "0x6666666666666666666666666666666666666666"; // NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS du webServer
const USDC = "0x5555555555555555555555555555555555555555"; // NEXT_PUBLIC_SIRIUS_USDC_ADDRESS du webServer
const DECIMALS = 18;
const runner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);
const E18 = BigInt(10) ** BigInt(DECIMALS);
const PRICE = (BigInt(175) * E18 / BigInt(100)).toString(); // 1.75 USDC
const COMPUTE = (BigInt(7) * E18).toString();
const CAP = (BigInt(10) ** BigInt(15)).toString();
const LOAN_ID = "loan-v7-e2e";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const listed = {
  id: "dataset-v7", name: "Mobilité urbaine Europe", description: "Trajets agrégés", provider: PROVIDER, status: "LISTED",
  sizeBytes: 1_250_000, priceUsdcAtomic: PRICE, challengeDays: 7, modelId: "linear_regression", modelVersion: "1.0.0",
  metrics: { rowCount: 48_000, columnCount: 24 },
};

/** Réponse de `GET /api/marketplace/[id]` pour `listed` : frais de calcul du dernier devis connus. */
const listingDetail = {
  dataset: {
    id: listed.id, name: listed.name, description: listed.description, category: "mobility", modelId: listed.modelId,
    modelVersion: listed.modelVersion, rowCount: 48_000, columnCount: 24, sizeBytes: listed.sizeBytes, providerPriceAtomic: PRICE,
    priceAtomic: (BigInt(PRICE) + BigInt(COMPUTE)).toString(), priceKind: "borrowerPays", borrowCount: 0, verified: true,
    listedAt: "2026-10-01T00:00:00.000Z", provider: PROVIDER, challengeDays: 3, settledCount: 0, refundedCount: 0, successRate: null,
    computeFee: { kind: "quoted", atomic: COMPUTE },
  },
  token: { symbol: "USDC", decimals: DECIMALS },
  kybAvailable: true,
  billingMode: "v7",
};

function quote(overrides: Partial<ComputeQuote> = {}): ComputeQuote {
  return {
    version: 7, chainId: 46630, escrow: ESCROW, usdc: USDC, usdcDecimals: DECIMALS, runner: runner.address.toLowerCase() as Hex,
    loanId: LOAN_ID, datasetId: listed.id, onChainDatasetId: hash(1), datasetReceiptHash: hash(2), borrower: BORROWER, provider: PROVIDER,
    computeRecipient: RECIPIENT, datasetAmount: PRICE, computeAmount: COMPUTE, maxFailureFee: CAP, executionRateAtomicPerMs: "16111111111",
    maxExecutionMs: 30000, maxDatasetBytes: 1_000_000, hashlock: hash(3), challengeDays: 7, tariffVersion: "tarif-test",
    expiresAt: Math.floor(Date.now() / 1000) + 300, failurePolicy: "consumed-execution-only", modelId: "linear_regression", modelVersion: "1.0.0",
    ...overrides,
  };
}

async function sign(q: ComputeQuote, signer = runner): Promise<SignedComputeQuote> {
  const signature = await signer.signTypedData(quoteAuthorizationTypedData(q));
  return { quote: q, authorization: { deadline: q.expiresAt, signature } };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Faux wallet : lectures de contrat encodées côté Node, transactions enregistrées, reçus confirmés. */
async function installWallet(page: Page, version = "sirius-escrow-usdc-v7") {
  const reads: Record<string, Hex> = {
    [toFunctionSelector("function VERSION() view returns (string)")]: encodeAbiParameters([{ type: "string" }], [version]),
    [toFunctionSelector("function lockAuthorizer() view returns (address)")]: encodeAbiParameters([{ type: "address" }], [runner.address]),
    [toFunctionSelector("function decimals() view returns (uint8)")]: encodeAbiParameters([{ type: "uint8" }], [DECIMALS]),
  };
  await page.addInitScript(({ account, other, reads }) => {
    let current = account;
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    window.v7Transactions = [];
    window.v7Switch = () => { current = other; listeners.get("accountsChanged")?.forEach((fn) => fn([other])); };
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [current];
        if (method === "eth_chainId") return "0xb626";
        if (method === "eth_getBalance") return "0x0";
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_call") {
          const data = String((params?.[0] as { data?: string })?.data ?? "0x").toLowerCase();
          return reads[data.slice(0, 10)] ?? `0x${"0".repeat(64)}`;
        }
        if (method === "eth_sendTransaction") {
          const tx = params?.[0] as { to: string; data: `0x${string}`; from: string };
          window.v7Transactions.push(tx);
          return `0x${(window.v7Transactions.length + 100).toString(16).padStart(64, "0")}`;
        }
        if (method === "eth_getTransactionReceipt") return { status: "0x1", transactionHash: params?.[0] };
        throw new Error(`Requête wallet inattendue : ${method}`);
      },
      on(event: string, fn: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
      removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
    } });
  }, { account: BORROWER, other: OTHER, reads });
}

interface Api { prepare: unknown; authorize?: unknown; loans?: unknown[]; cancel?: unknown[] }
const counters = () => ({ prepare: 0, authorize: 0, submit: 0, cancel: 0 });

async function installApi(page: Page, api: Api) {
  const calls = counters();
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === "/api/datasets" && url.searchParams.get("status") === "LISTED") return json(route, [listed]);
    // Fiche publique : l'emprunt part de `/marketplace/[id]`, avec le prix du dataset de la fiche.
    if (path === `/api/marketplace/${listed.id}`) return json(route, listingDetail);
    if (path === "/api/datasets" || path === "/api/train") return json(route, []);
    if (path === "/api/loans" && method === "GET") return json(route, api.loans ?? []);
    if (path === "/api/loans" && method === "POST") { calls.prepare++; return json(route, api.prepare); }
    if (path === `/api/loans/${LOAN_ID}/authorize`) { calls.authorize++; return json(route, api.authorize ?? {}); }
    if (path === `/api/loans/${LOAN_ID}/submit`) { calls.submit++; return json(route, {}); }
    if (/^\/api\/loans\/[^/]+\/cancel$/.test(path)) { const body = api.cancel?.[calls.cancel] ?? {}; calls.cancel++; return json(route, body); }
    // Comme les autres suites : la session serveur n'est pas simulée comme authentifiée, sinon la
    // synchronisation du connecteur (délégation runner absente) retire l'authentification posée par le pont e2e.
    if (path === "/api/auth/session") return json(route, { authenticated: false });
    if (path === "/api/reputation") return json(route, { provider: { score: 0, completedLoans: 0, cancelledEscrows: 0, evidenceCount: 0 }, borrower: { score: 0, completedLoans: 0, cancelledEscrows: 0, evidenceCount: 0 } });
    return json(route, { known: true });
  });
  return calls;
}

async function connect(page: Page, address = BORROWER) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((a) => window.__SIRIUS_E2E__?.connect(a, "borrower"), address);
}

/** Le premier rendu en développement compile la page : attendre le bouton avant de cliquer. */
async function borrowButton(page: Page) {
  const button = page.getByRole("button", { name: "Borrow" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  return button;
}

const transactions = (page: Page) => page.evaluate(() => window.v7Transactions);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("sirius-ui"));
});

test("N3/N4 : le devis affiche dataset, compute, total et retenue maximale ; accepter approuve le total exact puis verrouille", async ({ page }) => {
  const signed = await sign(quote());
  await installWallet(page);
  const calls = await installApi(page, {
    prepare: { loanId: LOAN_ID, approveTransaction: { to: USDC, data: "0x" }, lockTransaction: { to: ESCROW, data: "0x" }, billingQuote: signed },
    authorize: { lockTransaction: { to: ESCROW, data: "0x" }, authorizationDeadline: Math.floor(Date.now() / 1000) + 240, billingQuote: signed },
  });
  await page.goto(`/marketplace/${listed.id}`);
  await connect(page);
  await (await borrowButton(page)).click();
  const dialog = page.getByRole("dialog", { name: "Training quote" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Dataset price")).toBeVisible();
  await expect(dialog.getByText("1.75 test USDC", { exact: true })).toBeVisible();
  await expect(dialog.getByText("7 test USDC", { exact: true })).toBeVisible();
  await expect(dialog.getByText("8.75 test USDC", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Maximum retained fee : 0.001 test USDC")).toBeVisible();
  await dialog.getByRole("button", { name: "Accept and prepay" }).click();
  await expect.poll(() => calls.submit).toBe(1);
  const sent = await transactions(page);
  expect(sent).toHaveLength(2);
  const approve = decodeFunctionData({ abi: erc20Abi, data: sent[0].data });
  expect(sent[0].to.toLowerCase()).toBe(USDC);
  expect(approve.functionName).toBe("approve");
  expect(String(approve.args?.[0]).toLowerCase()).toBe(ESCROW);
  expect(approve.args?.[1]).toBe(BigInt(PRICE) + BigInt(COMPUTE));
  const lock = decodeFunctionData({ abi: siriusescrowv7Abi, data: sent[1].data });
  expect(sent[1].to.toLowerCase()).toBe(ESCROW);
  expect(lock.functionName).toBe("lock");
  const terms = lock.args?.[0] as { datasetAmount: bigint; computeAmount: bigint; maxFailureFee: bigint };
  expect([terms.datasetAmount, terms.computeAmount, terms.maxFailureFee]).toEqual([BigInt(PRICE), BigInt(COMPUTE), BigInt(CAP)]);
  expect(calls.authorize).toBe(1);
});

test("I4 : annuler le devis n'envoie aucune transaction et ne demande aucune autorisation", async ({ page }) => {
  const signed = await sign(quote());
  await installWallet(page);
  const calls = await installApi(page, { prepare: { loanId: LOAN_ID, approveTransaction: {}, lockTransaction: {}, billingQuote: signed } });
  await page.goto(`/marketplace/${listed.id}`);
  await connect(page);
  await (await borrowButton(page)).click();
  const dialog = page.getByRole("dialog", { name: "Training quote" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Borrow" })).toBeEnabled();
  expect(await transactions(page)).toHaveLength(0);
  expect(calls.authorize).toBe(0);
});

test("I3 : un changement de compte pendant le devis ferme le devis sans rien signer", async ({ page }) => {
  const signed = await sign(quote());
  await installWallet(page);
  const calls = await installApi(page, { prepare: { loanId: LOAN_ID, approveTransaction: {}, lockTransaction: {}, billingQuote: signed } });
  await page.goto(`/marketplace/${listed.id}`);
  await connect(page);
  await (await borrowButton(page)).click();
  const dialog = page.getByRole("dialog", { name: "Training quote" });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.v7Switch());
  await connect(page, OTHER);
  await expect(dialog).toBeHidden();
  expect(await transactions(page)).toHaveLength(0);
  expect(calls.authorize).toBe(0);
});

for (const [title, prepare, message] of [
  ["prix modifié", async () => sign(quote({ datasetAmount: (BigInt(PRICE) + BigInt(1)).toString() })), "Dataset price changed. Reload the catalog."],
  ["signature étrangère", async () => sign(quote(), stranger), "Invalid compute quote signature"],
  ["devis absent sur un escrow v7", async () => undefined, "Compute quote is missing or incompatible with the escrow"],
] as const) {
  test(`un devis refusé (${title}) arrête le parcours avant toute signature`, async ({ page }) => {
    const signed = await prepare();
    await installWallet(page);
    const calls = await installApi(page, { prepare: { loanId: LOAN_ID, approveTransaction: {}, lockTransaction: {}, ...(signed ? { billingQuote: signed } : {}) } });
    await page.goto(`/marketplace/${listed.id}`);
    await connect(page);
    await (await borrowButton(page)).click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Training quote" })).toHaveCount(0);
    expect(await transactions(page)).toHaveLength(0);
    expect(calls.authorize).toBe(0);
  });
}

test("un devis présenté sur un escrow v6 est refusé : le parcours historique n'accepte pas de devis", async ({ page }) => {
  const signed = await sign(quote());
  await installWallet(page, "sirius-escrow-usdc-v6");
  await installApi(page, { prepare: { loanId: LOAN_ID, approveTransaction: {}, lockTransaction: {}, billingQuote: signed } });
  await page.goto(`/marketplace/${listed.id}`);
  await connect(page);
  await (await borrowButton(page)).click();
  await expect(page.getByText("Compute quote is missing or incompatible with the escrow")).toBeVisible();
  expect(await transactions(page)).toHaveLength(0);
});

const loanBase = {
  id: "loan-failed", datasetId: listed.id, borrower: BORROWER, amountUsdcAtomic: (BigInt(PRICE) + BigInt(COMPUTE)).toString(), usdcDecimals: DECIMALS,
  datasetAmountUsdcAtomic: PRICE, computeAmountUsdcAtomic: COMPUTE, modelId: "linear_regression", modelVersion: "1.0.0",
  evmLockTxHash: hash(9), evmLoanKey: hash(8), settleTxHash: null, cancelTxHash: null, modelCid: null, runnerReceipt: null,
  evmDeadline: "2026-10-01T10:13:06.000Z", createdAt: "2026-09-25T10:00:00.000Z", dataset: { name: listed.name, runnerReceipt: null }, refundable: false,
};

test("I5 : un échec mesuré affiche le remboursement crédité et les frais retenus, tels que réglés", async ({ page }) => {
  const retained = (BigInt(25) * BigInt(10) ** BigInt(15)).toString(); // 0.025 USDC
  const refund = (BigInt(PRICE) + BigInt(COMPUTE) - BigInt(retained)).toString();
  await installWallet(page);
  await installApi(page, { prepare: {}, loans: [{ ...loanBase, status: "CANCELLED", cancelTxHash: hash(7), retainedFeeUsdcAtomic: retained, refundAmountUsdcAtomic: refund }] });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByText("Refund credited")).toBeVisible();
  await expect(page.getByText("8.725 test USDC", { exact: true })).toBeVisible();
  await expect(page.getByText("Execution fees retained")).toBeVisible();
  await expect(page.getByText("0.025 test USDC", { exact: true })).toBeVisible();
});

test("I8 : après l'échéance, récupérer l'escrow envoie refund(loanKey) au bon contrat puis réconcilie", async ({ page }) => {
  const refundTx = { to: ESCROW, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "refund", args: [hash(8)] }) };
  await installWallet(page);
  const calls = await installApi(page, { prepare: {}, loans: [{ ...loanBase, id: "loan-refundable", status: "ESCROWED", refundable: true }], cancel: [{ transaction: refundTx }, {}] });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByRole("button", { name: "Refund", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await expect.poll(() => calls.cancel).toBe(2);
  const sent = await transactions(page);
  expect(sent).toHaveLength(1);
  expect(sent[0].to.toLowerCase()).toBe(ESCROW);
  const decoded = decodeFunctionData({ abi: siriusescrowAbi, data: sent[0].data });
  expect(decoded.functionName).toBe("refund");
  expect(decoded.args?.[0]).toBe(hash(8));
});

test("N4 : Retrain ouvre un nouvel emprunt complet, avec le total affiché avant tout paiement", async ({ page }) => {
  const signed = await sign(quote());
  await installWallet(page);
  const calls = await installApi(page, {
    prepare: { loanId: LOAN_ID, approveTransaction: {}, lockTransaction: {}, billingQuote: signed },
    loans: [{ ...loanBase, id: "loan-done", status: "SETTLED", settleTxHash: hash(6), modelCid: "bafy-model" }],
  });
  // Enregistrée après installApi : Playwright essaie les routes de la plus récente à la plus ancienne.
  const bodies: unknown[] = [];
  await page.route("**/api/loans", (route) => {
    if (route.request().method() === "POST") bodies.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto("/train");
  await connect(page);
  const retrain = page.getByRole("button", { name: "Retrain", exact: true });
  await expect(retrain).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("retrain-panel")).toContainText("Linear and logistic regression are deterministic");
  await retrain.click();
  // Prix de la fiche avant même le devis : donnée + calcul = total.
  await expect(page.getByTestId("retrain-panel").getByText("8.75 USDC", { exact: true })).toBeVisible();
  expect(calls.prepare).toBe(0);
  await page.getByRole("button", { name: "View the quote and retrain" }).click();
  const dialog = page.getByRole("dialog", { name: "Training quote" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("8.75 test USDC", { exact: true })).toBeVisible();
  expect(bodies).toEqual([{ datasetId: listed.id }]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await transactions(page)).toHaveLength(0);
  expect(calls.authorize).toBe(0);
});

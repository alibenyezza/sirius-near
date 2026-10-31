import { expect, test, type Page, type Route } from "playwright/test";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildDelegationMessage } from "../src/lib/runner/authorization-contract";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const label = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Forme tronquée de `truncate()` dans l'Explorer (8 premiers, 6 derniers caractères).
const shortAddress = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const dataset = (owner: string, provider = A) => ({ id: `dataset-${owner}`, name: `Private dataset ${owner}`, provider, status: "PRIVATE", modelId: "linear_regression", modelVersion: "1.0.0", ipfsCid: "fixture", runnerReceipt: "receipt", evmDatasetId: `0x${"12".repeat(32)}`, sizeBytes: 100 });

declare global {
  interface Window {
    auditSwitch: () => void;
    auditReleaseBalance: () => void;
    auditBalanceHeld: boolean;
    auditSign: (message: `0x${string}`) => Promise<string>;
    auditTransactions: unknown[];
  }
}

async function connect(page: Page, address = A) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate(a => window.__SIRIUS_E2E__?.connect(a, "provider"), address);
}

test("Entraîner ignore la réponse privée d'un compte remplacé", async ({ page }) => {
  let ownerB = false;
  const delayed: Route[] = [];
  let requested!: () => void;
  const ready = new Promise<void>(r => { requested = r; });
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/me") return route.fulfill({ json: { admin: true } });
    if (url.pathname === "/api/datasets" && !url.search) {
      if (!ownerB) { delayed.push(route); requested(); return; }
      return route.fulfill({ json: [dataset("B", B)] });
    }
    return route.fulfill({ json: ["/api/datasets", "/api/loans", "/api/train"].includes(url.pathname) ? [] : { known: true } });
  });
  await page.goto("/train");
  await connect(page);
  await ready;
  ownerB = true;
  await connect(page, B);
  await expect(page.getByText("Private dataset B", { exact: true })).toBeVisible();
  await Promise.all(delayed.map(route => route.fulfill({ json: [dataset("A")] }).catch(() => {})));
  await expect(page.getByText("Private dataset A", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Private dataset B", { exact: true })).toBeVisible();
});

const explorerLoan = (overrides: Record<string, unknown> = {}) => ({
  id: "loan-1", borrower: A, provider: B, amountUsdcAtomic: "1000000000000000000", modelId: "linear_regression", modelVersion: "1.0.0",
  status: "PENDING", evmLockTxHash: null, settleTxHash: null, auditReceipt: null, cancelTxHash: null, attestationHash: null,
  attestationComposeHash: null, evmDeadline: null, createdAt: new Date().toISOString(), settledAt: null,
  dataset: { name: "History", evmDatasetId: null, evmMintTxHash: null }, ...overrides,
});

test("Explorer remplace l'historique lors d'un changement de compte authentifié", async ({ page }) => {
  let owner = "A";
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname !== "/api/audit") return route.fulfill({ json: { known: true } });
    return route.fulfill({ json: { network: "testnet", loans: [explorerLoan({ id: `loan-${owner}`, borrower: owner === "A" ? A : B, provider: owner === "A" ? B : A, dataset: { name: `History ${owner}`, evmDatasetId: null, evmMintTxHash: null } })] } });
  });
  await page.goto("/explorer");
  await connect(page);
  await expect(page.getByText("History A", { exact: true })).toBeVisible();
  owner = "B";
  await connect(page, B);
  await expect(page.getByText("History B", { exact: true })).toBeVisible();
  await expect(page.getByText("History A", { exact: true })).toHaveCount(0);
});

test("Explorer n'affiche jamais un prêt dont le wallet connecté n'est pas l'emprunteur", async ({ page }) => {
  // L'API renvoie aussi les prêts où le compte est fournisseur : la page les écarte. Adresses à lettres
  // hexadécimales, pour que la casse compte vraiment (0xAAAA… et 0xaaaa… sont le même compte).
  const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  for (const [wallet, apiForm] of [[MIXED.toLowerCase(), MIXED], [MIXED, MIXED.toLowerCase()]]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname !== "/api/audit") return route.fulfill({ json: { known: true } });
      return route.fulfill({ json: { network: "testnet", loans: [
        explorerLoan({ id: "mine", borrower: apiForm, provider: B, dataset: { name: "Borrowed by me", evmDatasetId: null, evmMintTxHash: null } }),
        explorerLoan({ id: "lent", borrower: B, provider: wallet, dataset: { name: "Lent to someone else", evmDatasetId: null, evmMintTxHash: null } }),
      ] } });
    });
    await page.goto("/explorer");
    await connect(page, wallet);
    await expect(page.getByText("Borrowed by me", { exact: true })).toBeVisible();
    await expect(page.getByText("Lent to someone else", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: `View provider ${B} on the explorer` })).toHaveText(shortAddress(B));
    await expect(page.locator("main")).not.toContainText(shortAddress(wallet));
  }
});

test("Explorer ne prétend pas qu'il n'y a aucun emprunt quand l'API atteint sa limite de 100 prêts", async ({ page }) => {
  // 100 prêts récents où le compte est fournisseur : un éventuel emprunt plus ancien n'est pas dans la réponse.
  const lent = Array.from({ length: 100 }, (_, index) => explorerLoan({ id: `lent-${index}`, borrower: B, provider: A }));
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/audit"
    ? route.fulfill({ json: { network: "testnet", loans: lent } })
    : route.fulfill({ json: { known: true } }));
  await page.goto("/explorer");
  await connect(page);
  await expect(page.locator("main [role=status]")).toContainText("Only your 100 most recent loans were loaded");
  await expect(page.getByText("No borrowing for this wallet yet.")).toHaveCount(0);
});

test("Explorer annonce l'absence d'emprunt quand la réponse est complète et vide", async ({ page }) => {
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/audit"
    ? route.fulfill({ json: { network: "testnet", loans: [explorerLoan({ borrower: B, provider: A })] } })
    : route.fulfill({ json: { known: true } }));
  await page.goto("/explorer");
  await connect(page);
  await expect(page.getByText("No borrowing for this wallet yet.")).toBeVisible();
  await expect(page.locator("main [role=status]")).toHaveCount(0);
});

test("Explorer : remboursement confirmé, remboursement en attente, règlement et liens explorateur", async ({ page }) => {
  const hash = (c: string) => `0x${c.repeat(64)}`;
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname !== "/api/audit") return route.fulfill({ json: { known: true } });
    return route.fulfill({ json: { network: "testnet", loans: [
      explorerLoan({ id: "refunded", status: "CANCELLED", evmLockTxHash: hash("a"), cancelTxHash: hash("b"), dataset: { name: "Refunded dataset", evmDatasetId: hash("1"), evmMintTxHash: hash("c") } }),
      explorerLoan({ id: "cancelled", status: "CANCELLED", evmLockTxHash: hash("d"), dataset: { name: "Cancelled dataset", evmDatasetId: hash("1"), evmMintTxHash: hash("c") } }),
      explorerLoan({ id: "settled", status: "SETTLED", evmLockTxHash: hash("e"), settleTxHash: hash("f"), dataset: { name: "Settled dataset", evmDatasetId: hash("2"), evmMintTxHash: hash("9") } }),
    ] } });
  });
  await page.goto("/explorer");
  await connect(page);
  const card = (name: string) => page.locator("main h2", { hasText: name }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  await expect(page.getByText("REFUNDED", { exact: true })).toHaveCount(1);
  await expect(page.getByText("CANCELLED", { exact: true })).toHaveCount(1);
  await expect(page.getByText("SETTLED", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Verify Refund USDC on EVM" })).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${hash("b")}`);
  await expect(page.getByRole("link", { name: "Verify Release USDC on EVM" })).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${hash("f")}`);
  await expect(page.getByRole("link", { name: `View provider ${B} on the explorer` }).first()).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/address/${B}`);
  // Un prêt annulé sans transaction de remboursement n'est pas un remboursement.
  await expect(card("Cancelled dataset").getByRole("link", { name: "Verify Refund USDC on EVM" })).toHaveCount(0);
  const counters = page.locator("main .font-mono.uppercase").first();
  await expect(counters).toContainText("Borrowings 3");
  await expect(counters).toContainText("Datasets borrowed 2");
  await expect(counters).toContainText("Settled 1");
  await expect(counters).toContainText("Refunded 1");
});

test("Explorer signale un registre illisible au lieu de planter", async ({ page }) => {
  await page.route("**/api/**", route => new URL(route.request().url()).pathname === "/api/audit"
    ? route.fulfill({ json: { network: "unknown-network", loans: [explorerLoan()] } })
    : route.fulfill({ json: { known: true } }));
  await page.goto("/explorer");
  await connect(page);
  await expect(page.locator("main [role=alert]")).toContainText("Explorer unavailable");
  await expect(page.getByText("History", { exact: true })).toHaveCount(0);
});

test("Explorer sans wallet ne lit rien et invite à se connecter", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/audit") reads++;
    return route.fulfill({ json: { known: true, authenticated: false } });
  });
  await page.goto("/explorer");
  await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
  await expect(page.getByText("Connect a wallet to see your borrowings and their proofs.")).toBeVisible();
  expect(reads).toBe(0);
});

test("/audit redirige définitivement vers /explorer, requête conservée, sans boucle", async ({ page, request }) => {
  for (const [from, to] of [["/audit", "/explorer"], ["/audit?utm=1&ref=a", "/explorer?utm=1&ref=a"]]) {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(response.headers().location, from).toBe(to);
  }
  // Avec une barre finale, Next retire d'abord la barre (308 vers /audit), puis /audit renvoie vers /explorer.
  const trailing = await request.get("/audit/", { maxRedirects: 0 });
  expect(trailing.status()).toBe(308);
  expect(trailing.headers().location).toBe("/audit");
  // Pas de redirection ouverte : ni hôte étranger ni segment recopié dans la cible.
  for (const hostile of ["/audit//evil.example", "/audit/https://evil.example", "/audit?next=//evil.example"]) {
    const response = await request.get(hostile, { maxRedirects: 0 });
    expect(response.headers().location ?? "", hostile).not.toContain("evil.example/");
    expect(response.headers().location ?? "", hostile).not.toMatch(/^(https?:)?\/\/evil/);
  }
  await page.route("**/api/**", route => route.fulfill({ json: { known: true } }));
  await page.goto("/audit");
  await expect(page).toHaveURL(/\/explorer$/);
  await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
  const final = await request.get("/explorer", { maxRedirects: 0 });
  expect(final.status()).toBe(200);
});

test("le menu propose Explorer, pas Audit, et le marque actif sur /explorer", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { known: true } }));
  await page.goto("/explorer");
  const link = page.locator("aside").getByRole("link", { name: "Explorer", exact: true });
  await expect(link).toHaveAttribute("href", "/explorer");
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.locator("aside").getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
});

for (const path of ["/wallet", "/dashboard"]) {
  test(`${path} conserve le solde de B lorsqu'une lecture tardive de A arrive`, async ({ page }) => {
    await page.route("**/api/**", route => route.fulfill({ json: { authenticated: false, known: true } }));
    await page.addInitScript(({ A, B }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let account = A;
      const pending: (() => void)[] = [];
      window.auditReleaseBalance = () => pending.forEach(release => release());
      window.auditSwitch = () => { account = B; listeners.get("accountsChanged")?.forEach(fn => fn([B])); };
      Object.defineProperty(window, "ethereum", { configurable: true, value: {
        async request({ method, params }: { method: string; params: { data: string }[] }) {
          if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_getBalance") return "0x0";
          if (method === "eth_call") {
            const forA = params[0].data.toLowerCase().endsWith(A.slice(2));
            if (forA) await new Promise<void>(r => { pending.push(r); window.auditBalanceHeld = true; });
            return `0x${((forA ? BigInt(111) : BigInt(22)) * BigInt(10) ** BigInt(18)).toString(16).padStart(64, "0")}`;
          }
          return [];
        },
        on(event: string, fn: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
        removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
      } });
    }, { A, B });
    await page.goto(path);
    await page.waitForFunction(() => window.auditBalanceHeld);
    await page.evaluate(() => window.auditSwitch());
    await expect(page.getByText("22", { exact: true })).toBeVisible();
    await page.evaluate(() => window.auditReleaseBalance());
    await expect(page.getByText("111", { exact: true })).toHaveCount(0);
    await expect(page.getByText("22", { exact: true })).toBeVisible();
  });
}

test("un login tardif est invalidé si le wallet change pendant verify", async ({ page, baseURL }) => {
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const loginA = signer.address.toLowerCase();
  let verification!: Route;
  let requested!: () => void;
  const ready = new Promise<void>(r => { requested = r; });
  let logouts = 0;
  await page.exposeFunction("auditSign", (message: `0x${string}`) => signer.signMessage({ message: { raw: message } }));
  await page.addInitScript(({ loginA, B }) => {
    let account = loginA;
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    window.auditSwitch = () => { account = B; listeners.get("accountsChanged")?.forEach(fn => fn([B])); };
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      async request({ method, params }: { method: string; params: `0x${string}`[] }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
        if (method === "eth_chainId") return "0xb626";
        if (method === "personal_sign") return window.auditSign(params[0]);
        return [];
      },
      on(event: string, fn: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
      removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
    } });
  }, { loginA, B });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/challenge") return route.fulfill({ json: { challenge: buildDelegationMessage({ address: loginA, origin: baseURL!, sessionPublicKey: route.request().postDataJSON().runnerSessionPublicKey, network: "testnet", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, challengeToken: "test.signature" }) } });
    if (path === "/api/auth/verify") { verification = route; requested(); return; }
    if (path === "/api/auth/logout") logouts++;
    return route.fulfill({ json: { authenticated: false, known: true } });
  });
  await page.goto("/docs");
  await page.getByRole("button", { name: label(loginA), exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await ready;
  const before = logouts;
  await page.evaluate(() => window.auditSwitch());
  await expect(page.getByRole("button", { name: label(B), exact: true })).toBeVisible();
  await verification.fulfill({ json: { address: loginA, source: "external" } });
  await expect.poll(() => logouts).toBeGreaterThan(before);
  await expect(page.getByText("Authenticated", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in", exact: false })).toBeEnabled();
});

// Le catalogue a quitté la page Train : seule la liste des datasets de l'équipe (self training) se pagine encore.
test("Entraîner charge les datasets de l'équipe après la première page", async ({ page }) => {
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/me") return route.fulfill({ json: { admin: true } });
    if (url.pathname === "/api/datasets") {
      const second = url.searchParams.has("cursor");
      return route.fulfill({ json: [dataset(second ? "25" : "1", A)], headers: second ? {} : { "x-sirius-next-cursor": "page-2" } });
    }
    return route.fulfill({ json: ["/api/loans", "/api/train"].includes(url.pathname) ? [] : { known: true } });
  });
  await page.goto("/train");
  await connect(page);
  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByText("Private dataset 25", { exact: true })).toBeVisible();
  await expect(page.getByText("Private dataset 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
});

for (const succeeds of [true, false]) {
  test(`Wallet retire le crédit de l'ancien escrow, confirmation=${succeeds}`, async ({ page }) => {
    const oldEscrow = `0x${"33".repeat(20)}`;
    let reads = 0;
    await page.addInitScript(({ succeeds }) => {
      window.auditTransactions = [];
      Object.defineProperty(window, "ethereum", { configurable: true, value: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_accounts") return [];
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_call") return `0x${BigInt(window.auditTransactions.length && succeeds ? "117000000000000000000" : "107000000000000000000").toString(16).padStart(64, "0")}`;
          if (method === "eth_getBalance") return "0x0";
          if (method === "eth_sendTransaction") { window.auditTransactions.push(params?.[0]); return `0x${"ab".repeat(32)}`; }
          if (method === "eth_getTransactionReceipt") return { status: succeeds ? "0x1" : "0x0" };
          return [];
        },
      } });
    }, { succeeds });
    await page.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname === "/api/wallet/credits") {
        const amount = reads++ > 0 && succeeds ? "0" : "10";
        return route.fulfill({ json: { subject: A, credits: [{ escrow: oldEscrow, historical: true, available: true, atomic: amount, amount, transaction: { to: oldEscrow, data: encodeFunctionData({ abi: parseAbi(["function withdrawFor(address)"]), functionName: "withdrawFor", args: [A as `0x${string}`] }), value: "0x0" } }] } });
      }
      return route.fulfill({ json: { known: true, authenticated: false } });
    });
    await page.goto("/wallet");
    await connect(page);
    await expect(page.getByText("10 USDC", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    const transactions = await page.evaluate(() => window.auditTransactions) as { from: string; to: string }[];
    expect(transactions).toHaveLength(1);
    expect(transactions[0].from.toLowerCase()).toBe(A);
    expect(transactions[0].to).toBe(oldEscrow);
    if (succeeds) {
      // Crédit soldé : sa ligne à zéro disparaît, et le panneau avec elle.
      await expect(page.getByText("USDC available to withdraw", { exact: true })).toHaveCount(0);
      await expect(page.getByText("117", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(0);
    } else {
      await expect(page.locator("main [role=alert]")).toBeVisible();
      await expect(page.getByText("10 USDC", { exact: true })).toBeVisible();
      expect(reads).toBe(1);
      await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeEnabled();
    }
  });
}

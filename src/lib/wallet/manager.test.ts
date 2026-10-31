import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAddress } from "@/lib/evm/address";
import {
  connectExternalWallet,
  disconnectWallet,
  ensureExpectedChain,
  expectedChainId,
  getExternalWallet,
  sendTransactionExternal,
  waitForTransactionExternal,
  type Eip1193Provider,
} from "./manager";
import { chooseExternalWallet, clearSelectedWallet, EMBEDDED_RDNS, registerEmbeddedWallet, selectWallet, selectedWalletRdns } from "./discovery";

test("eth_sendTransaction reçoit explicitement le compte actif", async () => {
  const requests: Array<{ method: string; params?: unknown[] | object }> = [];
  const wallet: Eip1193Provider = {
    request: async (request) => {
      requests.push(request);
      if (request.method === "eth_chainId") return expectedChainId();
      if (request.method === "eth_sendTransaction") return `0x${"12".repeat(32)}`;
      throw new Error(`Méthode inattendue : ${request.method}`);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });
  const address = "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d";

  try {
    await sendTransactionExternal({ to: "0x1111111111111111111111111111111111111111", data: "0x1234" }, address);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  assert.deepEqual(requests.at(-1), {
    method: "eth_sendTransaction",
    params: [{ to: "0x1111111111111111111111111111111111111111", data: "0x1234", from: displayAddress(address) }],
  });
});

test("la confirmation wallet attend un reçu miné", async () => {
  let reads = 0;
  const wallet: Eip1193Provider = {
    request: async (request) => {
      if (request.method !== "eth_getTransactionReceipt") throw new Error(`Méthode inattendue : ${request.method}`);
      reads += 1;
      return reads === 1 ? null : { status: "0x1" };
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });

  try {
    await waitForTransactionExternal(`0x${"34".repeat(32)}`, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  assert.equal(reads, 2);
});

test("une transaction en attente trop longue reste récupérable", async () => {
  const wallet: Eip1193Provider = {
    request: async () => null,
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });

  try {
    await assert.rejects(
      () => waitForTransactionExternal(`0x${"56".repeat(32)}`, 0, 0),
      /toujours en attente/,
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

/**
 * Ces deux cas gardent la frontière que la connexion sociale a introduite dans `manager.ts`.
 *
 * Un portefeuille embarqué n'a ni permissions accordées à un site, ni sélecteur de comptes,
 * et sa liste de chaînes est figée. Trois méthodes `wallet_*` n'ont donc aucun sens pour lui,
 * et les lui envoyer échouerait en silence : la session resterait ouverte après une
 * déconnexion, ou la bascule de réseau ne se ferait jamais. Aucune des deux pannes ne
 * produit d'erreur visible, d'où ces tests.
 */
function avecSessionSociale(
  provider: Eip1193Provider,
  embarque: { switchChain?: () => Promise<void>; logout?: () => Promise<void> },
): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => EMBEDDED_RDNS } },
  });
  // Le choix est aussi gardé en mémoire de module : un test précédent qui l'a effacé
  // ne doit pas priver celui-ci de sa session sociale.
  selectWallet(EMBEDDED_RDNS);
  registerEmbeddedWallet({
    provider: () => provider,
    switchChain: async () => embarque.switchChain?.(),
    logout: async () => embarque.logout?.(),
  });
  return () => {
    // Le registre est global au module : le laisser garni ferait fuiter cette session
    // sociale dans les tests suivants.
    registerEmbeddedWallet({
      provider: () => null,
      switchChain: async () => {},
      logout: async () => {},
    });
    clearSelectedWallet();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("la déconnexion ferme la session sociale au lieu de révoquer des permissions", async () => {
  const requests: string[] = [];
  let ferme = 0;
  const restaurer = avecSessionSociale(
    { request: async (r) => { requests.push(r.method); return null; } },
    { logout: async () => { ferme += 1; } },
  );

  try {
    await disconnectWallet();
  } finally {
    restaurer();
  }

  assert.equal(ferme, 1);
  assert.deepEqual(requests, []);
});

test("la bascule de réseau passe par le SDK quand la session est sociale", async () => {
  const requests: string[] = [];
  const bascules: string[] = [];
  const restaurer = avecSessionSociale(
    {
      request: async (r) => {
        requests.push(r.method);
        if (r.method === "eth_chainId") return "0x1";
        throw new Error(`Méthode inattendue : ${r.method}`);
      },
    },
    { switchChain: async () => { bascules.push(expectedChainId()); } },
  );

  try {
    await ensureExpectedChain();
  } finally {
    restaurer();
  }

  assert.deepEqual(bascules, [expectedChainId()]);
  assert.deepEqual(requests, ["eth_chainId"]);
});

test("un retrait invalidé pendant la vérification du réseau n'est pas envoyé", async () => {
  let invalidated = false;
  let sends = 0;
  const wallet: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") { invalidated = true; return expectedChainId(); }
      sends++;
      return `0x${"12".repeat(32)}`;
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });
  try {
    await assert.rejects(sendTransactionExternal({}, "0x1111111111111111111111111111111111111111", () => {
      if (invalidated) throw new Error("Wallet changed");
    }), /Wallet changed/);
    assert.equal(sends, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("un site pas encore autorisé obtient le compte avant de demander le réseau", async () => {
  const requests: string[] = [];
  let authorized = false;
  let chain = "0x1";
  const wallet: Eip1193Provider = {
    request: async ({ method, params }) => {
      requests.push(method);
      if (method === "wallet_requestPermissions") { authorized = true; return [{ parentCapability: "eth_accounts" }]; }
      if (method === "eth_requestAccounts") { authorized = true; return ["0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d"]; }
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        // Comportement de MetaMask : refus immédiat (4100) tant que le site n'est pas autorisé.
        if (!authorized) throw Object.assign(new Error("Unauthorized"), { code: 4100 });
        chain = (params as Array<{ chainId: string }>)[0].chainId;
        return null;
      }
      throw new Error(`Méthode inattendue : ${method}`);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet, localStorage: { getItem: () => null } } });
  try {
    const connected = await connectExternalWallet(wallet);
    assert.equal(connected.chainId, expectedChainId());
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  assert.ok(requests.indexOf("eth_requestAccounts") < requests.indexOf("wallet_switchEthereumChain"));
});

/**
 * A-08 (audit du 5 octobre) : le choix « Google » mémorisé survivait à la déconnexion et au
 * clic sur « Wallet externe ». `getExternalWallet` s'y tenait sans repli, la session sociale
 * fermée rendait `null`, et un wallet qui n'expose que `window.ethereum` devenait inutilisable
 * (« Aucun wallet détecté ») jusqu'à l'effacement des données du site.
 */
function avecStockage(ethereum: Eip1193Provider, choix: string | null): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stockage = new Map<string, string>();
  if (choix) stockage.set("sirius.wallet.rdns", choix);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ethereum,
      addEventListener: () => {},
      dispatchEvent: () => true,
      localStorage: {
        getItem: (cle: string) => stockage.get(cle) ?? null,
        setItem: (cle: string, valeur: string) => { stockage.set(cle, valeur); },
        removeItem: (cle: string) => { stockage.delete(cle); },
      },
    },
  });
  if (choix) selectWallet(choix);
  registerEmbeddedWallet({ provider: () => null, switchChain: async () => {}, logout: async () => {} });
  return () => {
    clearSelectedWallet();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("« Wallet externe » oublie le choix Google d'une session fermée et retombe sur window.ethereum", () => {
  const injecte: Eip1193Provider = { request: async () => null };
  const restaurer = avecStockage(injecte, EMBEDDED_RDNS);

  try {
    assert.equal(getExternalWallet(), null);
    chooseExternalWallet();
    assert.equal(selectedWalletRdns(), null);
    assert.equal(getExternalWallet(), injecte);
  } finally {
    restaurer();
  }
});

test("« Wallet externe » oublie aussi une extension désinstallée", () => {
  const injecte: Eip1193Provider = { request: async () => null };
  const restaurer = avecStockage(injecte, "io.metamask");

  try {
    assert.equal(getExternalWallet(), null);
    chooseExternalWallet();
    assert.equal(getExternalWallet(), injecte);
  } finally {
    restaurer();
  }
});

test("une extension désignée remplace le choix mémorisé", () => {
  const injecte: Eip1193Provider = { request: async () => null };
  const restaurer = avecStockage(injecte, EMBEDDED_RDNS);

  try {
    chooseExternalWallet("io.rabby");
    assert.equal(selectedWalletRdns(), "io.rabby");
  } finally {
    restaurer();
  }
});

test("la déconnexion d'une session sociale efface le choix mémorisé", async () => {
  const injecte: Eip1193Provider = { request: async () => null };
  const restaurer = avecStockage(injecte, EMBEDDED_RDNS);

  try {
    await disconnectWallet();
    assert.equal(selectedWalletRdns(), null);
    assert.equal(window.localStorage.getItem("sirius.wallet.rdns"), null);
    assert.equal(getExternalWallet(), injecte);
  } finally {
    restaurer();
  }
});

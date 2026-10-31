import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AppError } from "../app-error";
import { addressesEqual, normalizeAddress } from "../evm/address";

/**
 * Deux formes coexistent pour une racine Merkle, et les confondre bloque tout.
 *
 * Le runner produit et consomme du hexadécimal brut : 64 caractères, sans préfixe.
 * `verifyRoot` compare cette chaîne littéralement au moment de déchiffrer, donc c'est
 * elle qui doit être persistée.
 *
 * L'EVM attend un `bytes32`, donc préfixé par `0x`. La conversion n'a lieu qu'au
 * moment de construire la transaction de publication.
 *
 * Le jour où le contrôle a exigé le préfixe sur la valeur stockée, plus aucun dataset
 * ne pouvait être publié — le message parlait d'une racine « invalide » alors qu'elle
 * était parfaitement correcte, simplement dans l'autre forme.
 */

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "provider.ts"), "utf8");

const COMPILED = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const REGISTRY = "0x18a6594a7a5b227b87808c733c40067d20357618";
const TX_HASH = `0x${"b".repeat(64)}`;

function deletionFixture(options: {
  status?: string;
  noTitle?: boolean;
  live?: boolean;
  rpcError?: boolean;
  rpcReadError?: boolean;
  activeLoan?: boolean;
  concurrentLoan?: boolean;
  receiptStatus?: string;
  sender?: string;
  destination?: string;
} = {}) {
  const dataset = {
    id: "dataset-deletion-regression",
    provider: PROVIDER,
    status: options.status ?? "DELETED",
    evmDatasetId: options.noTitle ? null : `0x${"a".repeat(64)}`,
    evmDestroyTxHash: null as string | null,
    deletionReconciledAt: null as Date | null,
    wrappedKey: options.status && options.status !== "DELETED" ? "wrapped-fixture" : null,
    keyDestroyedAt: null as Date | null,
    ipfsCid: "bafy-fixture",
  };
  const updates: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const unpins: string[] = [];
  const dependencies: Record<string, unknown> = {
    "server-only": {},
    "@/lib/db": { prisma: {
      dataset: {
        findUnique: async () => ({ ...dataset }),
        findUniqueOrThrow: async () => ({ ...dataset }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          assert.equal(where.id, dataset.id);
          assert.equal(where.provider, PROVIDER);
          if (where.loans && (options.activeLoan || options.concurrentLoan)) return { count: 0 };
          updates.push(data);
          Object.assign(dataset, data);
          return { count: 1 };
        },
      },
      loan: { findFirst: async () => options.activeLoan ? { id: "active-loan" } : null },
    } },
    "@/lib/errors": { AppError },
    "@/lib/evm/address": { addressesEqual, normalizeAddress },
    "@/lib/evm/addresses": { datasetRegistryAddress: () => REGISTRY },
    "@/lib/evm/networks": { resolveServerNetwork: () => ({ network: "testnet", chain: { id: 46630 }, rpcUrl: "" }) },
    "@/lib/evm/abi/siriusdatasetregistry": { siriusdatasetregistryAbi: [] },
    "@/lib/evm/client": { getPublicClient: () => ({
      readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        reads.push(functionName);
        assert.ok(args[0], "aucun identifiant null ne doit être envoyé au RPC");
        if (options.rpcError || options.rpcReadError) throw new Error("RPC unavailable");
        assert.equal(functionName, "isLive");
        return options.live ?? false;
      },
      waitForTransactionReceipt: async () => ({ status: options.receiptStatus ?? "success" }),
      getTransaction: async () => ({ from: options.sender ?? PROVIDER, to: options.destination ?? REGISTRY }),
    }) },
    "@/lib/evm/deployment": { requireCurrentEvmDeployment: async () => {
      reads.push("deployment");
      if (options.rpcError) throw new Error("RPC unavailable");
    } },
    "@/lib/evm/dataset-key": {},
    "@/lib/evm/transaction": { destroyDatasetTransaction: () => ({ to: REGISTRY, data: "0xdeadbeef" }) },
    "@/lib/ipfs/pinata": { unpinFromIpfs: async (cid: string) => { unpins.push(cid); } },
    "@/lib/models/registry": {},
    "@/lib/runner/provenance": {},
    "@/lib/datasets/publication": {},
    "./access": {},
  };
  const exports = {};
  // Le vrai module est exécuté avec des dépendances isolées : aucune base, clé ou RPC réel.
  runInNewContext(COMPILED, {
    exports, Date, console,
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `Dépendance non simulée : ${id}`);
      return dependencies[id];
    },
  });
  return {
    api: exports as Pick<typeof import("./provider"), "prepareDatasetDestruction" | "deleteDataset">,
    dataset, updates, reads, unpins,
  };
}

test("un DELETED sans hash est finalisé après lecture du titre absent ou détruit", async () => {
  const fixture = deletionFixture();
  assert.equal(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), null);
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  assert.ok(fixture.dataset.deletionReconciledAt instanceof Date);
  assert.equal(fixture.dataset.evmDestroyTxHash, null, "ne pas inventer de transaction");
  assert.ok(fixture.dataset.evmDatasetId, "conserver l'identifiant pour l'audit");
});

test("la finalisation sans transaction est idempotente", async () => {
  const fixture = deletionFixture();
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  const finalizedAt = fixture.dataset.deletionReconciledAt;
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  assert.equal(fixture.dataset.deletionReconciledAt, finalizedAt);
  assert.equal(fixture.updates.length, 1);
});

test("un titre encore vivant exige sa destruction avant finalisation", async () => {
  const fixture = deletionFixture({ live: true });
  assert.ok(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER));
  await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, PROVIDER), /Tombstone EVM non confirmé/);
  assert.equal(fixture.dataset.deletionReconciledAt, null);
  assert.equal(fixture.updates.length, 0);
});

test("une panne RPC ne devient pas une suppression réconciliée", async () => {
  for (const options of [{ rpcError: true }, { rpcReadError: true }]) {
    const fixture = deletionFixture(options);
    await assert.rejects(fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), /RPC unavailable/);
    await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, PROVIDER), /RPC unavailable/);
    assert.equal(fixture.updates.length, 0);
  }
});

test("un brouillon sans titre reste supprimable sans RPC", async () => {
  const fixture = deletionFixture({ status: "DRAFT", noTitle: true, rpcError: true });
  assert.equal(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), null);
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  assert.deepEqual(fixture.reads, []);
  assert.equal(fixture.dataset.status, "DELETED");
  assert.equal(fixture.dataset.wrappedKey, null);
  assert.ok(fixture.dataset.keyDestroyedAt instanceof Date);
  assert.ok(fixture.dataset.deletionReconciledAt instanceof Date);
  assert.deepEqual(fixture.unpins, [fixture.dataset.ipfsCid]);
});

test("un DELETED sans titre se finalise sans envoyer un identifiant null au RPC", async () => {
  const fixture = deletionFixture({ noTitle: true });
  assert.equal(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), null);
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  assert.deepEqual(fixture.reads, []);
  assert.ok(fixture.dataset.deletionReconciledAt instanceof Date);
});

for (const status of ["LISTED", "SUSPENDED"]) {
  test(`un ${status} dont le titre est détruit est supprimé sans nouveau hash`, async () => {
    const fixture = deletionFixture({ status });
    assert.equal(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), null);
    await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
    assert.equal(fixture.dataset.status, "DELETED");
    assert.equal(fixture.dataset.wrappedKey, null);
    assert.equal(fixture.dataset.evmDestroyTxHash, null);
    assert.ok(fixture.dataset.deletionReconciledAt instanceof Date);
  });
}

for (const status of ["DELETED", "LISTED", "DRAFT"]) {
  test(`un prêt actif empêche la suppression et la finalisation d'un ${status}`, async () => {
    const fixture = deletionFixture({ status, activeLoan: true });
    await assert.rejects(fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), /emprunt actif/);
    await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, PROVIDER));
    assert.equal(fixture.updates.length, 0);
  });
}

test("un prêt créé entre la préparation et la suppression bloque l'écriture", async () => {
  const fixture = deletionFixture({ concurrentLoan: true });
  assert.equal(await fixture.api.prepareDatasetDestruction(fixture.dataset.id, PROVIDER), null);
  await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, PROVIDER));
  assert.equal(fixture.updates.length, 0);
});

test("seul le provider peut préparer ou finaliser une suppression", async () => {
  const fixture = deletionFixture();
  await assert.rejects(fixture.api.prepareDatasetDestruction(fixture.dataset.id, REGISTRY), /Wallet ≠ provider/);
  await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, REGISTRY), /Wallet ≠ provider/);
  assert.equal(fixture.updates.length, 0);
});

test("la transaction de destruction confirmée est conservée lors des reprises", async () => {
  const fixture = deletionFixture();
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER, TX_HASH);
  assert.equal(fixture.dataset.evmDestroyTxHash, TX_HASH);
  assert.ok(fixture.dataset.deletionReconciledAt instanceof Date);
  await fixture.api.deleteDataset(fixture.dataset.id, PROVIDER);
  assert.equal(fixture.dataset.evmDestroyTxHash, TX_HASH);
  assert.equal(fixture.updates.length, 1);
});

for (const invalid of [{ receiptStatus: "reverted" }, { sender: REGISTRY }, { destination: PROVIDER }]) {
  test(`une transaction invalide ne finalise rien : ${JSON.stringify(invalid)}`, async () => {
    const fixture = deletionFixture(invalid);
    await assert.rejects(fixture.api.deleteDataset(fixture.dataset.id, PROVIDER, TX_HASH), /Transaction de tombstone EVM invalide/);
    assert.equal(fixture.updates.length, 0);
  });
}

test("la liste garde les suppressions incomplètes mais exclut celles réconciliées sans hash", () => {
  const source = readFileSync(join(process.cwd(), "src/app/api/datasets/route.ts"), "utf8");
  assert.match(source, /status: "DELETED" as const,\s+evmDatasetId: \{ not: null \},\s+evmDestroyTxHash: null,\s+deletionReconciledAt: null/);
});

test("la conversion de racine Merkle passe par la fonction partagée", () => {
  assert.ok(
    SOURCE.includes("merkleRootAsBytes32(dataset.merkleRoot)"),
    "dupliquée, la conversion a divergé entre deux fichiers et bloqué l'entraînement",
  );
});

test("les chemins runner reçoivent toujours la forme brute", () => {
  for (const fichier of ["settle.ts", "self-train.ts"]) {
    const source = readFileSync(join(process.cwd(), "src", "lib", "sirius", fichier), "utf8");
    assert.ok(
      /merkleRoot: dataset\.merkleRoot\b/.test(source),
      `${fichier} doit passer la racine telle qu'elle est stockée : le runner la compare littéralement`,
    );
  }
});

/**
 * Le `omit` global de `db.ts` retire `wrappedKey` de toute lecture Prisma, pour
 * qu'elle ne puisse pas partir dans une réponse d'API. C'est une bonne protection,
 * et elle a un effet de bord vicieux : tout contrôle qui vérifie la *présence* de ce
 * champ échoue systématiquement, sur un objet d'où il vient d'être supprimé.
 *
 * Le jour où c'est arrivé, publication, emprunt, confirmation de lock et règlement
 * refusaient tous avec « dataset incomplet » — sur des datasets parfaitement complets
 * en base. Rien dans le message ne pointait vers la cause.
 *
 * Ce test lie les deux : quiconque teste `wrappedKey` doit l'avoir réincluse.
 */
test("toute lecture qui contrôle wrappedKey la réinclut explicitement", () => {
  const fichiers = ["provider.ts", "borrower.ts", "settle.ts", "self-train.ts"];
  const fautifs: string[] = [];

  for (const nom of fichiers) {
    const source = readFileSync(join(process.cwd(), "src", "lib", "sirius", nom), "utf8");
    const controle = /wrappedKey\b/.test(source.replace(/omit:\s*\{\s*wrappedKey:\s*false\s*\}/g, ""));
    const reinclut = /omit:\s*\{\s*wrappedKey:\s*false\s*\}/.test(source);
    if (controle && !reinclut) fautifs.push(nom);
  }

  assert.deepEqual(
    fautifs,
    [],
    `Ces fichiers testent wrappedKey sans la réinclure — le contrôle sera toujours faux :\n  ${fautifs.join("\n  ")}`,
  );
});

test("la lecture du titre EVM attend la confirmation du mint", () => {
  const finalize = SOURCE.slice(
    SOURCE.indexOf("export async function finalizeDatasetListing"),
    SOURCE.indexOf("export async function prepareDatasetDestruction"),
  );
  assert.ok(
    finalize.indexOf("waitForTransactionReceipt") < finalize.indexOf("onChainDatasetId(terms, provider)"),
    "datasetIdOf ne doit pas être lu avant que la transaction mint soit confirmée",
  );
  assert.ok(
    finalize.indexOf("waitForTransactionReceipt") < finalize.indexOf("getTransaction"),
    "la transaction ne doit pas être relue avant sa confirmation",
  );
});

test("un identifiant EVM déterministe n'est pas confondu avec un titre mint", () => {
  const lookup = SOURCE.slice(
    SOURCE.indexOf("async function onChainDatasetId"),
    SOURCE.indexOf("async function markDatasetListed"),
  );
  assert.ok(
    lookup.indexOf('functionName: "isLive"') < lookup.indexOf('functionName: "matchesScope"'),
    "l'existence du titre doit être lue avant de vérifier son scope",
  );
  assert.match(lookup, /functionName: "getDataset"[\s\S]*?\.catch\(\(\) => null\)/);
  assert.doesNotMatch(lookup, /onChainId === `0x\$\{"0"\.repeat\(64\)\}`/);
});

test("la suppression réconcilie un tombstone déjà confirmé", () => {
  const preparation = SOURCE.slice(
    SOURCE.indexOf("export async function prepareDatasetDestruction"),
    SOURCE.indexOf("export async function deleteDataset"),
  );
  const deletion = SOURCE.slice(
    SOURCE.indexOf("export async function deleteDataset"),
    SOURCE.indexOf("export async function setDatasetVisibility"),
  );
  assert.match(preparation, /functionName: "isLive"/);
  assert.ok(
    deletion.indexOf("if (txHash) {") < deletion.indexOf('functionName: "isLive"'),
    "la confirmation d'un hash est optionnelle, mais l'état du titre EVM doit toujours être vérifié",
  );
  assert.doesNotMatch(deletion, /Hash de tombstone EVM manquant/);
});

test("un dataset déjà supprimé peut finaliser son titre EVM", () => {
  const preparation = SOURCE.slice(
    SOURCE.indexOf("export async function prepareDatasetDestruction"),
    SOURCE.indexOf("export async function deleteDataset"),
  );
  const deletion = SOURCE.slice(
    SOURCE.indexOf("export async function deleteDataset"),
    SOURCE.indexOf("export async function setDatasetVisibility"),
  );
  assert.ok(
    preparation.indexOf('if (!dataset.evmDatasetId) {') < preparation.indexOf('if (dataset.status === "DRAFT" || dataset.status === "DELETED") return null;'),
    "un dataset avec titre EVM doit toujours passer par la vérification on-chain",
  );
  assert.match(deletion, /status: "DELETED",\s+evmDestroyTxHash: dataset\.evmDestroyTxHash,\s+deletionReconciledAt: dataset\.deletionReconciledAt,/);
});

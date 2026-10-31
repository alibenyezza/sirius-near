"use client";

import { useWalletStore } from "@/stores/wallet";
import {
  parseDelegationMessage,
  runnerGrantMessage,
  runnerIntent,
  type AuthorizedRunnerOperation,
  type RunnerDelegation,
  type RunnerGrant,
  type RunnerGrantScope,
} from "./authorization-contract";

const GRANT_TTL_MS = 60_000;
const DB_NAME = "sirius-auth";
const STORE_NAME = "runner-delegation";
const DB_VERSION = 1;
const RECORD_ID = "current";

interface StoredRunnerDelegation {
  id: typeof RECORD_ID;
  privateKey: CryptoKey;
  delegation: RunnerDelegation;
}

let pendingKey: CryptoKeyPair | null = null;
let active: { privateKey: CryptoKey; delegation: RunnerDelegation } | null = null;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB indisponible"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Écriture locale annulée"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Écriture locale échouée"));
  });
}

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Stockage local indisponible"));
  });
}

async function readStoredDelegation(): Promise<StoredRunnerDelegation | undefined> {
  const db = await openDatabase();
  if (!db) return undefined;
  try {
    return await requestResult(
      db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(RECORD_ID) as IDBRequest<StoredRunnerDelegation | undefined>,
    );
  } finally {
    db.close();
  }
}

async function storeDelegation(record: StoredRunnerDelegation): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

async function removeStoredDelegation(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(RECORD_ID);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

function delegationMatchesWallet(delegation: RunnerDelegation, address: string | null, network: string | null): boolean {
  const fields = parseDelegationMessage(delegation.message);
  return !!fields && fields.address === address && fields.network === network && fields.expiresAt > Date.now();
}

async function restoreRunnerDelegation(address: string | null, network: string | null): Promise<boolean> {
  if (active && delegationMatchesWallet(active.delegation, address, network)) return true;
  active = null;
  try {
    const stored = await readStoredDelegation();
    if (!stored || !delegationMatchesWallet(stored.delegation, address, network)) {
      await removeStoredDelegation();
      return false;
    }
    active = { privateKey: stored.privateKey, delegation: stored.delegation };
    return true;
  } catch {
    return false;
  }
}

export async function hasRunnerDelegation(address: string, network: string | null): Promise<boolean> {
  return restoreRunnerDelegation(address, network);
}

export async function beginRunnerDelegation(): Promise<string> {
  await clearRunnerDelegation();
  pendingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("spki", pendingKey.publicKey);
  return encodeBase64Url(new Uint8Array(publicKey));
}

export async function activateRunnerDelegation(delegation: RunnerDelegation): Promise<void> {
  if (!pendingKey) throw new Error("Clé de session runner absente");
  const fields = parseDelegationMessage(delegation.message);
  if (!fields || fields.sessionPublicKey !== delegation.sessionPublicKey) {
    throw new Error("Délégation runner invalide");
  }
  active = { privateKey: pendingKey.privateKey, delegation };
  pendingKey = null;
  await storeDelegation({ id: RECORD_ID, privateKey: active.privateKey, delegation }).catch(() => {});
}

export async function clearRunnerDelegation(): Promise<void> {
  pendingKey = null;
  active = null;
  await removeStoredDelegation().catch(() => {});
}

export async function issueRunnerGrant(
  operation: AuthorizedRunnerOperation,
  scope: RunnerGrantScope,
  intentParts: readonly string[],
): Promise<RunnerGrant> {
  const { address, network } = useWalletStore.getState();
  if (!(await restoreRunnerDelegation(address, network)) || !active) {
    useWalletStore.getState().setAuthenticated(false);
    throw new Error("Réauthentifie ton wallet pour autoriser le runner");
  }
  const fields = parseDelegationMessage(active.delegation.message);
  if (
    !fields ||
    fields.expiresAt <= Date.now() ||
    fields.address !== address ||
    fields.network !== network
  ) {
    await clearRunnerDelegation();
    useWalletStore.getState().setAuthenticated(false);
    throw new Error("Délégation runner expirée — réauthentifie ton wallet");
  }

  const now = Date.now();
  const payload = {
    version: 1 as const,
    operation,
    subject: fields.address,
    network: fields.network,
    ...scope,
    payloadHash: await sha256(runnerIntent(intentParts)),
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    issuedAt: now,
    expiresAt: Math.min(now + GRANT_TTL_MS, fields.expiresAt),
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    active.privateKey,
    new TextEncoder().encode(runnerGrantMessage(payload)),
  );
  return { delegation: active.delegation, payload, signature: encodeBase64Url(new Uint8Array(signature)) };
}

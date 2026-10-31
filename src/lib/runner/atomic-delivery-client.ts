"use client";

import { createRunnerReleaseDelivery, decryptRunnerRelease } from "./delivery-client";
import type { RunnerReleaseEnvelope } from "@/lib/tee/contract";
import { serializeRunnerReleaseEnvelope } from "./release-envelope";

const DB_NAME = "sirius-runner";
const STORE_NAME = "loan-releases";
const DB_VERSION = 1;

interface StoredLoanRelease {
  id: string;
  context: string;
  privateKey: CryptoKey;
  publicKey: string;
  envelope?: RunnerReleaseEnvelope;
}

function recordId(address: string, loanId: string): string {
  return `${address}:${loanId}`;
}

function releaseContext(address: string, loanId: string): string {
  return `loan:${address}:${loanId}`;
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Stockage sécurisé indisponible"));
  });
}

async function readRecord(id: string): Promise<StoredLoanRelease | undefined> {
  const db = await openDatabase();
  try {
    return await requestResult(
      db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id) as IDBRequest<
        StoredLoanRelease | undefined
      >,
    );
  } finally {
    db.close();
  }
}

async function writeRecord(record: StoredLoanRelease): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function prepareAtomicLoanDelivery(address: string, loanId: string): Promise<string> {
  const context = releaseContext(address, loanId);
  const delivery = await createRunnerReleaseDelivery(context);
  await writeRecord({
    id: recordId(address, loanId),
    context,
    privateKey: delivery.privateKey,
    publicKey: delivery.publicKey,
  });
  return delivery.publicKey;
}

export async function persistAtomicLoanEnvelope(
  address: string,
  loanId: string,
  envelope: RunnerReleaseEnvelope,
): Promise<string> {
  const id = recordId(address, loanId);
  const record = await readRecord(id);
  if (!record) throw new Error("Clé locale de livraison absente");
  await writeRecord({ ...record, envelope });
  return persistedAtomicLoanEnvelopeHash(address, loanId);
}

export async function hasAtomicLoanEnvelope(address: string, loanId: string): Promise<boolean> {
  return !!(await readRecord(recordId(address, loanId)))?.envelope;
}

export async function persistedAtomicLoanEnvelopeHash(address: string, loanId: string): Promise<string> {
  const envelope = (await readRecord(recordId(address, loanId)))?.envelope;
  if (!envelope) throw new Error("Capsule locale de livraison absente");
  const encoded = new TextEncoder().encode(serializeRunnerReleaseEnvelope(envelope));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function openAtomicLoanEnvelope(
  address: string,
  loanId: string,
  fulfillmentHex: string,
): Promise<string> {
  const record = await readRecord(recordId(address, loanId));
  if (!record?.envelope) throw new Error("Capsule locale de livraison absente");
  return decryptRunnerRelease(record.privateKey, record.envelope, record.context, fulfillmentHex);
}

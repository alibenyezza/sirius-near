"use client";

import { createRunnerDelivery, decryptSavedRunnerDelivery } from "@/lib/runner/delivery-client";
import type { RunnerDeliveryEnvelope } from "@/lib/tee/contract";

interface DeliveryKey { id: string; owner: string; publicKey: string; privateKey: CryptoKey }

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sirius-phala-deliveries", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Stockage local des clés indisponible"));
    request.onblocked = () => reject(new Error("Ferme les autres onglets Sirius puis réessaie"));
  });
}

async function keyRecord(id: string, value?: DeliveryKey): Promise<DeliveryKey | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("keys", value ? "readwrite" : "readonly");
      const request = value ? tx.objectStore("keys").put(value) : tx.objectStore("keys").get(id);
      tx.oncomplete = () => resolve(value ?? request.result);
      tx.onerror = () => reject(new Error("Stockage local des clés indisponible"));
      tx.onabort = () => reject(new Error("Enregistrement de clé interrompu"));
    });
  } finally { db.close(); }
}

export async function prepareDemoDelivery(jobId: string, owner: string) {
  const normalized = owner.toLowerCase();
  const delivery = await createRunnerDelivery(`self-train:${normalized}:${jobId}`);
  await keyRecord(jobId, { id: jobId, owner: normalized, publicKey: delivery.publicKey, privateKey: delivery.privateKey });
  return delivery;
}

export async function openDemoDelivery(jobId: string, owner: string, publicKey: string, envelope: RunnerDeliveryEnvelope) {
  const key = await keyRecord(jobId);
  if (!key || key.owner !== owner.toLowerCase() || key.publicKey !== publicKey) {
    throw new Error("Clé locale absente : utilise le navigateur ayant lancé cet entraînement");
  }
  return decryptSavedRunnerDelivery(key.privateKey, envelope, `self-train:${key.owner}:${jobId}`);
}

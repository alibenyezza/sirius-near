import "server-only";
import { setTimeout as wait } from "node:timers/promises";
import { AppError } from "@/lib/app-error";

const UPLOAD_ENDPOINT = "https://uploads.pinata.cloud/v3/files";
export const MAX_IPFS_BLOB_BYTES = 8 * 1024 * 1024;
const IPFS_TIMEOUT_MS = 20_000;

class IpfsBodyError extends Error {}

async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new IpfsBodyError("Réponse IPFS trop volumineuse");
  }
  if (!response.body) throw new IpfsBodyError("Réponse IPFS vide");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new IpfsBodyError("Réponse IPFS trop volumineuse");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes);
}

export interface IpfsUpload {
  cid: string;
  size: number;
}

function getJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT manquante");
  return jwt;
}

function getGateway(): string {
  return (process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud").replace(/\/+$/, "");
}

/** Upload d'un blob (déjà chiffré) sur IPFS public via Pinata. Renvoie le CID. */
export async function uploadToIpfs(data: Buffer, name: string, signal?: AbortSignal): Promise<IpfsUpload> {
  if (data.length > MAX_IPFS_BLOB_BYTES) throw new Error("Blob IPFS trop volumineux");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), name);
  form.append("network", "public");

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${getJwt()}` },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(IPFS_TIMEOUT_MS)]) : AbortSignal.timeout(IPFS_TIMEOUT_MS),
  });

  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Pinata upload échoué (${res.status})`);
  }

  const { data: payload } = JSON.parse((await boundedBody(res, 64 * 1024)).toString()) as { data: { cid: string; size: number } };
  return { cid: payload.cid, size: payload.size };
}

/** Une tentative de lecture, bornée dans le temps. */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [400, 1_200];

/** Les reprises du gateway restent soumises au budget et au plafond de taille du runner. */
export async function fetchFromIpfs(cid: string, signal?: AbortSignal): Promise<Buffer> {
  const url = `${getGateway()}/ipfs/${encodeURIComponent(cid)}`;
  let lastStatus: number | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    attempts = attempt;
    try {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (res.ok) return await boundedBody(res, MAX_IPFS_BLOB_BYTES);
      await res.body?.cancel();
      if (res.status === 404) throw new AppError("Fichier introuvable sur IPFS", 404);
      lastStatus = res.status;
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError || error instanceof IpfsBodyError) throw error;
      // Réseau coupé ou délai dépassé : transitoire, on retente comme un 5xx.
      lastStatus = null;
    }
    if (attempt < FETCH_ATTEMPTS) await wait(FETCH_BACKOFF_MS[attempt - 1], undefined, { signal });
  }
  console.error(`[ipfs] lecture échouée après ${attempts} tentatives${lastStatus ? ` (dernier statut ${lastStatus})` : ""}`);
  throw new AppError("Stockage IPFS indisponible — réessaie dans un instant.", 503);
}

const FILES_API = "https://api.pinata.cloud/v3/files/public";

/**
 * Dépinne un CID de notre compte Pinata (API v3 : résout le(s) file id par CID
 * puis DELETE). Best-effort : ne garantit pas la disparition du réseau IPFS public
 * (d'autres nœuds peuvent avoir répliqué) → la vraie garantie d'effacement reste le
 * crypto-shredding (destruction de la DEK). No-op si le CID n'est plus référencé.
 */
export async function unpinFromIpfs(cid: string): Promise<void> {
  const auth = { Authorization: `Bearer ${getJwt()}` };

  const listRes = await fetch(`${FILES_API}?cid=${encodeURIComponent(cid)}`, { headers: auth });
  if (!listRes.ok) throw new Error(`Pinata list échoué (${listRes.status}): ${await listRes.text()}`);
  const { data } = (await listRes.json()) as { data: { files: { id: string }[] } };

  await Promise.all(
    (data?.files ?? []).map(async (file) => {
      const del = await fetch(`${FILES_API}/${file.id}`, { method: "DELETE", headers: auth });
      if (!del.ok && del.status !== 404) {
        throw new Error(`Pinata delete échoué (${del.status}) pour ${file.id}`);
      }
    }),
  );
}

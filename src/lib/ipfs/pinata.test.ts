import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppError } from "@/lib/app-error";
import { fetchFromIpfs, MAX_IPFS_BLOB_BYTES, uploadToIpfs } from "./pinata";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("le téléchargement s’arrête dès qu’un flux sans Content-Length dépasse le plafond", async () => {
  let cancelled = false;
  let calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_IPFS_BLOB_BYTES / 2 + 1)); },
      cancel() { cancelled = true; },
    }));
  };
  await assert.rejects(fetchFromIpfs("bafy-dataset"), /trop volumineuse/);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test("une taille déclarée excessive est rejetée sans lire le blob", async () => {
  globalThis.fetch = async () => new Response("", { headers: { "content-length": String(MAX_IPFS_BLOB_BYTES + 1) } });
  await assert.rejects(fetchFromIpfs("bafy-dataset"), /trop volumineuse/);
});

test("un blob autorisé reste identique après lecture bornée", async () => {
  globalThis.fetch = async () => new Response("encrypted-dataset");
  assert.equal((await fetchFromIpfs("bafy-dataset")).toString(), "encrypted-dataset");
});

test("un upload surdimensionné est refusé avant l’appel payant", async () => {
  globalThis.fetch = async () => { assert.fail("upload envoyé"); };
  await assert.rejects(uploadToIpfs(Buffer.alloc(MAX_IPFS_BLOB_BYTES + 1), "test.enc"), /trop volumineux/);
});

function avecFetch(reponses: Array<number | Error>): { restaurer: () => void; appels: () => number } {
  const original = globalThis.fetch;
  let appels = 0;
  globalThis.fetch = (async () => {
    const r = reponses[Math.min(appels, reponses.length - 1)];
    appels += 1;
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? "ok" : "", { status: r });
  }) as typeof fetch;
  return { restaurer: () => { globalThis.fetch = original; }, appels: () => appels };
}

test("un refus transitoire du gateway est retenté puis servi", async () => {
  const f = avecFetch([429, 503, 200]);
  try {
    const buffer = await fetchFromIpfs("bafytest");
    assert.equal(buffer.toString(), "ok");
    assert.equal(f.appels(), 3);
  } finally { f.restaurer(); }
});

test("un gateway durablement indisponible devient un 503 lisible, pas un 500 muet", async () => {
  const f = avecFetch([new TypeError("fetch failed")]);
  try {
    await assert.rejects(fetchFromIpfs("bafytest"), (e: unknown) => e instanceof AppError && e.status === 503);
    assert.equal(f.appels(), 3);
  } finally { f.restaurer(); }
});

test("un fichier absent n'est pas retenté", async () => {
  const f = avecFetch([404]);
  try {
    await assert.rejects(fetchFromIpfs("bafytest"), (e: unknown) => e instanceof AppError && e.status === 404);
    assert.equal(f.appels(), 1);
  } finally { f.restaurer(); }
});

test("une réponse trop volumineuse après un refus transitoire ne provoque pas de nouvelle tentative", async () => {
  let calls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
    return new Response("", { headers: { "content-length": String(MAX_IPFS_BLOB_BYTES + 1) } });
  };
  await assert.rejects(fetchFromIpfs("bafy-dataset"), /trop volumineuse/);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});

test("un budget déjà expiré interdit toute lecture IPFS", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => { assert.fail("lecture envoyée après expiration"); };
  await assert.rejects(fetchFromIpfs("bafy-dataset", controller.signal), { name: "AbortError" });
});

test("l’annulation pendant la requête est propagée sans nouvelle tentative", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    assert.ok(options?.signal);
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  };
  await assert.rejects(fetchFromIpfs("bafy-dataset", controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("l’annulation interrompt aussi l’attente entre deux tentatives", async () => {
  const controller = new AbortController();
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  globalThis.fetch = async () => {
    calls++;
    timer = setTimeout(() => controller.abort(), 10);
    return new Response("", { status: 503 });
  };
  try {
    await assert.rejects(fetchFromIpfs("bafy-dataset", controller.signal), { name: "AbortError" });
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test("une interruption du flux réseau reste récupérable dans le budget de lecture", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("stream interrupted")); } }))
      : new Response("encrypted-dataset");
  };
  assert.equal((await fetchFromIpfs("bafy-dataset")).toString(), "encrypted-dataset");
  assert.equal(calls, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { previewCookieValid, previewCookieValue } from "./gate";
import { handlePreviewRequest } from "./preview-route";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ACTIVE = { SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: KEY };
const ORIGIN = "https://sirius-data.tech";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** Exécute `run` en capturant tout ce qui serait écrit sur la console. */
async function capturingConsole<T>(run: () => Promise<T>): Promise<{ result: T; written: string }> {
  const lines: string[] = [];
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }
  try {
    const result = await run();
    return { result, written: lines.join("\n") };
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
}

function serialized(response: Response, body: string): string {
  return `${response.status} ${JSON.stringify([...response.headers.entries()])} ${body}`;
}

test("bonne clé : cookie HMAC, 7 jours, HttpOnly, Secure en production, SameSite=Lax, Path=/, puis redirection vers /", async () => {
  const response = await handlePreviewRequest(new Request(`${ORIGIN}/preview?key=${KEY}`), ACTIVE, true);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookie = response.headers.get("set-cookie") ?? "";
  const [pair, ...attributes] = cookie.split("; ");
  const [name, value] = pair.split("=");
  assert.equal(name, "sirius_preview");
  assert.equal(value, await previewCookieValue(KEY));
  assert.equal(await previewCookieValid(KEY, value), true);
  assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax", "Secure"].sort());
  assert.equal(await response.text(), "");
});

test("hors production, le cookie n'est pas Secure (le dev local est en http)", async () => {
  const response = await handlePreviewRequest(new Request(`http://localhost:3000/preview?key=${KEY}`), ACTIVE, false);
  assert.equal(response.status, 302);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.equal(cookie.includes("Secure"), false);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("mauvaise clé, clé absente, porte inactive, clé non configurée : le même 404 nu", async () => {
  const requests: Array<[Request, Record<string, string>]> = [
    [new Request(`${ORIGIN}/preview?key=${KEY.slice(0, -1)}`), ACTIVE],
    [new Request(`${ORIGIN}/preview?key=${KEY}0`), ACTIVE],
    [new Request(`${ORIGIN}/preview?key=`), ACTIVE],
    [new Request(`${ORIGIN}/preview`), ACTIVE],
    [new Request(`${ORIGIN}/preview?cle=${KEY}`), ACTIVE],
    [new Request(`${ORIGIN}/preview?key=${KEY}`), { SIRIUS_PREVIEW_KEY: KEY }],
    [new Request(`${ORIGIN}/preview?key=${KEY}`), { SIRIUS_PREVIEW_GATE: "false", SIRIUS_PREVIEW_KEY: KEY }],
    [new Request(`${ORIGIN}/preview?key=${KEY}`), { SIRIUS_PREVIEW_GATE: "true" }],
    [new Request(`${ORIGIN}/preview?key=court`), { SIRIUS_PREVIEW_GATE: "true", SIRIUS_PREVIEW_KEY: "court" }],
  ];
  let reference: string | null = null;
  for (const [request, env] of requests) {
    const response = await handlePreviewRequest(request, env, true);
    assert.equal(response.status, 404, request.url);
    assert.equal(response.headers.get("set-cookie"), null, request.url);
    const body = await response.text();
    const shape = serialized(response, body);
    if (reference === null) reference = shape;
    else assert.equal(shape, reference, `réponses indistinguables : ${request.url}`);
  }
});

test("la clé n'apparaît ni dans la console, ni dans les réponses, ni dans le cookie", async () => {
  const { result, written } = await capturingConsole(async () => {
    const outputs: string[] = [];
    for (const [url, env] of [
      [`${ORIGIN}/preview?key=${KEY}`, ACTIVE],
      [`${ORIGIN}/preview?key=${KEY}x`, ACTIVE],
      [`${ORIGIN}/preview`, ACTIVE],
      [`${ORIGIN}/preview?key=${KEY}`, {}],
    ] as const) {
      const response = await handlePreviewRequest(new Request(url), env, true);
      outputs.push(serialized(response, await response.text()));
    }
    return outputs;
  });
  assert.equal(written, "", "aucune écriture console");
  for (const output of result) assert.equal(output.includes(KEY), false, output);
});

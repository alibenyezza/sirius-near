import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import * as errors from "../errors";
import * as body from "../http/body";
import * as rate from "../http/rate-limit";
import * as access from "../sirius/self-training-access";
import * as admin from "./admin";
import { EN_MESSAGES } from "../i18n/english";

/**
 * Deux familles de contrôles sur le self training réservé à l'équipe (N5) :
 *  - par inspection de l'arbre syntaxique (pas de simple recherche de texte, qu'un commentaire
 *    ou une chaîne pourrait satisfaire) : chaque handler exporté sous /api/train appelle la
 *    garde juste après `requireAuth`, avant tout corps, toute base, tout grant et tout runner ;
 *    et aucun autre fichier n'atteint le module self-train ni les opérations runner du self
 *    training, quelle que soit la forme de l'import ;
 *  - par exécution des routes dans un bac à sable (même technique que audit-regressions.test.ts) :
 *    un wallet non admin reçoit 403 « Bientôt disponible » sans qu'aucune dépendance coûteuse
 *    ne soit touchée et sans que le corps soit lu.
 */

const ROOT = process.cwd();
const ADMIN = `0x${"ab".repeat(20)}`;
const VISITOR = `0x${"cd".repeat(20)}`;
const ENV_KEYS = ["SIRIUS_ADMIN_ADDRESSES", "SIRIUS_PHALA_DEMO", "EVM_NETWORK", "TEE_MODE", "DSTACK_SIMULATOR_ENDPOINT"] as const;
const DEMO_ENV = { SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet", TEE_MODE: "phala" };
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
}

function sourceFiles(directory: string, keep: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["generated", "node_modules"].includes(entry.name) ? [] : sourceFiles(path, keep);
    return keep(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const SELF_TRAINING_ROUTES = sourceFiles(join(ROOT, "src", "app", "api", "train"), (name) => /^route\.(ts|tsx|js|mjs|cjs)$/.test(name)).sort();
const SOURCES = sourceFiles(join(ROOT, "src"), (name) => /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\.(ts|tsx|js|mjs|cjs)$/.test(name));

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/** Handlers HTTP exportés, sous toutes les formes de déclaration ; une réexportation est refusée. */
function handlers(source: ts.SourceFile): { method: string; node: ts.Node }[] {
  const found: { method: string; node: ts.Node }[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
      if (HTTP_METHODS.has(statement.name.text)) found.push({ method: statement.name.text, node: statement });
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          assert.fail(`${source.fileName} : export par déstructuration non inspecté (${declaration.getText(source).slice(0, 60)})`);
        }
        if (HTTP_METHODS.has(declaration.name.text)) found.push({ method: declaration.name.text, node: declaration.initializer ?? declaration });
      }
    } else if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      assert.fail(`${source.fileName} : réexportation non inspectée (${statement.getText(source).slice(0, 60)})`);
    }
  }
  return found;
}

interface Call { name: string; pos: number }

/** Appels de fonction d'un handler, dans l'ordre du code, hors commentaires et chaînes. */
function calls(node: ts.Node, source: ts.SourceFile): Call[] {
  const out: Call[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) out.push({ name: child.expression.getText(source), pos: child.getStart(source) });
    ts.forEachChild(child, visit);
  };
  visit(node);
  return out.sort((a, b) => a.pos - b.pos);
}

function positions(node: ts.Node, source: ts.SourceFile, match: (child: ts.Node) => boolean): number[] {
  const out: number[] = [];
  const visit = (child: ts.Node) => { if (match(child)) out.push(child.getStart(source)); ts.forEachChild(child, visit); };
  visit(node);
  return out;
}

/** Spécificateurs de module importés par un fichier : import statique, réexport, import() et require(). */
function importedModules(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Vrai si `specifier`, importé depuis `file`, désigne le module `target` (chemin sans extension depuis la racine). */
function resolvesTo(file: string, specifier: string, target: string): boolean {
  let path: string;
  if (specifier.startsWith("@/")) path = join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) path = relative(ROOT, resolve(ROOT, dirname(file), specifier));
  else return false;
  return path.replace(/\.(ts|tsx|js|mjs|cjs)$/, "").replace(/\/index$/, "") === target;
}

function importersOf(target: string, files = SOURCES): string[] {
  return files.filter((file) => importedModules(parse(file)).some((specifier) => resolvesTo(file, specifier, target))).sort();
}

function identifiers(source: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && node.text === name) count += 1; ts.forEachChild(node, visit); };
  visit(source);
  return count;
}

const EXPENSIVE = /^(prisma\.|readJson\b|assertAuthenticGrant\b|runSelfTrain\b|selfTrainModelKeyInRunner\b|enforceRateLimit\b|assertCurrentRunner\b|assertOwner\b)/;

test("les routes de self training sont bien celles attendues", () => {
  assert.deepEqual(SELF_TRAINING_ROUTES, ["src/app/api/train/[id]/key/route.ts", "src/app/api/train/route.ts"]);
});

test("chaque handler de self training appelle la garde admin juste après requireAuth, avant tout le reste", () => {
  for (const file of SELF_TRAINING_ROUTES) {
    const source = parse(file);
    assert.ok(importedModules(source).some((module) => module.endsWith("/sirius/self-training-access")), `${file} importe la garde`);
    const exported = handlers(source);
    assert.ok(exported.length > 0, `${file} exporte au moins un handler`);
    for (const { method, node } of exported) {
      const sequence = calls(node, source);
      const auth = sequence.find((call) => call.name === "requireAuth");
      const guard = sequence.find((call) => call.name === "assertSelfTrainingAccess");
      assert.ok(auth, `${file} ${method} : requireAuth`);
      assert.ok(guard && guard.pos > auth.pos, `${file} ${method} : la garde suit requireAuth`);
      const awaits = positions(node, source, ts.isAwaitExpression);
      assert.ok(!awaits.some((pos) => pos > auth.pos && pos < guard.pos), `${file} ${method} : rien d'asynchrone entre requireAuth et la garde`);
      for (const call of sequence) {
        if (EXPENSIVE.test(call.name)) assert.ok(call.pos > guard.pos, `${file} ${method} : ${call.name} vient après la garde`);
      }
      const params = positions(node, source, (child) => ts.isIdentifier(child) && child.text === "params"
        && !ts.isBindingElement(child.parent) && !ts.isParameter(child.parent) && !ts.isPropertySignature(child.parent));
      for (const pos of params) assert.ok(pos > guard.pos, `${file} ${method} : params lu après la garde`);
    }
  }
});

test("la liste des jobs et le lancement tolèrent la démo Phala, la livraison de clé non", () => {
  const train = parse("src/app/api/train/route.ts");
  const byMethod = Object.fromEntries(handlers(train).map(({ method, node }) => [method, node]));
  const args = (node: ts.Node) => calls(node, train).filter((call) => call.name === "assertSelfTrainingAccess")
    .map((call) => train.text.slice(call.pos, train.text.indexOf(");", call.pos)).replace(/^assertSelfTrainingAccess\(/, ""));
  assert.deepEqual(args(byMethod.GET), ["session, true"]);
  assert.deepEqual(args(byMethod.POST), ["session, true", "session, isDemoTrainingGrant(authorization)"]);
  const post = calls(byMethod.POST, train);
  const first = post.find((call) => call.name === "assertSelfTrainingAccess")!;
  const second = post.filter((call) => call.name === "assertSelfTrainingAccess")[1];
  const readBody = post.find((call) => call.name === "readJson")!;
  const grant = post.find((call) => call.name === "assertAuthenticGrant")!;
  assert.ok(first.pos < readBody.pos, "premier refus avant le corps");
  assert.ok(readBody.pos < second.pos && second.pos < grant.pos, "second refus entre le corps et le grant");

  const key = parse("src/app/api/train/[id]/key/route.ts");
  const [{ node }] = handlers(key);
  assert.deepEqual(calls(node, key).filter((call) => call.name === "assertSelfTrainingAccess")
    .map((call) => key.text.slice(call.pos, key.text.indexOf(");", call.pos))), ["assertSelfTrainingAccess(session"]);
});

test("la résolution des imports reconnaît l'alias, les chemins relatifs, frères et avec extension", () => {
  const target = "src/lib/sirius/self-train";
  for (const [file, specifier] of [
    ["src/lib/sirius/trainer.ts", "./self-train"], ["src/lib/sirius/trainer.ts", "./self-train.ts"],
    ["src/lib/auth/x.ts", "../sirius/self-train.js"], ["src/app/api/x/route.ts", "@/lib/sirius/self-train"],
    ["src/app/api/x/route.ts", "@/lib/sirius/self-train.ts"], ["src/app/api/x/route.ts", "../../../lib/sirius/self-train"],
  ]) assert.equal(resolvesTo(file, specifier, target), true, `${file} → ${specifier}`);
  for (const [file, specifier] of [
    ["src/lib/sirius/trainer.ts", "./self-training-access"], ["src/lib/sirius/trainer.ts", "self-train"],
    ["src/lib/sirius/trainer.ts", "@/lib/sirius/self-train-report"], ["src/lib/sirius/trainer.ts", "viem"],
  ]) assert.equal(resolvesTo(file, specifier, target), false, `${file} → ${specifier}`);
  const synthetic = ts.createSourceFile("src/lib/sirius/trainer.ts",
    'import { runSelfTrain } from "./self-train";\nexport { x } from "../sirius/self-train.ts";\nconst m = await import("@/lib/sirius/self-train");\nconst r = require("./self-train.js");',
    ts.ScriptTarget.Latest, true);
  assert.equal(importedModules(synthetic).filter((specifier) => resolvesTo("src/lib/sirius/trainer.ts", specifier, target)).length, 4);
});

test("aucun autre fichier n'atteint le self training, sous aucune forme d'import", () => {
  assert.deepEqual(importersOf("src/lib/sirius/self-train"), ["src/app/api/train/route.ts"]);
  // Listes exactes, `src/lib/tee/` compris : un réexport sous alias y serait vu.
  assert.deepEqual(SOURCES.filter((file) => identifiers(parse(file), "selfTrainModelKeyInRunner") > 0).sort(),
    ["src/app/api/train/[id]/key/route.ts", "src/lib/tee/runner-client.ts"]);
  assert.deepEqual(SOURCES.filter((file) => identifiers(parse(file), "runSelfTrainingInRunner") > 0).sort(),
    ["src/lib/sirius/self-train.ts", "src/lib/tee/runner-client.ts"]);
  // `runSelfTrain` est aussi le nom de la fonction navigateur de src/lib/train/client.ts ; tout nouvel usage doit être relu.
  assert.deepEqual(SOURCES.filter((file) => identifiers(parse(file), "runSelfTrain") > 0).sort(),
    ["src/app/(app)/train/page.tsx", "src/app/api/train/route.ts", "src/lib/sirius/self-train.ts", "src/lib/train/client.ts"]);
  // Le chemin runner en processus n'est joignable que par le client runner, jamais par une route.
  assert.deepEqual(importersOf("src/runner/handler", SOURCES.filter((file) => !file.startsWith("src/runner/"))), ["src/lib/tee/runner-client.ts"]);
  const guardCallers = SOURCES.filter((file) => file !== "src/lib/sirius/self-training-access.ts" && identifiers(parse(file), "assertSelfTrainingAccess") > 0).sort();
  assert.deepEqual(guardCallers, SELF_TRAINING_ROUTES, "la garde n'est appelée que par les routes de self training");
});

test("/api/admin/me est authentifiée, sans base, et répond avec la même liste que la garde", () => {
  const source = parse("src/app/api/admin/me/route.ts");
  const [{ method, node }] = handlers(source);
  assert.equal(method, "GET");
  const sequence = calls(node, source);
  const auth = sequence.find((call) => call.name === "requireAuth")!;
  const allowed = sequence.find((call) => call.name === "adminAllowed")!;
  assert.ok(auth.pos < allowed.pos);
  assert.ok(!importedModules(source).some((module) => module.endsWith("/lib/db") || module.endsWith("/http/body")));
  assert.match(read("src/app/api/admin/me/route.ts"), /"cache-control": "no-store"/);
  assert.equal(identifiers(parse("src/lib/sirius/self-training-access.ts"), "adminAllowed") > 0, true);
});

test("le message de refus est traduit et ne nomme ni la fonction ni le rôle", () => {
  assert.equal(access.SELF_TRAINING_UNAVAILABLE, "Bientôt disponible");
  assert.equal(EN_MESSAGES[access.SELF_TRAINING_UNAVAILABLE], "Coming soon");
  assert.doesNotMatch(access.SELF_TRAINING_UNAVAILABLE, /self|train|admin|équipe|opérateur|réservé/i);
  const error = access.selfTrainingUnavailable();
  assert.ok(error instanceof errors.AppError);
  assert.equal(error.status, 403);
});

test("l'exemption de démo exige la configuration complète d'une démo Phala et un grant de démo bien formé", () => {
  assert.equal(access.phalaDemoInstance(DEMO_ENV), true);
  assert.equal(access.phalaDemoInstance({ ...DEMO_ENV, DSTACK_SIMULATOR_ENDPOINT: "" }), true);
  for (const env of [
    {}, { SIRIUS_PHALA_DEMO: "true" }, { ...DEMO_ENV, EVM_NETWORK: "mainnet" }, { ...DEMO_ENV, EVM_NETWORK: undefined },
    { ...DEMO_ENV, SIRIUS_PHALA_DEMO: "1" }, { ...DEMO_ENV, SIRIUS_PHALA_DEMO: "TRUE" }, { ...DEMO_ENV, SIRIUS_PHALA_DEMO: "false" },
    { ...DEMO_ENV, TEE_MODE: "stub" }, { ...DEMO_ENV, TEE_MODE: undefined }, { ...DEMO_ENV, DSTACK_SIMULATOR_ENDPOINT: "http://sim" },
  ]) assert.equal(access.phalaDemoInstance(env), false, JSON.stringify(env));
  assert.equal(access.isDemoTrainingGrant({ payload: { demoSessionRevision: 1 } }), true);
  assert.equal(access.isDemoTrainingGrant({ payload: { demoSessionRevision: 12 } }), true);
  for (const grant of [undefined, null, "x", {}, { payload: null }, { payload: {} }, { payload: { demoSessionRevision: "12" } },
    { payload: { demoSessionRevision: 0 } }, { payload: { demoSessionRevision: -1 } }, { payload: { demoSessionRevision: 1.5 } },
    { payload: { demoSessionRevision: Number.MAX_SAFE_INTEGER + 1 } }, { payload: { demoSessionRevision: Infinity } },
    { payload: { demoSessionRevision: NaN } }, { demoSessionRevision: 1 }]) assert.equal(access.isDemoTrainingGrant(grant), false, String(JSON.stringify(grant)));
});

// ───────── Exécution des routes dans un bac à sable ─────────

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, Date, Map, Set, console, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

async function withEnv<T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try { return await run(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

test("les handlers inspectés sont exactement ceux que chaque module de route exporte", () => {
  const { train, key, me } = routes({ address: VISITOR, source: "external" });
  for (const [file, module] of [["src/app/api/train/route.ts", train], ["src/app/api/train/[id]/key/route.ts", key], ["src/app/api/admin/me/route.ts", me]] as const) {
    const exported = Object.keys(module).filter((name) => HTTP_METHODS.has(name)).sort();
    assert.deepEqual(exported, handlers(parse(file)).map(({ method }) => method).sort(), file);
    assert.ok(exported.length > 0, file);
  }
});

function routes(session: { address: string; source: "external" }) {
  const calls: string[] = [];
  const auth = {
    requireAuth: () => session,
    assertAuthenticGrant: async () => { calls.push("assertAuthenticGrant"); },
    assertOwner: () => { calls.push("assertOwner"); },
  };
  const train = load<typeof import("../../app/api/train/route")>("src/app/api/train/route.ts", {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { trainingJob: { findMany: async () => { calls.push("findMany"); return []; } } } },
    "@/lib/sirius/self-train": { runSelfTrain: async (_dataset: string, _owner: string, jobId: string) => {
      calls.push("runSelfTrain"); return { jobId, modelCid: "cid", runnerReceipt: "receipt", metrics: {} }; } },
    "@/lib/sirius/self-training-access": access,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
    "@/lib/http/body": body,
  });
  const key = load<typeof import("../../app/api/train/[id]/key/route")>("src/app/api/train/[id]/key/route.ts", {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { trainingJob: { findUnique: async () => { calls.push("findUnique"); return null; } } } },
    "@/lib/tee/runner-client": { selfTrainModelKeyInRunner: async () => { calls.push("selfTrainModelKeyInRunner"); return {}; } },
    "@/lib/sirius/self-training-access": access,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
    "@/lib/http/body": body,
    "@/lib/http/rate-limit": rate,
    "@/lib/runner/provenance": { assertCurrentRunner: async () => { calls.push("assertCurrentRunner"); } },
  });
  const me = load<typeof import("../../app/api/admin/me/route")>("src/app/api/admin/me/route.ts", {
    "next/server": { NextResponse },
    "@/lib/auth/admin": admin,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
  });
  return { train, key, me, calls };
}

const json = (url: string, payload: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const garbage = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "pas du JSON" });
const TRAIN = "https://test.invalid/api/train";
const KEY = "https://test.invalid/api/train/job-1/key";
const ME = "https://test.invalid/api/admin/me";
const params = { params: Promise.resolve({ id: "job-1" }) };
const grant = (extra: Record<string, unknown> = {}) => ({ payload: { subject: VISITOR, ...extra }, signature: "0x" });
const training = (extra?: Record<string, unknown>) => ({ datasetId: "ds-1", jobId: "job-1", datasetReceipt: "receipt", authorization: grant(extra) });

async function refused(request: Request, response: Response, calls: string[], bodyRead = false) {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Bientôt disponible" });
  assert.deepEqual(calls, [], "aucune dépendance touchée avant le refus");
  assert.equal(request.bodyUsed, bodyRead, bodyRead ? "sur la démo, le corps est lu pour reconnaître un grant de démo" : "le corps n'est pas lu avant le refus");
}

const send = async (route: (req: Request, ...rest: never[]) => Promise<Response>, request: Request, calls: string[], bodyRead = false) =>
  refused(request, await route(request), calls, bodyRead);
const sendKey = async (route: (req: Request, ctx: typeof params) => Promise<Response>, request: Request, calls: string[]) =>
  refused(request, await route(request, params), calls);

test("hors démo, un wallet non admin est refusé sur chaque route sans corps lu, ni base, ni grant, ni runner", async () => {
  await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN }, async () => {
    const { train, key, me, calls } = routes({ address: VISITOR, source: "external" });
    await send(train.GET, new Request(TRAIN), calls);
    await send(train.POST, garbage(TRAIN), calls);
    await send(train.POST, json(TRAIN, training()), calls);
    await send(train.POST, json(TRAIN, training({ demoSessionRevision: 1 })), calls);
    await sendKey(key.POST, garbage(KEY), calls);
    await sendKey(key.POST, json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), calls);
    const who = await me.GET(new Request(ME));
    assert.equal(who.status, 200);
    assert.deepEqual(await who.json(), { admin: false });
    assert.equal(who.headers.get("cache-control"), "no-store");
  });
});

test("un wallet de l'équipe passe la garde, quelle que soit la casse, et le flux continue dans l'ordre", async () => {
  const mixed = `0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb`;
  const upper = `0X${"AB".repeat(20)}`;
  for (const [configured, address] of [[ADMIN, ADMIN], [mixed, ADMIN], [`${VISITOR},${ADMIN}`, mixed], [upper, ADMIN], [ADMIN, upper]]) {
    await withEnv({ SIRIUS_ADMIN_ADDRESSES: configured }, async () => {
      const { train, key, me, calls } = routes({ address, source: "external" });
      const list = await train.GET(new Request(TRAIN));
      assert.equal(list.status, 200, `${configured} / ${address}`);
      assert.deepEqual(calls.splice(0), ["findMany"]);

      const created = await train.POST(json(TRAIN, training()));
      assert.equal(created.status, 201, await created.text());
      assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "runSelfTrain"]);

      const incomplete = await train.POST(json(TRAIN, { datasetId: "ds-1" }));
      assert.equal(incomplete.status, 400);
      assert.deepEqual(calls.splice(0), []);

      const delivery = await key.POST(json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), params);
      assert.equal(delivery.status, 404, "la garde passée, la route refuse le job inconnu comme avant");
      assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "findUnique"]);

      const who = await me.GET(new Request(ME));
      assert.deepEqual(await who.json(), { admin: true });
    });
  }
});

test("liste vide ou mal formée : même l'adresse attendue est refusée partout", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const configured of [undefined, "", `${ADMIN},oops`, `${ADMIN},`]) {
      await withEnv(configured === undefined ? {} : { SIRIUS_ADMIN_ADDRESSES: configured }, async () => {
        const { train, key, me, calls } = routes({ address: ADMIN, source: "external" });
        await send(train.GET, new Request(TRAIN), calls);
        await send(train.POST, json(TRAIN, training()), calls);
        await sendKey(key.POST, json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), calls);
        assert.deepEqual(await (await me.GET(new Request(ME))).json(), { admin: false });
      });
    }
  } finally { console.warn = warn; }
});

test("instance de démo Phala sur testnet : la part publique de la démo reste ouverte, le reste non", async () => {
  await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN, ...DEMO_ENV }, async () => {
    const { train, key, me, calls } = routes({ address: VISITOR, source: "external" });
    const list = await train.GET(new Request(TRAIN));
    assert.equal(list.status, 200, "la page de démo liste ses propres jobs");
    assert.deepEqual(calls.splice(0), ["findMany"]);

    await send(train.POST, json(TRAIN, training()), calls, true);
    await send(train.POST, json(TRAIN, training({ demoSessionRevision: "3" })), calls, true);
    await send(train.POST, json(TRAIN, training({ demoSessionRevision: 0 })), calls, true);
    await send(train.POST, json(TRAIN, training({ demoSessionRevision: -1 })), calls, true);
    await send(train.POST, json(TRAIN, training({ demoSessionRevision: 1.5 })), calls, true);
    await send(train.POST, json(TRAIN, { ...training(), authorization: { demoSessionRevision: 3 } }), calls, true);

    const demo = await train.POST(json(TRAIN, training({ demoSessionRevision: 3 })));
    assert.equal(demo.status, 201, await demo.text());
    assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "runSelfTrain"]);

    const malformed = await train.POST(garbage(TRAIN));
    assert.equal(malformed.status, 415, "sur la démo, le corps est lu pour reconnaître un grant de démo");
    assert.deepEqual(calls.splice(0), []);

    await sendKey(key.POST, json(KEY, { authorization: grant({ demoSessionRevision: 3 }), deliveryPublicKey: "k" }), calls);
    assert.deepEqual(await (await me.GET(new Request(ME))).json(), { admin: false });
  });
});

test("la démo n'exempte jamais hors testnet, hors enclave Phala, ni avec un drapeau approximatif", async () => {
  for (const env of [
    { ...DEMO_ENV, EVM_NETWORK: "mainnet" },
    { SIRIUS_PHALA_DEMO: "true", TEE_MODE: "phala" },
    { ...DEMO_ENV, SIRIUS_PHALA_DEMO: "1" },
    { ...DEMO_ENV, SIRIUS_PHALA_DEMO: "false" },
    { ...DEMO_ENV, TEE_MODE: "stub" },
    { ...DEMO_ENV, DSTACK_SIMULATOR_ENDPOINT: "http://localhost:8090" },
    { EVM_NETWORK: "testnet", TEE_MODE: "phala" },
  ]) {
    await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN, ...env }, async () => {
      const { train, key, calls } = routes({ address: VISITOR, source: "external" });
      await send(train.GET, new Request(TRAIN), calls);
      await send(train.POST, json(TRAIN, training({ demoSessionRevision: 3 })), calls);
      await sendKey(key.POST, json(KEY, { authorization: grant({ demoSessionRevision: 3 }), deliveryPublicKey: "k" }), calls);
    });
  }
});

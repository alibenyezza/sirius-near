import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

/**
 * Les pages de la marketplace sont des composants client : elles ne doivent atteindre, à
 * l'exécution, ni la base, ni le branchement serveur de la marketplace, ni un module réservé au
 * serveur. Les types du serveur (`CatalogueResponse`, `DetailResponse`) sont importés avec
 * `import type`, effacé à la compilation.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const posix = (path: string) => path.replace(/\\/g, "/");
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const FORBIDDEN_PACKAGES = new Set(["server-only", "pg", "better-sqlite3", "@prisma/client", "@prisma/adapter-pg", "@phala/dstack-sdk", "@phala/dcap-qvl"]);
const FORBIDDEN_FILES = [
  "src/lib/db.ts",
  "src/lib/marketplace/catalogue.ts",
  "src/lib/marketplace/server.ts",
  "src/lib/marketplace/kyb.ts",
  "src/lib/marketplace/test-fixtures.ts",
  "src/lib/billing/config.ts",
  "src/lib/evm/client.ts",
];

function resolveLocal(specifier: string, from: string): string | null {
  const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Spécificateurs réellement chargés à l'exécution (les imports de types sont effacés). */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause !== undefined && (clause.isTypeOnly
        || (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        found.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function reachable(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const local = resolveLocal(specifier, file);
        // Feuilles de style et ressources : sans import de code.
        if (!local && /\.(css|json|svg|png)$/.test(specifier)) continue;
        assert.ok(local, `import local introuvable : ${specifier} (depuis ${file})`);
        queue.push(local);
      } else {
        packages.add(specifier.replace(/^node:/, ""));
      }
    }
  }
  return { files: new Set([...files].map(posix)), packages };
}

test("les modules partagés de la marketplace se chargent côté client sans rien du serveur", () => {
  const { files, packages } = reachable(
    ["categories.ts", "query.ts", "listing.ts", "token.ts"].map((name) => join(root, "src/lib/marketplace", name)),
  );
  for (const name of packages) {
    assert.ok(!FORBIDDEN_PACKAGES.has(name), `paquet réservé au serveur atteint : ${name}`);
    assert.ok(!BUILTINS.has(name.split("/")[0]), `module Node atteint : ${name}`);
  }
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /import\s+["']server-only["']/, file);
});

test("les pages de la marketplace n'atteignent ni la base ni le branchement serveur", () => {
  const pages = [
    "src/app/(app)/marketplace/page.tsx",
    "src/app/(app)/marketplace/[id]/page.tsx",
  ].map((path) => join(root, path));
  const { files, packages } = reachable(pages);
  assert.ok([...files].some((file) => file.endsWith("src/lib/marketplace/listing.ts") || file.endsWith("src/lib/marketplace/categories.ts")));
  for (const forbidden of FORBIDDEN_FILES) {
    assert.ok(![...files].some((file) => file.endsWith(forbidden)), `${forbidden} atteint depuis une page client`);
  }
  for (const name of ["server-only", "pg", "@prisma/client", "@prisma/adapter-pg", "better-sqlite3"]) {
    assert.ok(!packages.has(name), `${name} atteint depuis une page client`);
  }
});

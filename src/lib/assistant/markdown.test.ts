import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedExternalHref, markdownToPlainText, parseMarkdown, parseMarkdownInline, safeMarkdownHref, type MarkdownInline } from "./markdown";

function types(nodes: readonly MarkdownInline[]): string[] {
  return nodes.flatMap((node) => [node.type, ...("children" in node ? types(node.children) : [])]);
}

test("gras, italique, code en ligne, liens et retours à la ligne sont reconnus", () => {
  const nodes = parseMarkdownInline("Ouvre la **Marketplace**, puis *Emprunter* : `escrow` — voir [la page](/marketplace) ou https://sirius-data.tech/docs.\nSuite");
  assert.deepEqual(nodes, [
    { type: "text", text: "Ouvre la " },
    { type: "strong", children: [{ type: "text", text: "Marketplace" }] },
    { type: "text", text: ", puis " },
    { type: "em", children: [{ type: "text", text: "Emprunter" }] },
    { type: "text", text: " : " },
    { type: "code", text: "escrow" },
    { type: "text", text: " — voir " },
    { type: "link", href: "/marketplace", external: false, children: [{ type: "text", text: "la page" }] },
    { type: "text", text: " ou " },
    { type: "link", href: "https://sirius-data.tech/docs", external: true, children: [{ type: "text", text: "https://sirius-data.tech/docs" }] },
    { type: "text", text: "." },
    { type: "br" },
    { type: "text", text: "Suite" },
  ]);
  assert.deepEqual(parseMarkdownInline("__fort__ et _doux_ mais snake_case_reste"), [
    { type: "strong", children: [{ type: "text", text: "fort" }] },
    { type: "text", text: " et " },
    { type: "em", children: [{ type: "text", text: "doux" }] },
    { type: "text", text: " mais snake_case_reste" },
  ]);
  // Marqueur jamais refermé (réception en flux) : rendu tel quel, rien ne disparaît.
  assert.deepEqual(parseMarkdownInline("Attends **la fin"), [{ type: "text", text: "Attends **la fin" }]);
  assert.deepEqual(parseMarkdownInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  assert.deepEqual(parseMarkdownInline("\\*pas italique\\*"), [{ type: "text", text: "*pas italique*" }]);
});

test("paragraphes, titres, listes et blocs de code", () => {
  const blocks = parseMarkdown("# Étapes\n\nD'abord :\n1. Ouvre la Marketplace\n2. Clique sur **Emprunter**\n\n- un\n- deux\n\n```\ncode brut <b>ici</b>\n```\nFin");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "list", "list", "code", "paragraph"]);
  const ordered = blocks[2];
  assert.ok(ordered.type === "list" && ordered.ordered && ordered.start === 1 && ordered.items.length === 2);
  const bullets = blocks[3];
  assert.ok(bullets.type === "list" && !bullets.ordered && bullets.items.length === 2);
  const code = blocks[4];
  assert.ok(code.type === "code" && code.text === "code brut <b>ici</b>");
  assert.equal(markdownToPlainText("Ouvre la **Marketplace**\n\n- un\n- deux"), "Ouvre la Marketplace\n\n• un\n• deux");
});

test("aucun HTML n'est interprété, aucune image n'est chargée, seuls http(s) et les chemins internes sont des liens", () => {
  // Balises brutes : du texte, jamais un nœud HTML.
  for (const html of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<a href=\"javascript:alert(1)\">x</a>", "<iframe src=//evil></iframe>"]) {
    const nodes = parseMarkdownInline(html);
    assert.deepEqual(types(nodes).filter((type) => type !== "text"), [], html);
    assert.equal(nodes.map((node) => node.type === "text" ? node.text : "").join(""), html);
  }
  // Image Markdown : texte alternatif seul.
  assert.deepEqual(parseMarkdownInline("Vois ![logo](https://evil.example/track.gif) ici"), [{ type: "text", text: "Vois logo ici" }]);
  // Cibles refusées : le libellé reste du texte, sans lien.
  for (const target of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>", "mailto:x@y", "//evil.example/x", "/\\evil.example", "ftp://x", "vbscript:x", "java\nscript:x", "https://"]) {
    assert.equal(safeMarkdownHref(target), null, target);
    const nodes = parseMarkdownInline(`[clique](${target.replace("\n", "")})`);
    assert.deepEqual(types(nodes), ["text"], target);
    assert.equal(nodes[0].type === "text" ? nodes[0].text : "", "clique");
  }
  // Cibles acceptées.
  assert.deepEqual(safeMarkdownHref("/train"), { href: "/train", external: false });
  assert.deepEqual(safeMarkdownHref("https://sirius-data.tech/docs"), { href: "https://sirius-data.tech/docs", external: true });
  assert.deepEqual(safeMarkdownHref("HTTP://example.com"), { href: "HTTP://example.com", external: true });
  assert.equal(safeMarkdownHref(`https://x.example/${"a".repeat(3_000)}`), null);
  const titled = parseMarkdownInline("[doc](https://sirius-data.tech/d \"titre\")");
  assert.deepEqual(titled, [{ type: "link", href: "https://sirius-data.tech/d", external: true, children: [{ type: "text", text: "doc" }] }]);
});

test("liens externes : cliquables seulement vers les hôtes autorisés, sinon texte avec l'URL visible", () => {
  for (const href of ["https://sirius-data.tech/docs", "https://www.sirius-data.tech", "https://phala.sirius-data.tech/phala", "https://robinhoodchain.blockscout.com/tx/0x1", "https://explorer.testnet.chain.robinhood.com/address/0x2"]) {
    assert.equal(isAllowedExternalHref(href), true, href);
    assert.deepEqual(types(parseMarkdownInline(`[voir](${href})`)), ["link", "text"], href);
  }
  for (const href of ["https://evil.example/x", "https://sirius-data.tech.evil.example/x", "https://sirius-data.tech@evil.example/x", "https://evilsirius-data.tech/", "https://user:pw@sirius-data.tech/"]) {
    assert.equal(isAllowedExternalHref(href), false, href);
  }
  assert.deepEqual(parseMarkdownInline("[ton portefeuille](https://evil.example/claim)"), [{ type: "text", text: "ton portefeuille (https://evil.example/claim)" }]);
  assert.deepEqual(parseMarkdownInline("voir https://evil.example/x."), [{ type: "text", text: "voir https://evil.example/x." }]);
  assert.deepEqual(parseMarkdownInline("[interne](/marketplace)"), [{ type: "link", href: "/marketplace", external: false, children: [{ type: "text", text: "interne" }] }]);
});

test("pas de lien dans un lien : le libellé est rendu sans liens", () => {
  const nodes = parseMarkdownInline("[voir [ici](/train) et https://sirius-data.tech](/marketplace)");
  assert.equal(nodes.length, 1);
  const link = nodes[0];
  assert.ok(link.type === "link" && link.href === "/marketplace");
  assert.deepEqual(types(link.children), ["text"]);
  assert.equal(link.children[0].type === "text" ? link.children[0].text : "", "voir ici et https://sirius-data.tech");
});

test("titres : séquence fermante retirée seulement après une espace", () => {
  const [a] = parseMarkdown("## Étapes ##  ");
  assert.ok(a.type === "heading" && a.level === 2);
  assert.deepEqual(a.children, [{ type: "text", text: "Étapes" }]);
  const [b] = parseMarkdown("# Langage C#");
  assert.ok(b.type === "heading");
  assert.deepEqual(b.children, [{ type: "text", text: "Langage C#" }]);
  assert.deepEqual(parseMarkdown("# ##").map((block) => block.type), ["paragraph"]);
});

test("entrées hostiles : lignes de 20 000 caractères analysées en moins de 50 ms", () => {
  const n = 20_000;
  const adversarial = [
    `# ${" ".repeat(n)}x`,
    `# a${" ".repeat(n)}#${" ".repeat(n)}x`,
    `#${" #".repeat(n / 2)}`,
    "*a ".repeat(n / 3),
    "**a ".repeat(n / 4),
    "_a ".repeat(n / 3),
    "x ` ".repeat(n / 4),
    "[".repeat(n),
    "](".repeat(n / 2),
    "[a](".repeat(n / 4),
    "![".repeat(n / 2),
    `[a](/x${" ".repeat(n)}"`,
    ` h${" http://a".repeat(n / 9)}`,
    `https://sirius-data.tech/${".".repeat(n)}x`,
    `- ${" ".repeat(n)}x`,
    `1.${" ".repeat(n)}`,
    `${"[".repeat(n / 2)}${"]".repeat(n / 2)}`,
    `${"[a](/x) ".repeat(n / 8)}`,
    `${"*_".repeat(n / 2)}`,
  ];
  for (const line of adversarial) {
    for (const source of [line, Array.from({ length: 10 }, () => line).join("\n")]) {
      const started = performance.now();
      parseMarkdown(source);
      markdownToPlainText(source);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms pour ${JSON.stringify(line.slice(0, 20))}`);
    }
  }
  // Une ligne trop longue est coupée, le texte total aussi.
  const long = parseMarkdown("a".repeat(5_000));
  assert.ok(long[0].type === "paragraph" && long[0].children[0].type === "text" && long[0].children[0].text.length === 2_001);
});

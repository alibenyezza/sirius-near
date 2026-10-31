/**
 * Markdown minimal et sûr pour les réponses de Sirio : le texte du modèle est découpé en un
 * arbre (paragraphes, titres, listes, blocs de code, gras, italique, code en ligne, liens) que
 * le panneau rend en éléments React. Rien n'est jamais interprété comme HTML : une balise
 * écrite dans la réponse reste du texte, une image n'est jamais chargée (son texte alternatif
 * seul est gardé), et seuls les chemins internes (`/train`) et les liens `http(s)://` vers une
 * liste fermée d'hôtes (le site, la démo Phala, les explorateurs de la chaîne) sont cliquables ;
 * un autre hôte est rendu en texte avec son URL visible, et `javascript:`, `data:`, `mailto:`
 * ou les URL relatives au protocole (`//…`) redeviennent du texte. Module pur, testable sans
 * navigateur.
 *
 * Le texte vient d'un modèle, donc potentiellement hostile : l'entrée est bornée (longueur
 * totale et longueur de ligne) et l'analyse reste linéaire — aucune expression régulière à
 * retour arrière super-linéaire, crochets et parenthèses appariés en une passe, marqueurs non
 * refermés mémorisés pour ne pas rebalayer la même ligne.
 *
 * L'analyse est tolérante : un `**` jamais refermé, fréquent pendant la réception en flux,
 * est rendu tel quel au lieu de faire disparaître la fin du message.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; external: boolean; children: MarkdownInline[] }
  | { type: "br" };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownInline[][] }
  | { type: "code"; text: string };

/** Longueur maximale d'une cible de lien gardée cliquable. */
const MAX_HREF_CHARS = 2_048;
/** Longueur maximale analysée d'une réponse : au-delà, le texte est coupé avant l'analyse. */
export const MAX_MARKDOWN_CHARS = 20_000;
/** Longueur maximale d'une ligne : une ligne plus longue est coupée avant l'analyse. */
export const MAX_MARKDOWN_LINE_CHARS = 2_000;
const CONTROL_OR_SPACE = /[\u0000- \u007F]/;

/**
 * Hôtes externes dont les liens restent cliquables : le site, la démo Phala et les
 * explorateurs de la chaîne utilisés par l'application. Tout autre hôte est affiché en texte.
 */
export const ALLOWED_LINK_HOSTS: ReadonlySet<string> = new Set([
  "sirius-data.tech",
  "www.sirius-data.tech",
  "phala.sirius-data.tech",
  "robinhoodchain.blockscout.com",
  "explorer.testnet.chain.robinhood.com",
]);

/**
 * Cible de lien acceptée : `https://…`, `http://…` ou un chemin interne commençant par `/`
 * (jamais `//`, qui désignerait un autre hôte). Tout le reste donne `null` : le lien est
 * alors rendu comme du texte.
 */
export function safeMarkdownHref(raw: string): { href: string; external: boolean } | null {
  const href = raw.trim();
  if (href.length === 0 || href.length > MAX_HREF_CHARS || CONTROL_OR_SPACE.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith("//") || href.startsWith("/\\") ? null : { href, external: false };
  if (/^https?:\/\/[^/]/i.test(href)) return { href, external: true };
  return null;
}

/** Vrai si un lien externe sûr pointe vers un hôte de la liste fermée (sans identifiants dans l'URL). */
export function isAllowedExternalHref(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  return ALLOWED_LINK_HOSTS.has(url.hostname.toLowerCase());
}

/** Texte brut d'une suite de nœuds en ligne (texte alternatif, lien non sûr). */
function plainText(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
      case "code":
        return node.text;
      case "br":
        return "\n";
      default:
        return plainText(node.children);
    }
  }).join("");
}

function pushText(out: MarkdownInline[], text: string): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/**
 * Appariement en une passe des `open`/`close` de `source` : pour chaque position ouvrante, la
 * position fermante correspondante (imbrication comprise), ou −1. Les caractères échappés par
 * `\` sont ignorés ; avec `stopAtNewline`, une fin de ligne abandonne les ouvrants en attente.
 * Remplace un balayage par ouvrant, quadratique sur `[[[[…` ou `((((…`.
 */
function matchPairs(source: string, open: string, close: string, stopAtNewline: boolean): Int32Array {
  const match = new Int32Array(source.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === open) stack.push(i);
    else if (char === close) {
      const opened = stack.pop();
      if (opened !== undefined) match[opened] = i;
    } else if (stopAtNewline && char === "\n") stack.length = 0;
  }
  return match;
}

/** Échecs mémorisés de `closingMarker` : depuis `from`, aucun fermant avant `boundary`. */
type MarkerMisses = Map<string, { from: number; boundary: number }>;

/**
 * Fin du marqueur `marker` (`**`, `*`, `_`, `` ` ``) ouvert juste avant `from`, ou −1 s'il n'est
 * pas refermé. Un échec est mémorisé : tout ouvrant suivant sur la même ligne (le même texte pour
 * `` ` ``) échouerait aussi, il n'est donc pas rebalayé — sans quoi `*a *a *a …` coûterait n².
 */
function closingMarker(source: string, from: number, marker: string, misses: MarkerMisses): number {
  const miss = misses.get(marker);
  if (miss && from >= miss.from && from <= miss.boundary) return -1;
  let i = from;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source.startsWith(marker, i)) {
      // Un marqueur fermant ne suit pas une espace (« a * b * c » n'est pas de l'italique).
      if (i === from || /\s/.test(source[i - 1])) {
        i += 1;
        continue;
      }
      return i;
    }
    if (marker !== "`" && source[i] === "\n") break;
    i += 1;
  }
  misses.set(marker, { from, boundary: Math.min(i, source.length) });
  return -1;
}

/** Retire un titre de lien (`(url "titre")`) sans expression régulière à retour arrière. */
function stripLinkTitle(target: string): string {
  const trimmed = target.trimEnd();
  if (!trimmed.endsWith("\"")) return target;
  const quote = trimmed.lastIndexOf("\"", trimmed.length - 2);
  if (quote <= 0 || !/\s/.test(trimmed[quote - 1])) return target;
  return trimmed.slice(0, quote).trimEnd();
}

/** Retire la ponctuation finale d'une URL nue (`voir https://x.tech.` → sans le point). */
function stripTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?".includes(url[end - 1])) end -= 1;
  return url.slice(0, end);
}

const BARE_URL = /https?:\/\/[^\s<>()[\]]+/iy;

/** Lien sûr : cliquable si interne ou vers un hôte autorisé, sinon texte avec l'URL visible. */
function pushLink(out: MarkdownInline[], safe: { href: string; external: boolean }, children: MarkdownInline[]): void {
  if (!safe.external || isAllowedExternalHref(safe.href)) {
    out.push({ type: "link", href: safe.href, external: safe.external, children });
    return;
  }
  const label = plainText(children);
  pushText(out, label === safe.href || label.length === 0 ? safe.href : `${label} (${safe.href})`);
}

interface InlineOptions {
  /** Faux dans le libellé d'un lien : un lien n'en contient jamais un autre. */
  links: boolean;
}

function parseInline(source: string, options: InlineOptions): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  const misses: MarkerMisses = new Map();
  let brackets: Int32Array | null = null;
  let parens: Int32Array | null = null;
  const closingBracket = (open: number) => (brackets ??= matchPairs(source, "[", "]", false))[open];
  const closingParen = (open: number) => (parens ??= matchPairs(source, "(", ")", true))[open];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < source.length) {
    const char = source[i];
    if (char === "\\" && i + 1 < source.length && /[\\`*_[\]()!#>-]/.test(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      out.push({ type: "br" });
      i += 1;
      continue;
    }
    if (char === "`") {
      const end = closingMarker(source, i + 1, "`", misses);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (char === "!" && source[i + 1] === "[") {
      // Image : jamais chargée, son texte alternatif seul est gardé.
      const close = closingBracket(i + 1);
      if (close !== -1 && source[close + 1] === "(") {
        const end = closingParen(close + 1);
        if (end !== -1) {
          text += source.slice(i + 2, close);
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "[") {
      const close = closingBracket(i);
      if (close !== -1 && source[close + 1] === "(") {
        const end = closingParen(close + 1);
        if (end !== -1) {
          flush();
          // Le libellé est analysé sans liens : jamais de lien dans un lien. Un lien écrit
          // dans un libellé ne garde que son propre libellé.
          const children = parseInline(source.slice(i + 1, close), { links: false });
          const safe = options.links ? safeMarkdownHref(stripLinkTitle(source.slice(close + 2, end))) : null;
          if (safe) pushLink(out, safe, children);
          else if (options.links) pushText(out, plainText(children));
          else {
            for (const child of children) {
              if (child.type === "text") pushText(out, child.text);
              else out.push(child);
            }
          }
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "*" || char === "_") {
      const double = source[i + 1] === char;
      const marker = double ? char + char : char;
      // `_` à l'intérieur d'un mot (snake_case) n'ouvre rien.
      const inWord = char === "_" && i > 0 && /\w/.test(source[i - 1]);
      const next = source[i + marker.length];
      if (!inWord && next !== undefined && !/\s/.test(next)) {
        const end = closingMarker(source, i + marker.length, marker, misses);
        if (end !== -1) {
          flush();
          const children = parseInline(source.slice(i + marker.length, end), options);
          out.push(double ? { type: "strong", children } : { type: "em", children });
          i = end + marker.length;
          continue;
        }
      }
    }
    if (options.links && char === "h" && (i === 0 || /[\s(]/.test(source[i - 1]))) {
      BARE_URL.lastIndex = i;
      const match = BARE_URL.exec(source);
      if (match) {
        const url = stripTrailingPunctuation(match[0]);
        const safe = safeMarkdownHref(url);
        if (safe) {
          flush();
          pushLink(out, safe, [{ type: "text", text: url }]);
          i += url.length;
          continue;
        }
      }
    }
    text += char;
    i += 1;
  }
  flush();
  return out;
}

/** Analyse du texte en ligne d'un paragraphe, d'un titre ou d'un élément de liste. */
export function parseMarkdownInline(source: string): MarkdownInline[] {
  return parseInline(source.slice(0, MAX_MARKDOWN_CHARS), { links: true });
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/;
const FENCE = /^\s{0,3}```/;

/** Texte d'un titre sans sa séquence fermante facultative (`## Titre ##`), ou `null` s'il est vide. */
function headingText(raw: string): string | null {
  let text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end < text.length && (end === 0 || /\s/.test(text[end - 1]))) text = text.slice(0, end).trimEnd();
  return text.length > 0 ? text : null;
}

/** Analyse d'une réponse complète (ou en cours de réception) en blocs. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source
    .slice(0, MAX_MARKDOWN_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.length > MAX_MARKDOWN_LINE_CHARS ? `${line.slice(0, MAX_MARKDOWN_LINE_CHARS)}…` : line);
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      i += 1;
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    const title = heading ? headingText(heading[2]) : null;
    if (heading && title !== null) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, children: parseMarkdownInline(title) });
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      const start = ordered ? Number(item[2]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (current && (current[2] !== undefined) === ordered) {
          items.push(current[3]);
          i += 1;
          continue;
        }
        // Ligne de continuation indentée : rattachée à l'élément précédent.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, start, items: items.map((text) => parseMarkdownInline(text)) });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/** Texte brut d'une réponse (presse-papiers, aperçus) : le Markdown sans ses marqueurs. */
export function markdownToPlainText(source: string): string {
  return parseMarkdown(source).map((block) => {
    switch (block.type) {
      case "code":
        return block.text;
      case "list":
        return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${plainText(item)}`).join("\n");
      default:
        return plainText(block.children);
    }
  }).join("\n\n");
}

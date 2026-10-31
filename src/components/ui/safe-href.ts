/**
 * Lien interne sûr : un chemin du site (« /datasets/abc »), jamais une URL absolue ni un
 * lien relatif au protocole. Les composants partagés ne suivent que des chemins internes ;
 * un `javascript:`, un `https://…`, un `//hôte` ou un `/\hôte` venu d'une donnée est refusé.
 */
export function safeInternalHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (value[0] !== "/" || value[1] === "/" || value[1] === "\\") return null;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // Espaces, contrôles C0 et DEL, antislash : les navigateurs les normalisent ou les retirent.
    if (code <= 0x20 || code === 0x7f || value[index] === "\\") return null;
  }
  return value;
}

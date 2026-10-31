import {
  PREVIEW_COOKIE,
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  previewCookieValue,
  previewKeyMatches,
  readPreviewGateConfig,
  type PreviewGateEnvironment,
} from "./gate";

/**
 * `GET /preview?key=…`, en API Web pure pour être testable sans Next.
 *
 * Bonne clé : cookie `sirius_preview` (HMAC dérivé de la clé, jamais la clé), puis
 * redirection vers `/`. Clé fausse, absente, porte inactive ou clé non configurée : le même
 * 404 nu, sans distinguer les cas. Rien n'est journalisé ici — la clé transite dans l'URL,
 * et un `console.log` de la requête suffirait à la copier dans les logs de l'hébergeur.
 */
export async function handlePreviewRequest(
  request: Request,
  env: PreviewGateEnvironment = process.env,
  secureCookie: boolean = process.env.NODE_ENV === "production",
): Promise<Response> {
  const { active, key } = readPreviewGateConfig(env);
  const candidate = new URL(request.url).searchParams.get("key");
  if (!active || !(await previewKeyMatches(key, candidate))) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  }

  const cookie = [
    `${PREVIEW_COOKIE}=${await previewCookieValue(key as string)}`,
    `Max-Age=${PREVIEW_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secureCookie ? ["Secure"] : []),
  ].join("; ");

  // `Location` relatif : la cible est la racine de l'origine qui a reçu la requête, quel que
  // soit l'en-tête Host présenté à l'application derrière son ingress.
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookie, "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

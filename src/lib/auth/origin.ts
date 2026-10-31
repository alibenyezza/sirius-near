import "server-only";
import { AppError } from "@/lib/errors";

function normalizedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SIRIUS_APP_ORIGIN invalide");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("SIRIUS_APP_ORIGIN doit être une origine HTTP(S) sans chemin");
  }
  return url.origin;
}

function expectedOrigin(req: Request): string {
  const configured = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("SIRIUS_APP_ORIGIN obligatoire en production");
  }
  return normalizedOrigin(configured || new URL(req.url).origin);
}

export function assertMutationOrigin(req: Request): string {
  const expected = expectedOrigin(req);
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return expected;
  const requestOrigin = req.headers.get("origin");
  if (!requestOrigin) {
    throw new AppError("Origine de requête non autorisée", 403);
  }
  const origin = normalizedOrigin(requestOrigin);
  if (origin !== expected) {
    const aliases = (process.env.SIRIUS_APP_ORIGIN_ALIASES ?? "")
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean)
      .map(normalizedOrigin);
    if (origin !== new URL(req.url).origin || !aliases.includes(origin)) {
      throw new AppError("Origine de requête non autorisée", 403);
    }
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new AppError("Contexte de requête non autorisé", 403);
  }
  // Les alias partagent le domaine signé que le runner reconnaît déjà.
  return expected;
}

export function authenticationOrigin(req: Request): string {
  return assertMutationOrigin(req);
}

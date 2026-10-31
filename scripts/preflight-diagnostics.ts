import { AppError } from "../src/lib/app-error";

const DIAGNOSTICS: Record<string, string> = {
  P1000: "authentification PostgreSQL refusée",
  P1001: "serveur PostgreSQL inaccessible",
  P1002: "délai de connexion PostgreSQL dépassé",
  P1011: "connexion TLS PostgreSQL refusée",
  P1013: "URL PostgreSQL invalide",
  P1017: "connexion PostgreSQL fermée",
  P2010: "échec de requête PostgreSQL",
  P2024: "attente du pool PostgreSQL expirée",
  P2039: "erreur du pilote PostgreSQL",
  "28P01": "authentification PostgreSQL refusée",
  "28000": "accès PostgreSQL refusé",
  "3D000": "base PostgreSQL inexistante",
  "42P01": "table PostgreSQL absente",
  "42703": "colonne PostgreSQL absente",
  "42501": "permissions PostgreSQL insuffisantes",
  "53300": "trop de connexions PostgreSQL",
  ENOTFOUND: "résolution DNS impossible",
  EAI_AGAIN: "résolution DNS temporairement indisponible",
  ECONNREFUSED: "connexion réseau refusée",
  ECONNRESET: "connexion réseau interrompue",
  ETIMEDOUT: "délai réseau dépassé",
  ENETUNREACH: "réseau inaccessible",
  ERR_TLS_CERT_ALTNAME_INVALID: "nom du certificat TLS incompatible",
  CERT_HAS_EXPIRED: "certificat TLS expiré",
  DEPTH_ZERO_SELF_SIGNED_CERT: "certificat TLS autosigné non approuvé",
  SELF_SIGNED_CERT_IN_CHAIN: "chaîne TLS non approuvée",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificat TLS non vérifiable",
  DatabaseNotReachable: "serveur PostgreSQL inaccessible",
  AuthenticationFailed: "authentification PostgreSQL refusée",
  DatabaseAccessDenied: "accès PostgreSQL refusé",
  DatabaseDoesNotExist: "base PostgreSQL inexistante",
  TableDoesNotExist: "table PostgreSQL absente",
  ColumnNotFound: "colonne PostgreSQL absente",
  TooManyConnections: "trop de connexions PostgreSQL",
  TlsConnectionError: "connexion TLS PostgreSQL refusée",
  ConnectionClosed: "connexion PostgreSQL fermée",
  SocketTimeout: "délai réseau dépassé",
  HttpRequestError: "requête HTTP RPC échouée",
  TimeoutError: "délai RPC dépassé",
  RpcRequestError: "requête refusée par le RPC",
  ContractFunctionExecutionError: "lecture du contrat échouée",
  ContractFunctionZeroDataError: "aucune donnée renvoyée par le contrat",
  UnsupportedNativeDataType: "type PostgreSQL non pris en charge par l'adaptateur",
  InvalidInputValue: "valeur refusée par l'adaptateur PostgreSQL",
  InconsistentColumnData: "résultat PostgreSQL incompatible avec l'adaptateur",
};

// Classes SQLSTATE PostgreSQL : un nouveau code de ces classes reste visible.
const SQLSTATE_CLASSES = new Set("00 01 02 03 08 09 0A 0B 0F 0L 0P 0Z 10 20 21 22 23 24 25 26 27 28 2B 2D 2F 34 38 39 3B 3D 3F 40 42 44 53 54 55 57 58 72 F0 HV P0 XX".split(" "));

function isSqlState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{5}$/.test(value) && SQLSTATE_CLASSES.has(value.slice(0, 2));
}

function postgresUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function postgresConnectionSummary(value: string | undefined): string {
  const url = postgresUrl(value);
  if (!url) throw new AppError("DATABASE_URL doit être une URL PostgreSQL valide", 400);
  const host = url.hostname;
  const provider = host.endsWith(".neon.tech") ? "Neon"
    : /\.supabase\.(co|com)$/.test(host) ? "Supabase"
      : host.endsWith(".rds.amazonaws.com") ? "AWS RDS"
        : host.endsWith(".postgres.database.azure.com") ? "Azure PostgreSQL"
          : host.endsWith(".aivencloud.com") ? "Aiven" : "non identifié";
  const pooler = host.includes("pooler") || url.searchParams.get("pgbouncer") === "true";
  const sslmode = url.searchParams.get("sslmode");
  const tls = sslmode && ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)
    ? sslmode : "non précisé";
  return `PostgreSQL : hébergeur ${provider} ; pooler ${pooler ? "indiqué" : "non déterminé"} ; port ${url.port || "5432"} ; sslmode ${tls}`;
}

function postgresMessage(message: unknown, connectionString: string | undefined): string | null {
  const url = postgresUrl(connectionString);
  if (typeof message !== "string" || !url || !connectionString) return null;
  const privateValues = new Set([connectionString, url.username, url.password, url.hostname, url.pathname.slice(1)]);
  for (const value of [...privateValues, ...url.searchParams.values()]) {
    if (!value) continue;
    privateValues.add(value);
    try { privateValues.add(decodeURIComponent(value)); } catch {}
  }
  for (const value of [...privateValues]) {
    privateValues.add(JSON.stringify(value).slice(1, -1));
    privateValues.add(value.replaceAll("'", "''"));
  }
  let safe = message;
  for (const value of [...privateValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(value).join("[masqué]");
  }
  return safe.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, "[URL masquée]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 500);
}

export function preflightErrorMessage(error: unknown, connectionString = process.env.DATABASE_URL): string {
  if (error instanceof AppError) return error.message;
  const details = new Set<string>();
  const visited = new Set<object>();
  function inspect(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "originalCode", "kind", "name"]) {
      const code = record[key];
      if (typeof code === "string" && Object.hasOwn(DIAGNOSTICS, code)) {
        details.add(`${code} : ${DIAGNOSTICS[code]}`);
      } else if ((key === "code" || key === "originalCode") && isSqlState(code)) {
        details.add(`${code} : code PostgreSQL`);
      }
    }
    // Seul le motif natif PostgreSQL est utile ici ; jamais l'erreur Prisma/RPC complète.
    if (isSqlState(record.originalCode)) {
      const message = postgresMessage(record.originalMessage, connectionString);
      if (message) details.add(`Motif PostgreSQL : ${message}`);
    }
    for (const key of ["cause", "meta", "driverAdapterError"]) inspect(record[key], depth + 1);
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors.slice(0, 20)) inspect(nested, depth + 1);
    }
  }
  inspect(error);
  return `Préflight EVM impossible à la dernière étape annoncée${details.size ? ` — ${[...details].join(" ; ")}` : " — erreur technique non classée"}`;
}

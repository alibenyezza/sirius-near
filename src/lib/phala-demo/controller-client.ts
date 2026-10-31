import "server-only";
import { AppError } from "@/lib/app-error";

export interface ControllerStatus {
  revision: number;
  sessionRevision?: number;
  phase: "closed" | "opening" | "open" | "closing" | "error";
  available: boolean;
  changedAt: number;
  activeOperations: number;
  usedOperations: number;
  funding: "credits" | "sirius" | "mixed" | null;
  error?: string;
}

export async function requestDemoController(command?: { command: "open" | "close" | "emergency"; actor: string; revision: number }): Promise<ControllerStatus> {
  if (process.env.SIRIUS_PHALA_DEMO !== "true" || process.env.EVM_NETWORK !== "testnet") {
    throw new AppError("Espace Phala non configuré", 503);
  }
  let url: URL;
  try { url = new URL(process.env.PHALA_DEMO_CONTROLLER_URL ?? ""); }
  catch { throw new AppError("Contrôleur Phala non configuré", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new AppError("Origine HTTPS du contrôleur invalide", 503);
  }
  const secret = process.env.PHALA_DEMO_CONTROLLER_SECRET;
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new AppError("Accès contrôleur non configuré", 503);
  try {
    const response = await fetch(new URL("/session", url), {
      method: command ? "POST" : "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const body = await response.json();
    if (!response.ok) throw new AppError(response.status === 409 ? "La commande est déjà en cours ou l’état a changé" : "Contrôleur Phala indisponible", response.status === 409 ? 409 : 503);
    if (!body || !["closed", "opening", "open", "closing", "error"].includes(body.phase)
      || !Number.isSafeInteger(body.revision) || typeof body.available !== "boolean") throw new Error();
    return body as ControllerStatus;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Contrôleur Phala indisponible", 503);
  }
}

import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { NextResponse } from "next/server";
import { createSiriusMcpHandler, rejectMcpRequest } from "@/lib/agent/mcp";
import { agentToolSource } from "@/lib/agent/tools-server";
import { errorResponse } from "@/lib/errors";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un appel d'outil lit la base, le RPC ou la collatérale Intel : borné, jamais un flux ouvert.
export const maxDuration = 30;

/**
 * Serveur MCP public de Sirius, en lecture seule (voir `src/lib/agent/`).
 *
 * Sans session ni cookie : mêmes données que les pages publiques, identiques pour tous les
 * appelants. Interrupteur `SIRIUS_MCP_ENABLED=true` : absent, la route répond 404, dès le
 * redéploiement.
 */

// Même débit que le catalogue public : un appel d'outil coûte au plus une lecture du catalogue.
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 60, maxGlobal: 1_200 });

let handler: { origin: string; mcp: McpHttpHandler } | null = null;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}

/** Origine publique du site (liens absolus des réponses), comme les routes de session. */
function appOrigin(req: Request): string {
  const configured = process.env.SIRIUS_APP_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("SIRIUS_APP_ORIGIN obligatoire en production");
  }
  return new URL(configured || req.url).origin;
}

function mcpHandler(origin: string): McpHttpHandler {
  if (!handler || handler.origin !== origin) {
    handler = { origin, mcp: createSiriusMcpHandler(agentToolSource, origin) };
  }
  return handler.mcp;
}

async function serve(req: Request): Promise<Response> {
  if (process.env.SIRIUS_MCP_ENABLED !== "true") {
    return noStore(NextResponse.json({ error: "Serveur MCP indisponible" }, { status: 404 }));
  }
  try {
    enforceRateLimit(limiter, requestClientKey(req));
    const origin = appOrigin(req);
    const rejected = rejectMcpRequest(req, origin);
    if (rejected) return noStore(rejected);
    return noStore(await mcpHandler(origin).fetch(req));
  } catch (error) {
    return noStore(errorResponse(error));
  }
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;

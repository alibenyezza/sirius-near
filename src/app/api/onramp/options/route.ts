import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { onrampOptions } from "@/lib/onramp/onramp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Moyens d'ajout de fonds proposés par cette instance. Public : la réponse ne dépend que
 * de la configuration serveur (réseau, présence et type des clés MoonPay), jamais du
 * compte, et ne révèle aucune clé.
 */
export async function GET() {
  try {
    const { network } = resolveServerNetwork();
    return NextResponse.json(onrampOptions(network), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

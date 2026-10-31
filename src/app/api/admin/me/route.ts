import { NextResponse } from "next/server";
import { adminAllowed } from "@/lib/auth/admin";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Dit à l'interface si le wallet connecté fait partie de l'équipe (`SIRIUS_ADMIN_ADDRESSES`),
 * pour afficher ou masquer les écrans réservés. Indicatif seulement : chaque route réservée
 * refait son propre contrôle côté serveur.
 */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    return NextResponse.json({ admin: adminAllowed(session.address) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

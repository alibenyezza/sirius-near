import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * État de la session en cours, tel que le serveur le voit.
 *
 * Le store wallet du navigateur ne survit pas à un rechargement, alors que le cookie
 * de session, lui, dure sept jours. Sans ce point d'interrogation, le client
 * n'a aucun moyen de savoir qu'il est encore authentifié : il redemande une signature
 * à chaque navigation, ou pire, considère la divergence comme un changement de compte
 * et détruit une session parfaitement valide.
 *
 * On ne révèle que l'adresse déjà contenue dans le cookie présenté, donc rien que
 * l'appelant ne possède : le cookie est `httpOnly` et `sameSite=lax`, qu'un `fetch`
 * d'une autre origine n'accompagne pas.
 */
export async function GET(req: Request) {
  const session = readSession(req);
  const response = NextResponse.json(
    session ? { authenticated: true, address: session.address } : { authenticated: false, address: null },
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

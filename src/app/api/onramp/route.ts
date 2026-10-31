import { NextResponse } from "next/server";
import { buildSignedBuyUrl } from "@/lib/moonpay/url";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { onrampUrl, parseOnrampRequest } from "@/lib/onramp/onramp";

export const runtime = "nodejs";

/**
 * Lien historique du GET sur mainnet : le pont Across. Conservé tel quel pour les écrans
 * qui l'appellent encore ; le nouvel écran passe par le POST ci-dessous.
 *
 * Correction du 4 octobre 2026 : MoonPay vend bien `usdg_robinhood` (minimum 5 USD) et
 * `eth_robinhood` livrés sur Robinhood Chain (4663). L'ancienne justification de ce
 * détour (« MoonPay ne livre l'USDC que sur Ethereum ») était fausse. Le GET garde
 * pourtant ce comportement : il demande `currencyCode=usdc` par défaut, qui, lui,
 * arriverait bien sur la mauvaise chaîne.
 */
const BRIDGE_URL = "https://app.across.to/bridge";

/** Compatibilité : URL MoonPay signée liée au wallet authentifié, ou le pont sur mainnet. */
export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    if (process.env.EVM_NETWORK?.trim() === "mainnet") return NextResponse.json({ url: BRIDGE_URL, kind: "bridge" });
    const amountParam = new URL(req.url).searchParams.get("amount");
    const amount = amountParam ? Number(amountParam) : undefined;
    const baseCurrencyAmount = amount && Number.isFinite(amount) && amount > 0 ? amount : undefined;

    const url = buildSignedBuyUrl({ walletAddress: session.address, baseCurrencyAmount });
    return NextResponse.json({ url, kind: "buy" });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Lien d'ajout de fonds (carte MoonPay ou pont Relay) vers l'adresse de la session.
 * Corps : `{ method: "card"|"bridge", asset: "USDG"|"ETH", amount: number }`. Toute
 * adresse fournie dans le corps est ignorée.
 */
export async function POST(req: Request) {
  try {
    const session = requireAuth(req);
    const request = parseOnrampRequest(await readJson(req, 1024));
    const { network } = resolveServerNetwork();
    const url = onrampUrl(network, session.address, request);
    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

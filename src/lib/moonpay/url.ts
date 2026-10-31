import "server-only";
import { createHmac } from "node:crypto";
import { AppError } from "@/lib/errors";

const SANDBOX_BASE = "https://buy-sandbox.moonpay.com";
const LIVE_BASE = "https://buy.moonpay.com";

interface BuyUrlOptions {
  walletAddress: string;
  currencyCode?: string;
  baseCurrencyAmount?: number; // montant fiat pré-rempli (optionnel)
}

/**
 * Construit l'URL du widget « Buy » MoonPay signée en HMAC-SHA256 (base64) avec la
 * clé secrète — exigée par MoonPay pour autoriser le widget. La secret key reste
 * serveur-only ; l'environnement (sandbox/live) est déduit du préfixe de la clé.
 */
export function buildSignedBuyUrl({ walletAddress, currencyCode = "usdc", baseCurrencyAmount }: BuyUrlOptions): string {
  const apiKey = process.env.NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY;
  const secret = process.env.MOONPAY_SECRET_KEY;
  if (!apiKey || !secret) throw new AppError("On-ramp non configuré", 503);

  const url = new URL(apiKey.startsWith("pk_test_") ? SANDBOX_BASE : LIVE_BASE);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("currencyCode", currencyCode);
  url.searchParams.set("walletAddress", walletAddress);
  if (baseCurrencyAmount) url.searchParams.set("baseCurrencyAmount", String(baseCurrencyAmount));

  // Signe la query (avec le « ? ») AVANT d'ajouter la signature elle-même.
  const signature = createHmac("sha256", secret).update(url.search).digest("base64");
  url.searchParams.set("signature", signature);
  return url.toString();
}

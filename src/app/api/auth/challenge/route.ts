import { NextResponse } from "next/server";
import { createPublicKey } from "node:crypto";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { createChallenge } from "@/lib/auth/challenge";
import { authenticationOrigin } from "@/lib/auth/origin";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { enforceRateLimit, FixedWindowRateLimiter, requestClientKey } from "@/lib/http/rate-limit";
import { resolveServerNetwork } from "@/lib/evm/networks";

export const runtime = "nodejs";

const SESSION_KEY_RE = /^[A-Za-z0-9_-]{80,200}$/;
const challengeLimiter = new FixedWindowRateLimiter({
  windowMs: 5 * 60_000,
  maxPerKey: 30,
  maxGlobal: 500,
});

function isValidSessionPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !SESSION_KEY_RE.test(value)) return false;
  try {
    const der = Buffer.from(value, "base64url");
    if (der.toString("base64url") !== value) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    const origin = authenticationOrigin(req);
    const { address, runnerSessionPublicKey } = await readJson<{
      address?: unknown;
      runnerSessionPublicKey?: unknown;
    }>(req);
    const normalizedAddress = tryNormalizeAddress(address);
    if (!normalizedAddress) {
      return NextResponse.json({ error: "Adresse invalide" }, { status: 400 });
    }
    if (!isValidSessionPublicKey(runnerSessionPublicKey)) {
      return NextResponse.json({ error: "Clé de session runner invalide" }, { status: 400 });
    }
    enforceRateLimit(challengeLimiter, requestClientKey(req, normalizedAddress));
    const { network } = resolveServerNetwork();
    return NextResponse.json(
      await createChallenge(normalizedAddress, origin, runnerSessionPublicKey, network),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

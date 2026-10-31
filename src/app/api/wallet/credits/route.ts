import { NextResponse } from "next/server";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { requireAuth } from "@/lib/auth/require-auth";
import { AppError, errorResponse } from "@/lib/errors";
import { normalizeAddress } from "@/lib/evm/address";
import { getPublicClient } from "@/lib/evm/client";
import { trustedEscrowBindings } from "@/lib/evm/history";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { enforceRateLimit, FixedWindowRateLimiter } from "@/lib/http/rate-limit";

export const runtime = "nodejs";
const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 20, maxGlobal: 400 });

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    enforceRateLimit(limiter, session.address);
    const subject = normalizeAddress(session.address);
    const client = getPublicClient();
    const bindings = trustedEscrowBindings();
    const credits = await Promise.all(bindings.map(async ({ chainId, escrow }, index) => {
      const address = normalizeAddress(escrow);
      const base = { chainId, escrow, historical: index > 0 };
      try {
        const [version, token, atomic] = await Promise.all([
          client.readContract({ address, abi: siriusescrowAbi, functionName: "VERSION" }),
          client.readContract({ address, abi: siriusescrowAbi, functionName: "usdc" }),
          client.readContract({ address, abi: siriusescrowAbi, functionName: "creditOf", args: [subject] }),
        ]);
        if (!["sirius-escrow-usdc-v4", "sirius-escrow-usdc-v5", "sirius-escrow-usdc-v6", "sirius-escrow-usdc-v7"].includes(version)) {
          throw new AppError("Version d’escrow non prise en charge", 409);
        }
        const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
        return {
          ...base, available: true, atomic: atomic.toString(), amount: formatUnits(atomic, decimals),
          transaction: { to: escrow, data: encodeFunctionData({ abi: siriusescrowAbi, functionName: "withdrawFor", args: [subject] }), value: "0x0" },
        };
      } catch {
        return { ...base, available: false };
      }
    }));
    return NextResponse.json({ subject, credits }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

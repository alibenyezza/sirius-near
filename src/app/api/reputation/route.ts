import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { errorResponse } from "@/lib/errors";
import { reputationForAddress } from "@/lib/sirius/reputation";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = requireAuth(req);
    const [provider, borrower] = await Promise.all([
      reputationForAddress(session.address, "provider"),
      reputationForAddress(session.address, "borrower"),
    ]);
    return NextResponse.json({ provider, borrower });
  } catch (error) {
    return errorResponse(error);
  }
}

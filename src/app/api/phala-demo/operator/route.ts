import { NextResponse } from "next/server";
import { requireDemoOperator } from "@/lib/phala-demo/operator-access";
import { requestDemoController } from "@/lib/phala-demo/controller-client";
import { readJson } from "@/lib/http/body";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    await requireDemoOperator(req);
    return NextResponse.json(await requestDemoController(), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    const actor = await requireDemoOperator(req);
    const body = await readJson<{ command?: unknown; revision?: unknown }>(req);
    if (!["open", "close", "emergency"].includes(body.command as string) || !Number.isSafeInteger(body.revision)) {
      return NextResponse.json({ error: "Commande invalide" }, { status: 400 });
    }
    const status = await requestDemoController({ command: body.command as "open" | "close" | "emergency",
      revision: body.revision as number, actor });
    return NextResponse.json(status, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

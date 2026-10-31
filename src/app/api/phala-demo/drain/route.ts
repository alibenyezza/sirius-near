import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { controllerAuthorized } from "@/lib/phala-demo/operator";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (process.env.SIRIUS_PHALA_DEMO !== "true" || !controllerAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Accès refusé" }, { status: 401 });
  }
  const pending = await prisma.trainingJob.count({ where: { status: "RUNNING" } });
  return NextResponse.json({ pending }, { headers: { "cache-control": "no-store" } });
}

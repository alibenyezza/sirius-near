import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  deleteDataset,
  prepareDatasetDestruction,
  setDatasetVisibility,
} from "@/lib/sirius/provider";
import { requireAuth, assertOwner } from "@/lib/auth/require-auth";
import { readSession } from "@/lib/auth/session";
import { errorResponse } from "@/lib/errors";
import { readJson } from "@/lib/http/body";
import { datasetResponse } from "@/lib/sirius/dataset-response";
import { requireMutationGrant } from "@/lib/auth/mutation-grant";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { assertVisibilityChange, loadOwnedDataset } from "@/lib/datasets/manage";

export const runtime = "nodejs";

/**
 * Détail d'un dataset. Public/Semi-privé accessibles à tous (le Semi-privé = par lien
 * direct, hors catalogue) ; Privé/Draft/Suspendu réservés au provider ; Supprimé → 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dataset = await prisma.dataset.findUnique({ where: { id } });
  if (!dataset || dataset.status === "DELETED") {
    return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
  }

  const publiclyVisible = dataset.status === "LISTED" || dataset.status === "UNLISTED";
  if (!publiclyVisible) {
    const session = readSession(req);
    // 404 (pas 403) pour ne pas révéler l'existence d'un dataset privé à un tiers.
    if (session?.address !== dataset.provider) {
      return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    }
  }
  return NextResponse.json(datasetResponse(dataset));
}

/** Change la visibilité (Public / Semi-privé / Privé) — provider uniquement. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { visibility, authorization } = await readJson<{
      visibility?: unknown;
      authorization?: RunnerGrant;
    }>(req);
    if (typeof visibility !== "string") return NextResponse.json({ error: "Visibilité invalide" }, { status: 400 });
    if (!authorization) return NextResponse.json({ error: "Confirmation wallet requise" }, { status: 400 });
    // Propriété vérifiée dans la requête : absent et autre wallet répondent le même 404.
    const owned = await loadOwnedDataset(prisma, id, session.address);
    // Même règles que la remise en ligne de la fiche (`/settings/listing`) : pas de passage à
    // « Public » pour une annonce expirée ni en démo Phala, et pas de détour par
    // « Semi-privé » depuis un dataset privé en démo.
    // `setDatasetVisibility` ne rejoue pas ces conditions en base (fenêtre de course minime,
    // documentée dans audit.md N1).
    assertVisibilityChange(visibility, owned, Date.now(), { demoMode: process.env.SIRIUS_PHALA_DEMO === "true" });
    await requireMutationGrant(session, authorization, {
      operation: "set-dataset-visibility",
      datasetId: id,
      intentParts: [id, visibility],
    });
    const dataset = await setDatasetVisibility(id, session.address, visibility as "LISTED" | "UNLISTED" | "PRIVATE");
    return NextResponse.json(datasetResponse(dataset));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Prépare le tombstone EVM à signer par le provider avant suppression de la clé active. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    const transaction = await prepareDatasetDestruction(id, session.address);
    return NextResponse.json({ transaction });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Vérifie le tombstone EVM, retire la clé active et dépine le dataset. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = requireAuth(req);
    const { id } = await params;
    const { txHash, authorization } = await readJson<{
      txHash?: unknown;
      authorization?: RunnerGrant;
    }>(req);
    if (txHash !== undefined && typeof txHash !== "string") {
      return NextResponse.json({ error: "Hash de tombstone EVM invalide" }, { status: 400 });
    }
    if (!authorization) return NextResponse.json({ error: "Confirmation wallet requise" }, { status: 400 });
    const owned = await prisma.dataset.findUnique({ where: { id }, select: { provider: true } });
    if (!owned) return NextResponse.json({ error: "Dataset introuvable" }, { status: 404 });
    assertOwner(session, owned.provider);
    await requireMutationGrant(session, authorization, {
      operation: "delete-dataset",
      datasetId: id,
      intentParts: [id, txHash ?? ""],
    });
    const dataset = await deleteDataset(id, session.address, txHash);
    return NextResponse.json(datasetResponse(dataset));
  } catch (err) {
    return errorResponse(err);
  }
}

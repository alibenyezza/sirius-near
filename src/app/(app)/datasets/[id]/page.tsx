import { DatasetDetail } from "./DatasetDetail";

/**
 * Fiche d'un dataset, réservée à son propriétaire. La page ne fait aucun contrôle : elle
 * affiche ce que renvoient les routes privées (`/api/datasets/[id]/settings` et `/stats`),
 * qui vérifient la session et la propriété et répondent 404 à tout autre wallet.
 */
export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DatasetDetail id={id} />;
}

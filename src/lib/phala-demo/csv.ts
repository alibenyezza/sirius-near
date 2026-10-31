import { parseCsv } from "@/lib/sirius/metrics";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";

export function csvWithTargetLast(text: string, target: string): Uint8Array<ArrayBuffer> {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header || new Set(header).size !== header.length) throw new Error("En-têtes CSV invalides");
  const index = header.indexOf(target);
  if (index < 0) throw new Error("Colonne cible absente");
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const ordered = rows.map((row, rowIndex) => {
    if (row.length !== header.length) throw new Error("Nombre de colonnes CSV incohérent");
    if (rowIndex > 0 && (!row[index].trim() || !Number.isFinite(Number(row[index])))) throw new Error("La colonne à prédire doit être numérique sur chaque ligne");
    return [...row.filter((_, column) => column !== index), row[index]].map(quote).join(",");
  }).join("\n");
  const bytes = new TextEncoder().encode(ordered);
  if (!bytes.length || bytes.length > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
  return bytes;
}

export interface DatasetMetrics {
  rowCount: number;
  columnCount: number;
}

export const MAX_CSV_ROWS = 20_000;
export const MAX_CSV_COLUMNS = 64;
const MAX_CELL_CHARS = 10_000;

/** Parser CSV conforme RFC 4180 (guillemets, échappements "", CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    if (field.length > MAX_CELL_CHARS) throw new Error("cellule CSV trop volumineuse");
    if (row.length >= MAX_CSV_COLUMNS) throw new Error(`trop de colonnes CSV (max ${MAX_CSV_COLUMNS})`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (rows.length >= MAX_CSV_ROWS) throw new Error(`trop de lignes CSV (max ${MAX_CSV_ROWS})`);
    rows.push(row);
    row = [];
  };
  const append = (value: string) => {
    if (field.length + value.length > MAX_CELL_CHARS) throw new Error("cellule CSV trop volumineuse");
    field += value;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else inQuotes = false;
      } else append(c);
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushField();
      pushRow();
    } else if (c !== "\r") append(c);
  }

  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

/** Calcule les seuls volumes publiables depuis le CSV ouvert dans le runner. */
export function computeMetrics(content: Buffer): DatasetMetrics {
  const table = parseCsv(content.toString("utf-8"));
  if (table.length === 0) {
    return { rowCount: 0, columnCount: 0 };
  }

  const [header, ...dataRows] = table;
  return { rowCount: dataRows.length, columnCount: header.length };
}

/** Élimine les stats détaillées encore présentes sur les datasets créés avant le correctif. */
export function publicDatasetMetrics(value: unknown): DatasetMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { rowCount, columnCount } = value as Record<string, unknown>;
  if (
    typeof rowCount !== "number" ||
    typeof columnCount !== "number" ||
    !Number.isSafeInteger(rowCount) ||
    !Number.isSafeInteger(columnCount) ||
    rowCount < 0 ||
    rowCount > MAX_CSV_ROWS ||
    columnCount < 0 ||
    columnCount > MAX_CSV_COLUMNS
  ) {
    return null;
  }
  return { rowCount, columnCount };
}

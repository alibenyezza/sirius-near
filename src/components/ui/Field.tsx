/** Paire label/valeur d'un bloc de détails (à placer dans un <dl>). */
export function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col wrap-anywhere">
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-foreground" : "text-foreground"}>{value}</dd>
    </div>
  );
}

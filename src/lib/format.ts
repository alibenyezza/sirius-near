export function truncate(s: string, head = 8, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export type BadgeVariant = "default" | "accent" | "positive" | "negative" | "muted" | "warning";

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  default: "border-white/10 bg-surface text-foreground",
  accent: "border-accent/40 bg-accent/10 text-accent",
  positive: "border-positive/40 bg-positive/10 text-positive",
  negative: "border-negative/40 bg-negative/10 text-negative",
  muted: "border-muted/40 bg-muted/10 text-muted",
  warning: "border-yellow-400/40 bg-yellow-400/10 text-yellow-400",
};

export function Badge({ variant = "default", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-block max-w-full rounded-full border px-3 py-1 align-middle text-xs font-medium whitespace-normal uppercase tracking-wider wrap-anywhere ${VARIANT_STYLES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

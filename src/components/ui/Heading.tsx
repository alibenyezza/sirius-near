type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" };

/** Titre d'une carte. */
export function CardTitle({ as: Tag = "h2", className = "", ...props }: HeadingProps) {
  return <Tag className={`text-base font-semibold tracking-tight ${className}`} {...props} />;
}

/** Libellé de section, au-dessus d'un groupe de cartes ou d'une liste. */
export function SectionTitle({ as: Tag = "h2", className = "", ...props }: HeadingProps) {
  return <Tag className={`text-xs font-semibold uppercase tracking-wider text-muted ${className}`} {...props} />;
}

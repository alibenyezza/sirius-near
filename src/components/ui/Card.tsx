interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ children, className = "", ...props }: CardProps) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-border bg-surface/50 p-5 wrap-anywhere ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

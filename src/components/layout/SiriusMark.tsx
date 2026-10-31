import Image from "next/image";

/**
 * Emblème Sirius : l'anneau de particules de la marque, fond détouré (la luminosité sert
 * d'opacité) pour se fondre sur n'importe quelle surface sombre.
 */
export function SiriusMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return <Image src="/images/sirius-mark.png" alt="" width={size} height={size} className={`select-none ${className}`} draggable={false} />;
}

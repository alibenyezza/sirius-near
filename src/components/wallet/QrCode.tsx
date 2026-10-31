import { QR_QUIET_ZONE, type QrCodeData } from "./qr";

/**
 * Dessin du QR code. Toujours noir sur blanc, quel que soit le thème : les lecteurs
 * s'attendent à un fort contraste et certains refusent un code inversé.
 */
export function QrCode({ data, label, className = "" }: { data: QrCodeData; label: string; className?: string }) {
  const side = data.size + QR_QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${side} ${side}`}
      shapeRendering="crispEdges"
      className={className}
      data-testid="receive-qr"
    >
      <rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={side} height={side} fill="#ffffff" />
      <path d={data.path} fill="#000000" />
    </svg>
  );
}

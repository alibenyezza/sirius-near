import { useId, type ReactNode } from "react";

type Translate = (value: string) => string;

const C = {
  fill: "#131313",
  stroke: "#2a2a2a",
  text: "#e8e8e8",
  muted: "#aaaaaa",
};
const edge = { stroke: C.muted, strokeWidth: 1.2 } as const;

function Box({ x, y, w, h, title, sub, strong }: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  strong?: boolean;
}) {
  const titles = title.split("\n");
  const subtitles = sub ? sub.split("\n") : [];
  const textHeight = titles.length * 20 + subtitles.length * 17;
  const top = y + (h - textHeight) / 2;

  return (
    <g data-diagram-node>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={C.fill} stroke={strong ? C.text : C.stroke} strokeWidth={strong ? 1.5 : 1} />
      {titles.map((line, index) => (
        <text key={`title-${index}`} x={x + w / 2} y={top + 15 + index * 20} textAnchor="middle" fill={C.text} fontSize={15} fontWeight={600}>{line}</text>
      ))}
      {subtitles.map((line, index) => (
        <text key={`sub-${index}`} x={x + w / 2} y={top + titles.length * 20 + 13 + index * 17} textAnchor="middle" fill={C.muted} fontSize={12}>{line}</text>
      ))}
    </g>
  );
}

function DiagramFrame({ children, height, title, description, d }: {
  children: (markerEnd: string) => ReactNode;
  height: number;
  title: string;
  description: string;
  d: Translate;
}) {
  const id = useId();
  const arrowId = `${id}-arrow`;

  return (
    <figure className="min-w-0 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4">
      <div className="overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-foreground" role="region" aria-label={title} tabIndex={0}>
        <svg viewBox={`0 0 760 ${height}`} className="h-auto w-full" style={{ minWidth: 760 }} fill="none" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
          <title id={`${id}-title`}>{title}</title>
          <desc id={`${id}-description`}>{description}</desc>
          <defs>
            <marker id={arrowId} markerWidth={9} markerHeight={9} refX={7} refY={3} orient="auto">
              <path d="M0,0 L7,3 L0,6 Z" fill={C.muted} />
            </marker>
          </defs>
          {children(`url(#${arrowId})`)}
        </svg>
      </div>
      <figcaption className="mt-3 text-xs text-muted">{d("Sur petit écran, faites défiler le schéma horizontalement.")}</figcaption>
    </figure>
  );
}

function EdgeLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return <text x={x} y={y} textAnchor="middle" fill={C.muted} fontSize={12} stroke={C.fill} strokeWidth={5} paintOrder="stroke" strokeLinejoin="round">{children}</text>;
}

export function OverviewDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={460} title={d("Flux du dataset et du règlement")} description={d("Le provider envoie le CSV chiffré au runner et publie le titre. Le runner utilise IPFS pour le stockage chiffré et livre le modèle chiffré au borrower. Le borrower verrouille le stablecoin ; le runner publie le préimage au règlement.")} d={d}>
      {(markerEnd) => <>
        <g {...edge} markerEnd={markerEnd}>
          <path d="M232 55 H276" />
          <path d="M492 55 H526" />
          <path d="M125 92 V356" />
          <path d="M635 92 V356" />
          <path d="M365 92 V176" />
          <path d="M405 178 V94" />
          <path d="M278 75 H260 V300 H385 V356" />
        </g>
        <Box x={20} y={20} w={210} h={70} title="Provider" sub={d("propriétaire du dataset")} />
        <Box x={280} y={20} w={210} h={70} title="Runner" sub={d("stub ou TEE attesté")} strong />
        <Box x={530} y={20} w={210} h={70} title="Borrower" sub={d("entraîne un modèle")} />
        <Box x={280} y={180} w={210} h={70} title="IPFS / Pinata" sub={d("stockage chiffré")} />
        <Box x={20} y={360} w={720} h={80} title="Robinhood Chain · EVM" sub={d("DatasetRegistry · KYB · Escrow\nCrédits en stablecoin · retraits séparés")} />
        <EdgeLabel x={255} y={14}>{d("CSV chiffré")}</EdgeLabel>
        <EdgeLabel x={510} y={14}>{d("modèle chiffré")}</EdgeLabel>
        <EdgeLabel x={125} y={225}>{d("publie le titre")}</EdgeLabel>
        <EdgeLabel x={635} y={225}>{d("verrouille le stablecoin")}</EdgeLabel>
        <EdgeLabel x={316} y={140}>pin</EdgeLabel>
        <EdgeLabel x={450} y={140}>{d("lecture")}</EdgeLabel>
        <EdgeLabel x={385} y={332}>{d("release + préimage")}</EdgeLabel>
      </>}
    </DiagramFrame>
  );
}

export function FairExchangeDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={400} title={d("Livraison du modèle et paiement")} description={d("Avant échéance, release crédite le provider et publie le préimage dans une seule transaction. Ensuite, le navigateur ouvre la capsule hors chaîne. Sans release avant échéance, refund crédite le borrower.")} d={d}>
      {(markerEnd) => <>
        <g {...edge} markerEnd={markerEnd}>
          <path d="M200 155 L256 65" />
          <path d="M200 180 L256 290" />
          <path d="M462 65 H516" />
          <path d="M630 112 V156" />
          <path d="M462 290 H516" />
        </g>
        <Box x={20} y={132} w={180} h={74} title={d("Calcul du runner")} sub={d("modèle prêt ?")} strong />
        <Box x={260} y={30} w={200} h={70} title={d("Capsule verrouillée")} sub={d("modèle chiffré")} />
        <Box x={520} y={20} w={220} h={90} title="release" sub={d("provider crédité\n+ préimage public\nune transaction EVM")} strong />
        <Box x={520} y={160} w={220} h={70} title={d("Capsule ouverte")} sub={d("ensuite, dans le navigateur")} />
        <Box x={260} y={255} w={200} h={70} title={d("Pas de release")} sub={d("échec ou délai dépassé")} />
        <Box x={520} y={250} w={220} h={80} title="refund" sub={d("après échéance\nborrower crédité")} />
        <EdgeLabel x={380} y={375}>{d("Les crédits en stablecoin se retirent séparément.")}</EdgeLabel>
      </>}
    </DiagramFrame>
  );
}

export function EscrowLifecycleDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={270} title={d("Cycle de vie de l'escrow")} description={d("lock crée un prêt Locked. Avant échéance, release le passe à Released ; après échéance, refund le passe à Refunded. Ces deux issues sont exclusives. Le retrait du crédit est séparé.")} d={d}>
      {(markerEnd) => <>
        <g {...edge} markerEnd={markerEnd}>
          <path d="M200 130 H246" />
          <path d="M462 115 L516 65" />
          <path d="M462 145 L516 205" />
        </g>
        <Box x={20} y={95} w={180} h={70} title="lock" sub={d("signé par le borrower")} />
        <Box x={250} y={90} w={210} h={80} title="Locked" sub={d("Stablecoin verrouillé\nprofil + hashlock + délai")} strong />
        <Box x={520} y={20} w={220} h={90} title="Released" sub={d("release avant échéance\npréimage public\nprovider crédité")} />
        <Box x={520} y={165} w={220} h={80} title="Refunded" sub={d("refund après échéance\nborrower crédité")} />
      </>}
    </DiagramFrame>
  );
}

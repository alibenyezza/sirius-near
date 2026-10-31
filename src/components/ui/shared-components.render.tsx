/**
 * Rendu HTML statique des composants partagés, pour `shared-components.test.ts`.
 *
 * Ce script tourne dans un processus à part, SANS la condition `react-server` que
 * `pnpm test` active pour tout le reste : sous cette condition React n'expose ni contexte
 * ni `react-dom/server`, alors que ces composants sont des composants client. Cela vérifie
 * du même coup que leurs imports se chargent sans le contournement `server-only`.
 *
 * Sortie : un objet JSON { nom du cas: HTML } sur la sortie standard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { DatasetAddTile, DatasetCard } from "@/components/datasets/DatasetCard";
import { PriceBreakdown } from "@/components/datasets/PriceBreakdown";
import { DisclaimerNote } from "./DisclaimerNote";
import { StatusPill } from "./StatusPill";
import { STATUS_KINDS } from "./status";

const token = { symbol: "USDG", decimals: 6 };
const hostile = "<img src=x onerror=alert(1)>\"'";

const baseCard = {
  name: "Retail churn",
  category: "Commerce",
  modelId: "logistic_regression",
  modelVersion: "1.0.0",
  rowCount: 12345,
  columnCount: 8,
  priceAtomic: "23000000",
  token,
  status: "online" as const,
  borrowCount: 12,
};

const cases: Record<string, React.ReactNode> = {
  "note-default": <DisclaimerNote />,
  "note-info": <DisclaimerNote variant="info" messages={["betaLimits"]} />,
  "note-warning": <DisclaimerNote variant="warning" messages={["dataLimits", "retrainDeterministic"]} />,
  "note-children-hostile": <DisclaimerNote messages={[]}>{"<b onmouseover=\"x\">"}</DisclaimerNote>,
  "note-duplicates": <DisclaimerNote messages={["betaLimits", "betaLimits"]} />,
  "note-empty": <DisclaimerNote messages={[]} />,
  "note-unknown-id": <DisclaimerNote messages={["constructor", "__proto__", "betaLimits"] as never} />,
  "pill-unknown": <StatusPill status={"\"><script>alert(1)</script>" as never} />,
  "price-example": <PriceBreakdown providerAtomic="20000000" computeAtomic="3000000" token={token} minimumAtomic="1000" />,
  "price-provider": <PriceBreakdown providerAtomic="20000000" computeAtomic="3000000" token={token} perspective="provider" />,
  "price-borrower": <PriceBreakdown providerAtomic="20000000" computeAtomic="3000000" token={token} perspective="borrower" />,
  "price-below-minimum": <PriceBreakdown providerAtomic="999" computeAtomic="3000000" token={token} minimumAtomic="1000" />,
  "price-invalid-amount": <PriceBreakdown providerAtomic="12.5" computeAtomic="3000000" token={token} />,
  "price-minimum-zero": (
    <>
      <PriceBreakdown providerAtomic="0" computeAtomic="3000000" token={token} minimumAtomic="0" />
      <PriceBreakdown providerAtomic="1" computeAtomic="3000000" token={token} minimumAtomic={BigInt(0)} />
    </>
  ),
  "price-max-uint96": (
    <PriceBreakdown providerAtomic="79228162514264337593543950334" computeAtomic="1" token={token} minimumAtomic="1000" />
  ),
  "price-invalid-compute": <PriceBreakdown providerAtomic="20000000" computeAtomic="x" token={token} />,
  "price-invalid-minimum": <PriceBreakdown providerAtomic="20000000" computeAtomic="3000000" token={token} minimumAtomic="-5" />,
  "price-invalid-decimals": <PriceBreakdown providerAtomic="1" computeAtomic="1" token={{ symbol: "USDG", decimals: 6.5 }} />,
  "price-hostile-symbol": <PriceBreakdown providerAtomic="1000000" computeAtomic="1000000" token={{ symbol: "<img src=x>", decimals: 6 }} />,
  "price-testnet-18": <PriceBreakdown providerAtomic="20000000000000000000" computeAtomic="3000000000000000000" token={{ symbol: "USDC", decimals: 18 }} />,
  "card-full": <DatasetCard {...baseCard} revenueAtomic="240000000" verified href="/datasets/abc" />,
  "card-minimal": <DatasetCard name="X" token={token} status="paused" borrowCount={1} priceKind="providerReceives" priceAtomic="20000000" />,
  "card-empty": <DatasetCard name="X" token={token} status="online" borrowCount={0} />,
  "card-unverified": <DatasetCard {...baseCard} verified={false} />,
  "card-null-revenue": <DatasetCard {...baseCard} revenueAtomic={null} />,
  "card-hostile": (
    <DatasetCard {...baseCard} name={hostile} category={hostile} modelId={hostile} href="javascript:alert(1)" priceAtomic="1e6" borrowCount={-3} />
  ),
  "card-href-protocol-relative": <DatasetCard {...baseCard} href="//evil.example/x" />,
  "card-href-absolute": <DatasetCard {...baseCard} href="https://evil.example" />,
  "card-href-backslash": <DatasetCard {...baseCard} href="/\\evil.example" />,
  "card-pair": (
    <>
      <DatasetCard {...baseCard} />
      <DatasetCard {...baseCard} />
    </>
  ),
  "card-destroyed": <DatasetCard {...baseCard} status="destroyed" />,
  "card-testnet-18": (
    <DatasetCard
      {...baseCard}
      token={{ symbol: "USDC", decimals: 18 }}
      priceAtomic="20000000000000000000"
      revenueAtomic="240000000000000000000"
    />
  ),
  "card-size": <DatasetCard {...baseCard} sizeBytes={3 * 1024 * 1024} />,
  "card-bad-size": (
    <>
      <DatasetCard {...baseCard} sizeBytes={-5} />
      <DatasetCard {...baseCard} sizeBytes={Infinity} />
      <DatasetCard {...baseCard} sizeBytes={0} />
    </>
  ),
  "card-model-version": (
    <>
      <DatasetCard {...baseCard} modelVersion="9.9.9" />
      <DatasetCard {...baseCard} modelVersion={null} />
      <DatasetCard {...baseCard} modelVersion={undefined} />
    </>
  ),
  "card-float-size": <DatasetCard {...baseCard} sizeBytes={1.5} />,
  "card-blank-name": <DatasetCard {...baseCard} name="   " href="/datasets/abc" />,
  "card-no-size": <DatasetCard {...baseCard} sizeBytes={null} />,
  "card-no-category": <DatasetCard {...baseCard} category={null} />,
  "note-unknown-variant": <DisclaimerNote variant={"danger" as never} messages={["betaLimits"]} />,
  "card-invalid-amounts": <DatasetCard {...baseCard} priceAtomic="1e6" revenueAtomic="-1" />,
  "tile": <DatasetAddTile href="/datasets/new" />,
  "tile-unsafe": <DatasetAddTile href="https://evil.example" />,
};
for (const status of STATUS_KINDS) cases[`pill-${status}`] = <StatusPill status={status} />;

const output: Record<string, string> = {};
for (const [name, node] of Object.entries(cases)) {
  output[name] = renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}
process.stdout.write(JSON.stringify(output));

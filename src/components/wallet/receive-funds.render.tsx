/**
 * Rendu HTML statique de la section « Ajouter des fonds » par transfert, pour `add-funds.test.ts`.
 *
 * Tourne dans un processus à part, sans la condition `react-server` (comme
 * `src/components/ui/shared-components.render.tsx`) : ces composants sont des composants
 * client, qui ont besoin du contexte React et de `react-dom/server`.
 *
 * Sortie : un objet JSON { nom du cas: HTML } sur la sortie standard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { ReceiveFunds } from "./ReceiveFunds";

const lower = "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d";
const hostile = "<img src=x onerror=alert(1)>";

const cases: Record<string, React.ReactNode> = {
  mainnet: <ReceiveFunds network="mainnet" address={lower} />,
  testnet: <ReceiveFunds network="testnet" address={lower} />,
  embedded: <ReceiveFunds network="mainnet" address={lower} embedded />,
  invalid: <ReceiveFunds network="mainnet" address={hostile} />,
  empty: <ReceiveFunds network="mainnet" address="" />,
};

const output: Record<string, string> = {};
for (const [name, node] of Object.entries(cases)) {
  output[name] = renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}
process.stdout.write(JSON.stringify(output));

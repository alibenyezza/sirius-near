import "server-only";
import type { Chain } from "viem";
import { resolveServerNetwork, type EvmNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";

/**
 * État public du protocole, lu dans la configuration du serveur : une seule source pour la page
 * /status et pour l'outil `get_protocol_status` de l'assistant, qui ne peuvent donc pas dire deux
 * choses différentes. Données publiques seulement (réseau, plafonds, adresses de contrats),
 * jamais une valeur secrète. Textes en anglais, comme la page.
 */

export interface ProtocolContract {
  /** Clé stable, reprise par l'outil de l'assistant. */
  key: "escrow" | "datasetRegistry" | "kybRegistry" | "stablecoin";
  /** Libellé affiché : le symbole du jeton pour `stablecoin`. */
  label: string;
  address: string | null;
}

export interface ProtocolStatus {
  network: EvmNetwork;
  chain: Chain;
  mainnet: boolean;
  /** Symbole du jeton de règlement (« USDG » sur mainnet). */
  symbol: string;
  /** Enclave exigée et mesures épinglées : vrai seulement si tout est configuré. */
  enclave: boolean;
  confidentialCompute: string;
  settlement: string;
  externalAudit: string;
  /** Plafonds formatés avec le symbole ; `null` hors mainnet ou non configurés. */
  limits: { perLoan: string | null; totalExposure: string | null };
  contracts: ProtocolContract[];
}

export const PROTOCOL_SETTLEMENT = "On-chain escrow: the provider is paid when training completes; the borrower is refunded after the deadline otherwise";
export const PROTOCOL_EXTERNAL_AUDIT = "Not yet audited. Internal review completed on 1 October 2026.";

export function readProtocolStatus(env: Readonly<Record<string, string | undefined>> = process.env): ProtocolStatus {
  const { network, chain } = resolveServerNetwork();
  const mainnet = network === "mainnet";
  const symbol = stablecoinSymbol(network);
  const enclave = env.TEE_MODE === "phala" && env.SIRIUS_REQUIRE_PHALA === "true" && Boolean(env.SIRIUS_EXPECTED_MRTD);
  const maxLoan = env.SIRIUS_MAX_LOAN_USDC?.trim() || null;
  const maxExposure = env.SIRIUS_MAX_EXPOSURE_USDC?.trim() || null;
  return {
    network,
    chain,
    mainnet,
    symbol,
    enclave,
    confidentialCompute: enclave
      ? "Hardware enclave (Intel TDX), attested on every request against pinned measurements"
      : "Demonstration mode: training is not yet isolated in an enclave on this instance",
    settlement: PROTOCOL_SETTLEMENT,
    externalAudit: PROTOCOL_EXTERNAL_AUDIT,
    limits: {
      perLoan: mainnet && maxLoan ? `${maxLoan} ${symbol}` : null,
      totalExposure: mainnet && maxExposure ? `${maxExposure} ${symbol} locked across all loans` : null,
    },
    contracts: [
      { key: "escrow", label: "Escrow", address: env.SIRIUS_ESCROW_ADDRESS || null },
      { key: "datasetRegistry", label: "Dataset registry", address: env.SIRIUS_DATASET_ADDRESS || null },
      { key: "kybRegistry", label: "KYB registry", address: env.SIRIUS_KYB_ADDRESS || null },
      { key: "stablecoin", label: symbol, address: env.SIRIUS_USDC_ADDRESS || null },
    ],
  };
}

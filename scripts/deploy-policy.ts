/**
 * Règles de déploiement des contrats, sans accès réseau : testables et partagées par
 * `contracts/scripts/deploy.ts`. Sur mainnet, chaque raccourci de testnet devient un refus.
 */

import { MAINNET_STABLECOIN_ADDRESS, MAINNET_STABLECOIN_SYMBOL } from "../src/lib/evm/stablecoin";

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
/**
 * Seul jeton accepté sur mainnet : USDG (Paxos), six décimales, en minuscules pour
 * les comparaisons. Source unique dans src/lib/evm/stablecoin.ts.
 */
export const MAINNET_STABLECOIN = MAINNET_STABLECOIN_ADDRESS;
/** @deprecated Nom historique gardé par compatibilité (cahier des charges A8) : vaut l'USDG, pas l'USDC. Aucun importateur hors tests. */
export const MAINNET_USDC = MAINNET_STABLECOIN;

type Env = Record<string, string | undefined>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;

export interface DeploymentPlan {
  billingVersion: "6" | "7";
  escrowContract: "SiriusEscrow" | "SiriusEscrowV7";
  kybOpen: boolean;
  sharedRoles: boolean;
  dryRun: boolean;
  /** Adresses à vérifier on-chain comme contrats (Safe) avant tout envoi. */
  mustBeContracts: string[];
}

function address(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!ADDRESS.test(value) || ZERO.test(value)) throw new Error(`${name} doit être une adresse EVM non nulle`);
  return value.toLowerCase();
}

export function deploymentPlan(env: Env, chainId: number, deployer: string): DeploymentPlan {
  const mainnet = chainId === MAINNET_CHAIN_ID;
  if (!mainnet && chainId !== TESTNET_CHAIN_ID) throw new Error(`Réseau inattendu : ${chainId}`);
  if (mainnet && env.SIRIUS_ALLOW_MAINNET !== "true") {
    throw new Error("Déploiement mainnet bloqué. Pour passer outre en connaissance de cause : SIRIUS_ALLOW_MAINNET=true");
  }
  const requestedVersion = env.SIRIUS_BILLING_VERSION?.trim();
  if (mainnet && requestedVersion !== "7") {
    throw new Error("Sur mainnet, SIRIUS_BILLING_VERSION=7 doit être explicite : la v6 n'a ni devis ni retenue bornée");
  }
  const billingVersion = (requestedVersion ?? "6") as DeploymentPlan["billingVersion"];
  if (billingVersion !== "6" && billingVersion !== "7") throw new Error("Version de facturation invalide");

  const kybOpen = env.SIRIUS_KYB_MODE === "open";
  if (kybOpen && mainnet) throw new Error("SIRIUS_KYB_MODE=open est réservé au testnet 46630");
  const sharedRoles = env.SIRIUS_ALLOW_SHARED_ROLES === "true";
  if (sharedRoles && mainnet) throw new Error("SIRIUS_ALLOW_SHARED_ROLES est interdit hors testnet");

  const usdc = address(env, "SIRIUS_USDC_ADDRESS");
  if (!usdc) throw new Error("SIRIUS_USDC_ADDRESS doit être une adresse EVM non nulle");
  if (mainnet && usdc !== MAINNET_STABLECOIN) {
    throw new Error(`Sur mainnet, SIRIUS_USDC_ADDRESS doit être l'${MAINNET_STABLECOIN_SYMBOL} de Paxos ${MAINNET_STABLECOIN} : aucun autre jeton, USDC compris`);
  }
  const lockAuthorizer = address(env, "SIRIUS_LOCK_AUTHORIZER");
  if (!lockAuthorizer) throw new Error("SIRIUS_LOCK_AUTHORIZER doit être une adresse EVM non nulle");

  const mustBeContracts: string[] = [];
  if (!kybOpen) {
    const admin = address(env, "SIRIUS_KYB_ADMIN");
    const verifier = address(env, "SIRIUS_KYB_VERIFIER");
    if ((!admin || !verifier) && !sharedRoles) {
      throw new Error("SIRIUS_KYB_ADMIN et SIRIUS_KYB_VERIFIER requis : ces rôles ne reviennent jamais à la clé de déploiement");
    }
    if (mainnet) {
      // Quatre rôles, quatre adresses : la clé de déploiement ne paie que le gas, le Safe
      // gouverne le KYB, le vérificateur atteste, l'enclave signe les locks.
      const roles = [deployer.toLowerCase(), admin!, verifier!, lockAuthorizer];
      if (new Set(roles).size !== roles.length) {
        throw new Error("Sur mainnet, déployeur, admin KYB, vérificateur KYB et signataire de lock doivent être quatre adresses distinctes");
      }
      mustBeContracts.push(admin!);
    } else if (admin && verifier && admin === verifier && !sharedRoles) {
      throw new Error("SIRIUS_KYB_ADMIN et SIRIUS_KYB_VERIFIER doivent être distinctes. Pour un déploiement jetable : SIRIUS_ALLOW_SHARED_ROLES=true");
    }
  }

  return {
    billingVersion,
    escrowContract: billingVersion === "7" ? "SiriusEscrowV7" : "SiriusEscrow",
    kybOpen,
    sharedRoles,
    dryRun: env.SIRIUS_DEPLOY_DRY_RUN === "true",
    mustBeContracts,
  };
}

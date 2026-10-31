import type { DatasetMetrics } from "@/lib/sirius/metrics";
import type { ModelSelection } from "@/lib/models/registry";
import type { LoanExecutionAttestation } from "./types";

// Le JSON chiffré en base64 doit rester sous les 4,5 Mo admis par Vercel.
export const MAX_DATASET_BYTES = 3 * 1024 * 1024;
export const DATASET_INGRESS_INFO_PREFIX = "sirius-dataset-ingress-v1:";

export interface DatasetIngressKey {
  version: 1;
  publicKey: string;
  origin: string;
}

export interface DatasetIngressEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface RunnerDeliveryEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

/**
 * Nature du secret qui verrouille une capsule et sera publié par l'escrow.
 */
export type RunnerReleaseKind = "evm-preimage";

export interface RunnerReleaseEnvelope extends RunnerDeliveryEnvelope {
  release: RunnerReleaseKind;
}

/**
 * Verrou d'escrow EVM : préimage secret et son empreinte publique.
 *
 * Typés `0x${string}` et non `string` : ces valeurs traversent directement viem et le
 * contrat, où un hexadécimal sans préfixe serait interprété différemment. Le type
 * porte la convention plutôt que de la laisser à la discipline de l'appelant.
 */
export interface EvmEscrowLock {
  hashlock: `0x${string}`;
  preimage: `0x${string}`;
}

/**
 * Contrat de la frontière Next ↔ runner confidentiel (inc.3d-B). Le runner est le SEUL
 * détenteur de la master key enclave ; le Next lui passe des inputs explicites (jamais de
 * handle DB) et ne voit jamais plaintext / DEK / clé du modèle / fulfillment avant l'heure.
 */

/** Référence d'un dataset chiffré au repos (ce que le Next connaît sans jamais déchiffrer). */
export type DatasetRef = {
  datasetId: string; // contexte de wrap de la DEK
  cid: string; // blob chiffré sur IPFS
  wrappedKey: string; // DEK scellée
  merkleRoot: string; // intégrité vérifiée après déchiffrement
  priceUsdcAtomic: string; // termes provider authentifiés par le reçu runner (USDC, six décimales)
  challengeDays: number;
} & ModelSelection;

/** Entrée d'un entraînement libre (self-train) : dataset + où livrer le modèle chiffré. */
export type TrainingInput = DatasetRef & {
  keyContext: string; // contexte de la clé du modèle livré (redérivable pour la livraison)
  filename: string; // nom du blob modèle sur IPFS
}

/** Entrée d'un self-train : le runner dérive lui-même la clé et le nom du modèle. */
export type SelfTrainingInput = DatasetRef & {
  jobId: string;
  owner: string;
}

/**
 * Entrée d'un job d'emprunt : juste la ref dataset + le `loanId`. Le contexte de clé et le
 * nom de blob sont dérivés du `loanId` DANS le runner (pas de champ libre côté appelant) →
 * un modèle ne peut pas être chiffré sous le contexte d'un autre emprunt.
 */
export type LoanJobInput = DatasetRef & {
  loanId: string;
  borrower: string;
}

/** Sortie du scellement d'un dataset (upload provider) : rien de sensible ne fuit. */
export interface SealDatasetResult {
  cid: string;
  wrappedKey: string;
  merkleRoot: string;
  metrics: DatasetMetrics;
  sizeBytes: number;
}

export interface AuthorizedSealDatasetResult extends SealDatasetResult {
  runnerReceipt: string;
}

export interface AuthorizedTrainingResult {
  modelCid: string;
  metrics: Record<string, number>;
  runnerReceipt: string;
  modelKeyEnvelope?: RunnerDeliveryEnvelope;
}

export interface LoanJobResult {
  modelCid: string;
  metrics: Record<string, number>;
  attestation: LoanExecutionAttestation;
  releaseEnvelope?: RunnerReleaseEnvelope;
  releaseEnvelopeHash: string;
  runnerReceipt: string;
}

export type RecoveredLoanResult =
  | { state: "missing" | "pending" | "failed" }
  | { state: "ready"; deliveryPublicKey: string; result: LoanJobResult };

export type RunnerEscrowReconciliation =
  | { state: "active" }
  | { state: "cancelled"; txHash: string }
  | { state: "settled"; txHash: string };

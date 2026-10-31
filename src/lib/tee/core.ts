import "server-only";
import { createHash } from "node:crypto";
import {
  decrypt,
  encrypt,
  generateKey,
  wrapKey,
  unwrapKey,
  deriveKey,
  getMasterKey,
  encodeKey,
  type EncryptedPayload,
} from "@/lib/crypto/encryption";
import { buildMerkleTree, verifyRoot, DEFAULT_CHUNK_SIZE } from "@/lib/crypto/merkle";
import { computeMetrics } from "@/lib/sirius/metrics";
import { fetchFromIpfs, uploadToIpfs } from "@/lib/ipfs/pinata";
import { trainSelectedModel } from "./model-registry";
import { DatasetValidationError, validateTrainingDataset } from "./train";
import { gateModel } from "./output-gate";
import { decryptDatasetIngress } from "./ingress";
import { evmEscrowBinding, type EvmEscrowBinding } from "./evm-binding";
import { trustedEscrowBinding } from "@/lib/evm/history";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";
import { budgetRunnerJob } from "@/lib/runner/budget";
import { countsAsRunnerFailure } from "@/lib/runner/failure-policy";
import { INVALID_DATASET_MESSAGE, trainInWorker } from "./bounded-training";
import type { ComputeQuote } from "@/lib/billing/quote";
import { quoteWorkflow, requireBillingBudget } from "@/lib/billing/runner";
import { MAX_DATASET_BYTES } from "./contract";
import type {
  DatasetIngressEnvelope,
  DatasetRef,
  TrainingInput,
  SelfTrainingInput,
  LoanJobInput,
  SealDatasetResult,
  EvmEscrowLock,
} from "./contract";
import type { ModelSelection } from "@/lib/models/registry";

/**
 * Cœur confidentiel, sans accès à la base applicative : seul module qui touche la master key enclave,
 * le plaintext des datasets, les DEK et le fulfillment. Prend des inputs explicites → sera
 * exposé tel quel par le service runner isolé (inc.3d-B). Le Next l'appelle (in-process au
 * MVP, via HTTP en CVM) mais ne voit jamais ces secrets.
 */

// Contextes de dérivation (couplés à la master key enclave, versionnés pour rotation). Privés
// sauf selfTrainKeyContext (le contexte de chiffrement d'un self-train, choisi par l'appelant
// in-process). AUCUN contexte n'est exposé à un primitive de dérivation à contexte libre : la
// lecture de clé passe par les fonctions scopées loanModelKey/selfTrainModelKey (cf audit B.2).
const datasetKeyContext = (datasetId: string) => `wrap:dataset:v1:${datasetId}`;

// `canonicalSubject` est indispensable ici, pas cosmétique : la clé du modèle est
// dérivée une fois au calcul et **redérivée** à chaque livraison. Une adresse EVM
// écrite en EIP-55 d'un côté et en minuscules de l'autre produirait deux clés, donc
// un modèle définitivement indéchiffrable — sans aucune erreur explicite, seulement
// un échec d'authentification AES-GCM.
export const selfTrainKeyContext = (jobId: string, owner: string) =>
  `model:selftrain:${canonicalSubject(owner)}:${jobId}`;

/**
 * Contexte du préimage EVM.
 *
 * 1. Il inclut le **chainId et l'adresse du contrat**. Sans eux, le même couple
 *    (borrower, loanId) produit le même secret sur deux déploiements ou deux
 *    chaînes — et comme c'est le préimage qui verrouille la capsule du modèle,
 *    en publier un sur la chaîne bon marché ouvrirait la capsule de l'autre.
 *    Ces deux valeurs viennent de la configuration du runner, jamais de l'appelant.
 *
 * 2. Le `borrower` est **normalisé en minuscules**. Une adresse EVM s'écrit en
 *    casse mixte ; deux écritures du même compte donneraient deux préimages, donc
 *    une capsule inouvrable.
 *
 * 3. La concaténation est **non ambiguë** : `chainId` est un entier, `escrow` et
 *    `borrower` sont des adresses de longueur fixe validées, et le seul champ de
 *    longueur libre — `loanId` — est en dernière position. Aucun découpage
 *    alternatif ne peut donc produire la même chaîne.
 */
function evmSubject(borrower: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(borrower)) throw new AppError("Adresse borrower invalide", 400);
  return borrower.toLowerCase();
}

const evmEscrowKeyContext = (loanId: string, borrower: string) => {
  const { chainId, escrow } = evmEscrowBinding();
  return `escrow:v2:${chainId}:${escrow}:${evmSubject(borrower)}:${loanId}`;
};

/**
 * Contexte de la clé du **modèle** sur le rail EVM, séparé par les mêmes facteurs.
 *
 * Séparer le seul préimage d'escrow ne suffisait pas : cela verrouille le cadenas,
 * pas le contenu. La clé du modèle chiffre le blob déposé sur IPFS, et elle était
 * dérivée de `model:loan:<borrower>:<loanId>` — donc identique sur deux déploiements.
 * Un emprunteur pouvait obtenir cette clé au terme d'un prêt bon marché, puis s'en
 * servir pour déchiffrer le modèle d'un prêt homonyme ailleurs, sans jamais payer.
 */
const evmModelKeyContext = (loanId: string, borrower: string, binding = evmEscrowBinding()) => {
  const { chainId, escrow } = trustedEscrowBinding(binding);
  return `model:loan:v2:${chainId}:${escrow}:${evmSubject(borrower)}:${loanId}`;
};

/**
 * Scelle un dataset (upload provider) : Merkle + métriques sur le plaintext → DEK aléatoire →
 * AES-256-GCM → IPFS. La DEK est renvoyée UNIQUEMENT wrappée (destructible, crypto-shredding).
 */
export async function sealDataset(datasetId: string, content: Buffer): Promise<SealDatasetResult> {
  const tree = buildMerkleTree(content);
  const metrics = computeMetrics(content);
  const dek = generateKey();
  const payload = encrypt(content, dek);
  // Wrap avant l'upload : si la clé enclave manque, on échoue sans pinner un blob orphelin.
  const wrappedKey = wrapKey(dek, datasetKeyContext(datasetId));
  const { cid } = await uploadToIpfs(Buffer.from(JSON.stringify(payload)), `${datasetId}.enc`);
  return { cid, wrappedKey, merkleRoot: tree.root, metrics, sizeBytes: content.length };
}

export async function sealDatasetEnvelope(
  datasetId: string,
  envelope: DatasetIngressEnvelope,
  expectedSizeBytes: number,
  model: ModelSelection,
): Promise<SealDatasetResult> {
  const content = decryptDatasetIngress(datasetId, envelope);
  if (content.length !== expectedSizeBytes) {
    throw new AppError("La taille du fichier ne correspond pas au dépôt", 400);
  }
  // Seul endroit où un motif de validation devient public : celui qui lit la réponse est
  // celui qui vient de déposer le fichier. Le même contrôle pendant un entraînement reste
  // opaque, sinon l'emprunteur apprendrait la forme d'une donnée qu'il n'a pas le droit de
  // voir. Tout ce qui n'est pas imputable au fichier continue de remonter tel quel, et
  // `errorResponse` s'en charge — une erreur technique peut porter un préimage ou un jeton.
  try {
    validateTrainingDataset(content, model);
  } catch (error) {
    if (error instanceof DatasetValidationError) throw new AppError(error.message, 400);
    throw error;
  }
  return sealDataset(datasetId, content);
}

/** Déchiffre un dataset « en enclave » + vérifie l'intégrité Merkle. Le plaintext ne sort jamais. */
async function decryptDataset({ datasetId, cid, wrappedKey, merkleRoot }: DatasetRef, signal?: AbortSignal): Promise<Buffer> {
  const blob = await fetchFromIpfs(cid, signal);
  const payload = JSON.parse(blob.toString()) as EncryptedPayload;
  const plaintext = decrypt(payload, unwrapKey(wrappedKey, datasetKeyContext(datasetId)));
  if (!verifyRoot(plaintext, merkleRoot, DEFAULT_CHUNK_SIZE)) {
    throw new Error(`Intégrité Merkle invalide pour ${datasetId}`);
  }
  return plaintext;
}

/** Même classement que le worker : une exception du calcul pur vient des données. */
function trainOnData(input: TrainingInput, plaintext: Buffer) {
  try {
    return trainSelectedModel(input, plaintext);
  } catch {
    throw new AppError(INVALID_DATASET_MESSAGE, 422);
  }
}

/** Déchiffre → entraîne → output-gate → chiffre le modèle sous `keyContext` → IPFS. */
async function trainAndSeal(input: TrainingInput, signal?: AbortSignal, maxDatasetBytes = MAX_DATASET_BYTES) {
  const plaintext = await decryptDataset(input, signal);
  if (plaintext.length > maxDatasetBytes) throw new AppError("Taille du dataset invalide", 413);
  const model = signal ? await trainInWorker(input, plaintext, signal) : trainOnData(input, plaintext);
  const { model: gated, buffer } = gateModel(model);
  const payload = encrypt(buffer, deriveKey(getMasterKey(), input.keyContext));
  signal?.throwIfAborted();
  const { cid } = await uploadToIpfs(Buffer.from(JSON.stringify(payload)), input.filename, signal);
  return { modelCid: cid, model: gated };
}

/** Entraînement sans attestation (self-train : pas de fair-exchange, propriétaire = borrower). */
export async function runTraining(input: TrainingInput): Promise<{ modelCid: string; metrics: Record<string, number> }> {
  return budgetRunnerJob("training", input.keyContext, input, async () => {
    const { modelCid, model } = await trainAndSeal(input);
    return { modelCid, metrics: model.metrics };
  });
}

/** Self-train : les contextes de livraison sont reconstruits dans le runner. */
export async function runSelfTraining(
  input: SelfTrainingInput,
): Promise<{ modelCid: string; metrics: Record<string, number> }> {
  return runTraining({
    ...input,
    keyContext: selfTrainKeyContext(input.jobId, input.owner),
    filename: `${input.jobId}.model.enc`,
  });
}


// Dérive une clé de livraison (base64). PRIVÉ : jamais exposé avec un contexte libre (= oracle
// universel sur la master key). Les seules clés dérivables de l'extérieur sont les livrables ↓.
function deliveryKey(keyContext: string): string {
  return encodeKey(deriveKey(getMasterKey(), keyContext));
}

/** Clé (base64) du modèle d'un self-train — livrée au propriétaire (contexte reconstruit ici). */
export function selfTrainModelKey(jobId: string, owner: string): string {
  return deliveryKey(selfTrainKeyContext(jobId, owner));
}

/**
 * Verrou d'escrow sur le rail EVM : un préimage de 32 octets et son empreinte SHA-256.
 *
 * Le contrat compare `sha256(preimage)` au hashlock, et `release()` publie le
 * préimage brut.
 */
export function escrowLock(loanId: string, borrower: string): EvmEscrowLock {
  const preimage = deriveKey(getMasterKey(), evmEscrowKeyContext(loanId, borrower));
  return {
    preimage: `0x${preimage.toString("hex")}`,
    hashlock: `0x${createHash("sha256").update(preimage).digest("hex")}`,
  };
}

/** Hashlock seul, pour le `lock()` que le borrower signe — le secret ne sort pas. */
export function escrowHashlock(loanId: string, borrower: string): `0x${string}` {
  return escrowLock(loanId, borrower).hashlock;
}

/**
 * Clé (base64) du modèle d'un emprunt sur le rail EVM, livrée au borrower après
 * règlement. Le contexte est reconstruit ici depuis l'identifiant, jamais fourni par
 * l'appelant — même règle que `loanModelKey` sur le rail historique.
 */
export function evmLoanModelKey(loanId: string, borrower: string, binding?: EvmEscrowBinding): string {
  return deliveryKey(evmModelKeyContext(loanId, borrower, binding));
}

/** Chiffre le modèle d'un emprunt EVM sous une clé liée à la chaîne et au contrat. */
export async function runEvmLoanJob(input: LoanJobInput): Promise<{
  modelCid: string;
  metrics: Record<string, number>;
}> {
  return runTraining({
    ...input,
    keyContext: evmModelKeyContext(input.loanId, input.borrower),
    filename: `${input.loanId}.model.enc`,
  });
}

export async function runBilledEvmLoanJob(input: LoanJobInput, quote: ComputeQuote): Promise<{ modelCid: string; metrics: Record<string, number> }> {
  const ledger = requireBillingBudget();
  const scope = quoteWorkflow(quote);
  const training = { ...input, keyContext: evmModelKeyContext(input.loanId, input.borrower), filename: `${input.loanId}.model.enc` };
  return budgetRunnerJob("training", training.keyContext, training, async () => {
    const startedAt = Date.now();
    const started = performance.now();
    let result: { modelCid: string; metrics: Record<string, number> } | undefined;
    let failure: unknown;
    try {
      const { modelCid, model } = await trainAndSeal(training, AbortSignal.timeout(quote.maxExecutionMs), quote.maxDatasetBytes);
      result = { modelCid, metrics: model.metrics };
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // Une mesure absente après crash ne devient jamais la consommation maximale du devis.
      const elapsedMs = Math.min(quote.maxExecutionMs, Math.max(0, Math.floor(performance.now() - started)));
      ledger.recordExecutionEvidence(scope,
        JSON.stringify({ version: 1, quoteHash: scope.fingerprint, startedAt, elapsedMs, success: Boolean(result) }),
        result ? JSON.stringify(result) : undefined, result ? true : countsAsRunnerFailure(failure));
    }
  });
}

"use client";

import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DocSection, DocsShell, HERO_PRIMARY, HERO_SECONDARY, Hint } from "./DocsShell";
import { EscrowLifecycleDiagram, FairExchangeDiagram, OverviewDiagram } from "./diagrams";

const DOCUMENTATION_EN: Record<string, string> = {
  "propriétaire du dataset": "dataset owner",
  "entraîne un modèle": "trains a model",
  "publie le titre": "publishes the title",
  "verrouille le stablecoin": "locks the stablecoin",
  "modèle chiffré": "encrypted model",
  "release + préimage": "release + preimage",
  "modèle prêt ?": "model ready?",
  "Capsule verrouillée": "Locked capsule",
  "signé par le borrower": "signed by the borrower",
  "État de l’implémentation": "Implementation status",
  "Garanties & limites de sécurité": "Security guarantees & limits",
  "Sirius est un protocole de": "Sirius is a protocol for",
  "data lending confidentiel sur une chaîne EVM": "confidential data lending on an EVM chain",
  "Le provider propose son dataset pour entraîner un modèle ; le borrower reçoit le modèle, pas le CSV source.": "The provider offers a dataset for model training; the borrower receives the model, not the source CSV.",
  "Le règlement est libellé en": "Settlement is denominated in",
  "stablecoin": "a stablecoin",
  "(USDG de Paxos sur mainnet) et vérifiable on-chain.": "(Paxos USDG on mainnet) and verifiable on-chain.",
  "Escrow en stablecoin": "Stablecoin escrow",
  "Les données les plus précieuses sont aussi les plus verrouillées : santé, finance, données personnelles ou secrets métier. Elles ne peuvent pas être partagées en clair sans perdre le contrôle.": "The most valuable data is often the most restricted: health, finance, personal data, or trade secrets. It cannot be shared in plaintext without losing control.",
  "Sirius inverse le flux :": "Sirius reverses the flow:",
  "le modèle vient à la donnée": "the model comes to the data",
  ", avec une isolation matérielle du calcul lorsque le runner utilise un TEE attesté. Le provider conserve sa donnée source.": ", with hardware isolation of computation when the runner uses an attested TEE. The provider keeps their source data.",
  "Le navigateur chiffre le dataset avant son envoi au runner. Celui-ci stocke le dataset chiffré sur IPFS, entraîne le modèle et prépare sa livraison chiffrée. Le règlement EVM publie le préimage nécessaire à l’ouverture de la capsule.": "The browser encrypts the dataset before sending it to the runner. The runner stores the encrypted dataset on IPFS, trains the model, and prepares encrypted delivery. EVM settlement publishes the preimage needed to open the capsule.",
  "Après l’envoi, le runner déchiffre le CSV pour calculer. Seul le mode Phala attesté isole ce calcul matériellement ; le mode stub ne le fait pas.": "After upload, the runner decrypts the CSV to compute. Only attested Phala mode provides hardware isolation for this computation; stub mode does not.",
  "publie un dataset chiffré et reçoit le règlement.": "publishes an encrypted dataset and receives settlement.",
  "choisit un dataset, finance le prêt et récupère le modèle.": "chooses a dataset, funds the loan, and receives the model.",
  "ouvre le dataset, calcule et détient le préimage ; l’attestation matérielle dépend du mode de déploiement.": "opens the dataset, computes, and holds the preimage; hardware attestation depends on the deployment mode.",
  "orchestre le parcours. Avec un runner distant attesté, Next ne reçoit ni CSV en clair ni clés de dataset ; ce n’est pas une garantie du mode stub local.": "orchestrates the flow. With a remote attested runner, Next receives neither plaintext CSV nor dataset keys; local stub mode does not provide this guarantee.",
  "Dataset chiffré": "Encrypted dataset",
  "blob AES-256-GCM sur IPFS.": "AES-256-GCM blob on IPFS.",
  "Titre de dataset": "Dataset title",
  "hash du CID, Merkle root, taille et empreinte du profil d’entraînement inscrits dans": "CID hash, Merkle root, size, and training-profile hash registered in",
  "Attestation KYB": "KYB attestation",
  "credential EIP-712 consenti par le wallet, émis par un vérificateur externe et requis par le registre comme par l’escrow.": "EIP-712 credential consented to by the wallet, issued by an external verifier, and required by both the registry and escrow.",
  "Capsule modèle": "Model capsule",
  "clé de livraison chiffrée pour le navigateur et liée au préimage.": "delivery key encrypted for the browser and tied to the preimage.",
  "Déposer": "Upload",
  "Entraîner": "Train",
  "Le provider choisit le profil d’entraînement, puis le navigateur chiffre le CSV pour le runner. Le runner valide sa compatibilité, calcule le Merkle root et stocke le blob chiffré sur IPFS.": "The provider selects the training profile, then the browser encrypts the CSV for the runner. The runner validates compatibility, computes the Merkle root, and stores the encrypted blob on IPFS.",
  "Publier": "Publish",
  "Le provider inscrit le titre et l’empreinte du profil dans le registre EVM, sous contrôle KYB. Le CSV chiffré reste hors chaîne ; le titre publié fixe le profil utilisable.": "The provider registers the title and profile hash in the EVM registry, subject to KYB. The encrypted CSV stays off-chain; the published title fixes the allowed profile.",
  "Verrouiller": "Lock",
  "Le borrower utilise le profil fixé par le dataset, approuve le stablecoin puis signe lock. L’escrow vérifie le titre, le profil et les KYB, puis fixe le montant, le hashlock et l’échéance.": "The borrower uses the dataset’s fixed profile, approves the stablecoin, and signs lock. Escrow checks the title, profile, and KYB, then fixes the amount, hashlock, and expiry.",
  "Le runner recoupe les KYB, le titre, le profil et les termes de l’escrow avant de déchiffrer et d’entraîner. L’isolation matérielle exige le mode Phala attesté.": "The runner cross-checks KYB, title, profile, and escrow terms before decrypting and training. Hardware isolation requires attested Phala mode.",
  "Régler": "Settle",
  "Une fois la capsule prête, le runner appelle release : le provider est crédité et le préimage est publié. Le navigateur peut ensuite ouvrir le modèle. Le crédit en stablecoin se retire séparément.": "Once the capsule is ready, the runner calls release: the provider is credited and the preimage is published. The browser can then open the model. Stablecoin credit is withdrawn separately.",
  "Implémenté": "Implemented",
  "Hashlock SHA-256, transferts exacts en stablecoin, KYB des deux parties, remboursement et retraits pull-only.": "SHA-256 hashlock, exact stablecoin transfers, KYB for both parties, refunds, and pull-only withdrawals.",
  "Attestations EIP-712, expiration, révocation durable et consentement du wallet ; l’émetteur est externe.": "EIP-712 attestations, expiry, durable revocation, and wallet consent; the issuer is external.",
  "Contrôles croisés": "Cross-checks",
  "L’escrow lie le prêt au titre et au profil ; le runner les recoupe avec les KYB et les termes du prêt avant déchiffrement.": "Escrow binds the loan to the title and profile; the runner cross-checks these with KYB and loan terms before decryption.",
  "Cette distinction est volontaire : la documentation décrit le comportement déployable du code, pas seulement la cible produit.": "This distinction is deliberate: the documentation describes deployable code behavior, not just the product target.",
  "Le problème": "The problem",
  "La solution en un coup d'œil": "The solution at a glance",
  "Les acteurs & artefacts": "Actors & artifacts",
  "Le parcours complet": "The complete flow",
  "Le fair-exchange atomique": "Atomic fair exchange",
  "Cycle de vie de l'escrow": "Escrow lifecycle",
  "Confidentialité : qui voit quoi": "Confidentiality: who sees what",
  "Custody : qui détient quoi": "Custody: who holds what",
  "Les contrats EVM": "EVM contracts",
  "Le runner TEE contrôle le release, pas les deux contreparties. Le borrower possède d’abord une capsule inutilisable ; le préimage qui l’ouvre n’est publié qu’avec le crédit du provider.": "The TEE runner controls release, not either counterparty. The borrower first holds an unusable capsule; its opening preimage is published only when the provider is credited.",
  "`release` est autorisé uniquement avant l’échéance. Après celle-ci, seul `refund` peut créditer le borrower : aucun préimage ne peut alors être publié par l’escrow.": "`release` is allowed only before expiry. After that, only `refund` can credit the borrower: the escrow can no longer publish a preimage.",
  "Scénario": "Scenario",
  "Issue": "Outcome",
  "Calcul réussi": "Successful computation",
  "Une transaction crédite le provider et publie le préimage. Le navigateur déchiffre ensuite la capsule hors chaîne.": "One transaction credits the provider and publishes the preimage. The browser then decrypts the capsule off-chain.",
  "Job invalide ou infructueux": "Invalid or unsuccessful job",
  "Aucun préimage n’est révélé ; le borrower récupère les fonds après échéance.": "No preimage is revealed; the borrower recovers the funds after expiry.",
  "Tentative d'obtenir le modèle sans payer": "Attempt to obtain the model without paying",
  "Impossible : la capsule exige le préimage publié au règlement.": "Impossible: the capsule requires the preimage published at settlement.",
  "Litige subjectif sur la qualité": "Subjective quality dispute",
  "Non tranché par l’escrow seul ; arbitrage à venir.": "Not resolved by escrow alone; arbitration is a future extension.",
  "Le borrower signe le verrouillage depuis son wallet. Un prêt créé est Locked, puis Released ou Refunded : release et refund sont mutuellement exclusifs. Les statuts applicatifs comme TRAINING ne sont pas des états du contrat.": "The borrower signs the lock from their wallet. A created loan is Locked, then Released or Refunded: release and refund are mutually exclusive. Application statuses such as TRAINING are not contract states.",
  "Les crédits sont retirés séparément, par `withdraw` ou `withdrawFor`. Un wallet de provider qui refuse un transfert ne peut pas bloquer la transition du prêt.": "Credits are withdrawn separately with `withdraw` or `withdrawFor`. A provider wallet that rejects a transfer cannot block the loan transition.",
  "Appel": "Call",
  "Qui peut l’appeler": "Who can call it",
  "Effet vérifiable": "Verifiable effect",
  "Le borrower": "The borrower",
  "Crée un prêt en stablecoin lié au titre et au profil d’entraînement, fixe provider, montant, hashlock et échéance de 1 à 30 jours ; les deux KYB doivent être valides.": "Creates a stablecoin loan bound to the title and training profile, fixing the provider, amount, hashlock, and 1-to-30-day expiry; both KYB attestations must be valid.",
  "Toute adresse qui connaît le préimage, avant l’échéance": "Any address knowing the preimage, before expiry",
  "Révèle le préimage et crédite le provider, sans transfert externe dans cette transaction.": "Reveals the preimage and credits the provider, without an external transfer in this transaction.",
  "Toute adresse, après échéance": "Any address, after expiry",
  "Crédite uniquement le borrower ; cet appel ferme définitivement la fenêtre de release.": "Credits only the borrower; this call permanently closes the release window.",
  "Toute adresse": "Any address",
  "Transfère le crédit uniquement au compte désigné, avec protection anti-réentrance.": "Transfers the credit only to the designated account, with reentrancy protection.",
  "Artefact": "Artifact",
  "Donnée brute": "Raw data",
  "oui (la sienne)": "yes (their own)",
  "non": "no",
  "oui, en enclave": "yes, in the enclave",
  "oui": "yes",
  "Clé du dataset (DEK)": "Dataset key (DEK)",
  "Titre et événements EVM": "EVM title and events",
  "Modèle déchiffré": "Decrypted model",
  "oui, pendant le job": "yes, during the job",
  "Les fonds": "Funds",
  "restent dans le wallet ou dans `SiriusEscrow` ; Sirius ne peut pas les déplacer discrétionnairement.": "remain in the wallet or `SiriusEscrow`; Sirius cannot move them at its discretion.",
  "Le titre du dataset": "The dataset title",
  "reste lié au provider. Le hash du CID, le Merkle root, la taille et l’empreinte du profil d’entraînement sont publics.": "remains bound to the provider. The CID hash, Merkle root, size, and training-profile hash are public.",
  "Les clés": "Keys",
  "de dataset restent dans le runner ; la master key est scellée par dstack en mode Phala attesté. En mode stub local, le processus serveur accède aux clés. Le préimage devient public lors du release.": "for datasets remain in the runner; the master key is sealed by dstack in attested Phala mode. In local stub mode, the server process accesses the keys. The preimage becomes public on release.",
  "La suppression": "Deletion",
  "détruit la clé de dataset et laisse un tombstone vérifiable, sans rendre le contenu récupérable.": "destroys the dataset key and leaves a verifiable tombstone without making the content recoverable.",
  "Règlement": "Settlement",
  "Pas d’admin, pas d’upgrade ni de frais. Montants exacts en stablecoin, hashlock SHA-256, KYB des deux parties, échéance stricte et crédits pull-only.": "No admin, upgrade, or fees. Exact stablecoin amounts, SHA-256 hashlock, KYB for both parties, strict expiry, and pull-only credits.",
  "Attestations EIP-712 avec consentement, nonce anti-rejeu, expiration, révocation et époque de vérificateur. L’admin pilote les vérificateurs.": "EIP-712 attestations with consent, anti-replay nonce, expiry, revocation, and verifier epoch. The admin manages verifiers.",
  "Provenance": "Provenance",
  "Titre déterministe, contrôle KYB, hash du CID, Merkle root, taille, profil d’entraînement immuable et tombstone après destruction.": "Deterministic title, KYB checks, CID hash, Merkle root, size, immutable training profile, and tombstone after deletion.",
  "Le profil d’entraînement utilise SiriusEscrow v5 et SiriusDatasetRegistry v4. Un changement de contrats nécessite une migration coordonnée de l’application, de la base et des services ; cette page n’atteste pas la configuration d’une instance.": "The training profile uses SiriusEscrow v5 and SiriusDatasetRegistry v4. Changing contracts requires a coordinated migration of the application, database, and services; this page does not attest to any instance’s configuration.",
  "Ce que la chaîne garantit": "What the chain guarantees",
  "Un prêt ne passe qu’une fois de `Locked` vers `Released` ou `Refunded`.": "A loan transitions only once from `Locked` to `Released` or `Refunded`.",
  "Le provider ne peut être crédité sans que le préimage soit rendu public, et réciproquement.": "The provider cannot be credited without the preimage becoming public, and vice versa.",
  "Le retrait ne peut pas modifier un prêt ni rediriger un crédit vers une autre adresse.": "Withdrawal cannot alter a loan or redirect a credit to another address.",
  "Le registre considère un titre détruit comme inactif et une attestation KYB comme invalide après expiration, révocation ou retrait du vérificateur.": "The registry treats a destroyed title as inactive and a KYB attestation as invalid after expiry, revocation, or verifier removal.",
  "Ce qui reste hors contrat": "What remains outside the contracts",
  "La qualité, la licéité du dataset et la qualité du modèle restent hors de portée des contrats.": "Dataset quality and legality, and model quality, remain outside the scope of the contracts.",
  "Le hash du CID, le Merkle root, la taille et les identifiants de prêt sont publics et permanents : ils ne doivent contenir aucune donnée sensible.": "The CID hash, Merkle root, size, and loan identifiers are public and permanent: they must not contain sensitive data.",
  "L’émetteur KYB, sa clé de signature et l’administration du registre sont des points de gouvernance à protéger hors de Next et du runner.": "The KYB issuer, its signing key, and registry administration are governance points to protect outside Next and the runner.",
  "Une démonstration testnet ne vaut ni audit indépendant, ni validation d’attestation Phala, ni autorisation d’utiliser des données sensibles ou des fonds réels.": "A testnet demo is not an independent audit, Phala attestation validation, or approval to use sensitive data or real funds.",
  "← Retour à l’accueil": "← Back to home",
  "Démo et confidentialité": "Demo and confidentiality",
  "En mode stub (TEE_MODE=stub), il n’y a pas d’enclave matérielle : le processus qui exécute le runner accède au CSV en clair et aux clés. Sans RUNNER_URL, ce processus est celui du serveur Next. Utilisez uniquement des données synthétiques ou non sensibles.": "In stub mode (TEE_MODE=stub), there is no hardware enclave: the process running the runner accesses the plaintext CSV and keys. Without RUNNER_URL, this is the Next server process. Use only synthetic or non-sensitive data.",
  "Les garanties d’isolation décrites ici exigent un runner Phala distant, une attestation RA-TLS vérifiée et des mesures épinglées. Le libellé Production de Vercel ne prouve pas cette attestation.": "The isolation guarantees described here require a remote Phala runner, verified RA-TLS attestation, and pinned measurements. Vercel’s Production label does not prove this attestation.",
  "Un registre KYB ouvert de démonstration accepte toute adresse : il ne vérifie aucune entreprise. Un registre gouverné exige des attestations d’un émetteur externe.": "An open demo KYB registry accepts every address: it does not verify businesses. A governed registry requires attestations from an external issuer.",
  "Profil d’entraînement du dataset": "Dataset training profile",
  "Le profil est obligatoire à l’upload : il fixe l’algorithme et sa version. Le borrower ne peut pas remplacer ce choix par un autre modèle. Le titre on-chain, le prêt et le reçu du runner sont liés à la même empreinte de profil.": "The profile is required at upload: it fixes the algorithm and version. The borrower cannot replace this choice with a different model. The on-chain title, loan, and runner receipt are bound to the same profile hash.",
  "Régression linéaire": "Linear regression",
  "Cible numérique continue. Métriques : R², RMSE et MAE.": "Continuous numeric target. Metrics: R², RMSE, and MAE.",
  "Régression logistique binaire": "Binary logistic regression",
  "Cible strictement encodée en 0 et 1, avec les deux classes présentes. Métriques : accuracy, précision, rappel et F1.": "Target strictly encoded as 0 and 1, with both classes present. Metrics: accuracy, precision, recall, and F1.",
  "Le CSV doit avoir des en-têtes uniques. La dernière colonne numérique sert de cible ; les autres colonnes numériques servent de features, au maximum 31. Il faut au moins 100 lignes et 10 lignes par paramètre, biais inclus.": "The CSV must have unique headers. Its last numeric column is the target; other numeric columns are features, up to 31. At least 100 rows and 10 rows per parameter, including the bias, are required.",
  "Les métriques du modèle livré sont calculées sur les données d’entraînement. Évaluez ensuite un CSV de test séparé dans le navigateur : un score élevé sur l’entraînement ne prouve pas la qualité sur de nouvelles données.": "Delivered model metrics are calculated on the training data. Then evaluate a separate test CSV in the browser: a high training score does not prove performance on new data.",
  "Exemple d’entraînement linéaire": "Linear training example",
  "Exemple d’entraînement logistique": "Logistic training example",
  "Un profil incompatible est refusé avant le verrouillage du stablecoin. Pour changer de profil, réimportez le dataset. L’auto-entraînement sur ses propres données respecte aussi ce profil, sans prêt.": "An incompatible profile is rejected before the stablecoin is locked. To change the profile, upload the dataset again. Self-training on your own data also respects this profile, without a loan.",
  "Préimage avant release": "Preimage before release",
  "Préimage publié au release": "Preimage published on release",
  "Ce tableau décrit le mode Phala distant attesté, sans partage volontaire des artefacts par les participants. Il ne s’applique pas au mode stub local, où le serveur a accès à la donnée brute et aux clés. Le préimage public ne suffit pas à ouvrir la capsule sans la clé du navigateur destinataire.": "This table describes remote attested Phala mode, without participants voluntarily sharing artifacts. It does not apply to local stub mode, where the server has access to raw data and keys. The public preimage alone cannot open the capsule without the recipient browser’s key.",
  "Sur petit écran, faites défiler le schéma horizontalement.": "On smaller screens, scroll the diagram horizontally.",
  "Flux du dataset et du règlement": "Dataset and settlement flow",
  "Le provider envoie le CSV chiffré au runner et publie le titre. Le runner utilise IPFS pour le stockage chiffré et livre le modèle chiffré au borrower. Le borrower verrouille le stablecoin ; le runner publie le préimage au règlement.": "The provider sends the encrypted CSV to the runner and publishes the title. The runner uses IPFS for encrypted storage and delivers the encrypted model to the borrower. The borrower locks the stablecoin; the runner publishes the preimage at settlement.",
  "stub ou TEE attesté": "stub or attested TEE",
  "stockage chiffré": "encrypted storage",
  "DatasetRegistry · KYB · Escrow\nCrédits en stablecoin · retraits séparés": "DatasetRegistry · KYB · Escrow\nStablecoin credits · separate withdrawals",
  "CSV chiffré": "encrypted CSV",
  "lecture": "read",
  "Livraison du modèle et paiement": "Model delivery and payment",
  "Avant échéance, release crédite le provider et publie le préimage dans une seule transaction. Ensuite, le navigateur ouvre la capsule hors chaîne. Sans release avant échéance, refund crédite le borrower.": "Before expiry, release credits the provider and publishes the preimage in one transaction. The browser then opens the capsule off-chain. Without release before expiry, refund credits the borrower.",
  "Calcul du runner": "Runner computation",
  "provider crédité\n+ préimage public\nune transaction EVM": "provider credited\n+ public preimage\none EVM transaction",
  "Capsule ouverte": "Capsule opened",
  "ensuite, dans le navigateur": "then, in the browser",
  "Pas de release": "No release",
  "échec ou délai dépassé": "failure or missed deadline",
  "après échéance\nborrower crédité": "after expiry\nborrower credited",
  "Les crédits en stablecoin se retirent séparément.": "Stablecoin credits are withdrawn separately.",
  "lock crée un prêt Locked. Avant échéance, release le passe à Released ; après échéance, refund le passe à Refunded. Ces deux issues sont exclusives. Le retrait du crédit est séparé.": "lock creates a Locked loan. Before expiry, release moves it to Released; after expiry, refund moves it to Refunded. These outcomes are mutually exclusive. Credit withdrawal is separate.",
  "Stablecoin verrouillé\nprofil + hashlock + délai": "Stablecoin locked\nprofile + hashlock + expiry",
  "release avant échéance\npréimage public\nprovider crédité": "release before expiry\npublic preimage\nprovider credited",
  "refund après échéance\nborrower crédité": "refund after expiry\nborrower credited",
  "Lire la documentation": "Read the docs",
  "Serveur MCP pour les agents IA": "MCP server for AI agents"
};

type Translate = (value: string) => string;

const TOC = [
  { id: "probleme", label: "Le problème" },
  { id: "solution", label: "La solution en un coup d'œil" },
  { id: "acteurs", label: "Les acteurs & artefacts" },
  { id: "profils", label: "Profil d’entraînement du dataset" },
  { id: "parcours", label: "Le parcours complet" },
  { id: "etat", label: "État de l’implémentation" },
  { id: "fair-exchange", label: "Le fair-exchange atomique" },
  { id: "escrow", label: "Cycle de vie de l'escrow" },
  { id: "confidentialite", label: "Confidentialité : qui voit quoi" },
  { id: "custody", label: "Custody : qui détient quoi" },
  { id: "evm", label: "Les contrats EVM" },
  { id: "securite", label: "Garanties & limites de sécurité" },
];

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-center text-xs text-muted">{children}</p>;
}

const strong = "text-foreground";

export default function DocsPage() {
  const { locale, t } = useLocale();
  const d: Translate = (value) => locale === "en" ? DOCUMENTATION_EN[value] ?? value : value;

  return (
    <DocsShell
      title={t("Comment fonctionne Sirius")}
      lead={(
        <p>
          {d("Sirius est un protocole de")} <span className={strong}>{d("data lending confidentiel sur une chaîne EVM")}</span>.{" "}
          {d("Le provider propose son dataset pour entraîner un modèle ; le borrower reçoit le modèle, pas le CSV source.")}{" "}
          {d("Le règlement est libellé en")} <span className={strong}>{d("stablecoin")}</span> {d("(USDG de Paxos sur mainnet) et vérifiable on-chain.")}
        </p>
      )}
      actions={(
        <>
          <a href="#probleme" className={HERO_PRIMARY}>{d("Lire la documentation")}</a>
          <Link href="/docs/mcp" className={HERO_SECONDARY}>{d("Serveur MCP pour les agents IA")}</Link>
        </>
      )}
      toc={TOC}
      tocLabel={(label) => d(t(label))}
    >
      <Hint title={d("Démo et confidentialité")}>
        <p>{d("En mode stub (TEE_MODE=stub), il n’y a pas d’enclave matérielle : le processus qui exécute le runner accède au CSV en clair et aux clés. Sans RUNNER_URL, ce processus est celui du serveur Next. Utilisez uniquement des données synthétiques ou non sensibles.")}</p>
        <p>{d("Les garanties d’isolation décrites ici exigent un runner Phala distant, une attestation RA-TLS vérifiée et des mesures épinglées. Le libellé Production de Vercel ne prouve pas cette attestation.")}</p>
      </Hint>

      <div className="mt-12">
        <DocSection id="probleme" title={d("Le problème")}>
          <p>{d("Les données les plus précieuses sont aussi les plus verrouillées : santé, finance, données personnelles ou secrets métier. Elles ne peuvent pas être partagées en clair sans perdre le contrôle.")}</p>
          <p>{d("Sirius inverse le flux :")} <span className={strong}>{d("le modèle vient à la donnée")}</span>{d(", avec une isolation matérielle du calcul lorsque le runner utilise un TEE attesté. Le provider conserve sa donnée source.")}</p>
        </DocSection>

        <DocSection id="solution" title={d("La solution en un coup d'œil")}>
          <p>{d("Le navigateur chiffre le dataset avant son envoi au runner. Celui-ci stocke le dataset chiffré sur IPFS, entraîne le modèle et prépare sa livraison chiffrée. Le règlement EVM publie le préimage nécessaire à l’ouverture de la capsule.")}</p>
          <OverviewDiagram d={d} />
          <Caption>{d("Après l’envoi, le runner déchiffre le CSV pour calculer. Seul le mode Phala attesté isole ce calcul matériellement ; le mode stub ne le fait pas.")}</Caption>
        </DocSection>

        <DocSection id="acteurs" title={d("Les acteurs & artefacts")}>
          <ul className="ml-5 list-disc space-y-2 marker:text-muted">
            <li><span className={strong}>Provider</span> — {d("publie un dataset chiffré et reçoit le règlement.")}</li>
            <li><span className={strong}>Borrower</span> — {d("choisit un dataset, finance le prêt et récupère le modèle.")}</li>
            <li><span className={strong}>Runner</span> — {d("ouvre le dataset, calcule et détient le préimage ; l’attestation matérielle dépend du mode de déploiement.")}</li>
            <li><span className={strong}>Sirius</span> — {d("orchestre le parcours. Avec un runner distant attesté, Next ne reçoit ni CSV en clair ni clés de dataset ; ce n’est pas une garantie du mode stub local.")}</li>
          </ul>
          <ul className="ml-5 list-disc space-y-2 marker:text-muted">
            <li><span className={strong}>{d("Dataset chiffré")}</span> — {d("blob AES-256-GCM sur IPFS.")}</li>
            <li><span className={strong}>{d("Titre de dataset")}</span> — {d("hash du CID, Merkle root, taille et empreinte du profil d’entraînement inscrits dans")} `SiriusDatasetRegistry`.</li>
            <li><span className={strong}>{d("Attestation KYB")}</span> — {d("credential EIP-712 consenti par le wallet, émis par un vérificateur externe et requis par le registre comme par l’escrow.")}</li>
            <li><span className={strong}>{d("Capsule modèle")}</span> — {d("clé de livraison chiffrée pour le navigateur et liée au préimage.")}</li>
          </ul>
        </DocSection>

        <DocSection id="profils" title={d("Profil d’entraînement du dataset")}>
          <p>{d("Le profil est obligatoire à l’upload : il fixe l’algorithme et sa version. Le borrower ne peut pas remplacer ce choix par un autre modèle. Le titre on-chain, le prêt et le reçu du runner sont liés à la même empreinte de profil.")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              [d("Régression linéaire"), "linear_regression", d("Cible numérique continue. Métriques : R², RMSE et MAE.")],
              [d("Régression logistique binaire"), "logistic_regression", d("Cible strictement encodée en 0 et 1, avec les deux classes présentes. Métriques : accuracy, précision, rappel et F1.")],
            ].map(([name, model, description]) => (
              <div key={model} className="min-w-0 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4 [overflow-wrap:anywhere]">
                <h3 className="font-semibold text-foreground">{name}</h3>
                <p className="mt-1 font-mono text-xs">{model} · v1.0.0</p>
                <p className="mt-2">{description}</p>
              </div>
            ))}
          </div>
          <p>{d("Le CSV doit avoir des en-têtes uniques. La dernière colonne numérique sert de cible ; les autres colonnes numériques servent de features, au maximum 31. Il faut au moins 100 lignes et 10 lignes par paramètre, biais inclus.")}</p>
          <p>{d("Un profil incompatible est refusé avant le verrouillage du stablecoin. Pour changer de profil, réimportez le dataset. L’auto-entraînement sur ses propres données respecte aussi ce profil, sans prêt.")}</p>
          <p>{d("Les métriques du modèle livré sont calculées sur les données d’entraînement. Évaluez ensuite un CSV de test séparé dans le navigateur : un score élevé sur l’entraînement ne prouve pas la qualité sur de nouvelles données.")}</p>
          <ul className="ml-5 list-disc space-y-2">
            <li><a href="/examples/regression/energy-demand-train.csv" download className="text-foreground underline underline-offset-4">{d("Exemple d’entraînement linéaire")}</a></li>
            <li><a href="/examples/classification/credit-default-train.csv" download className="text-foreground underline underline-offset-4">{d("Exemple d’entraînement logistique")}</a></li>
          </ul>
        </DocSection>

        <DocSection id="parcours" title={d("Le parcours complet")}>
          <ol className="space-y-3">
            {[
              ["01", d("Déposer"), d("Le provider choisit le profil d’entraînement, puis le navigateur chiffre le CSV pour le runner. Le runner valide sa compatibilité, calcule le Merkle root et stocke le blob chiffré sur IPFS.")],
              ["02", d("Publier"), d("Le provider inscrit le titre et l’empreinte du profil dans le registre EVM, sous contrôle KYB. Le CSV chiffré reste hors chaîne ; le titre publié fixe le profil utilisable.")],
              ["03", d("Verrouiller"), d("Le borrower utilise le profil fixé par le dataset, approuve le stablecoin puis signe lock. L’escrow vérifie le titre, le profil et les KYB, puis fixe le montant, le hashlock et l’échéance.")],
              ["04", d("Entraîner"), d("Le runner recoupe les KYB, le titre, le profil et les termes de l’escrow avant de déchiffrer et d’entraîner. L’isolation matérielle exige le mode Phala attesté.")],
              ["05", d("Régler"), d("Une fois la capsule prête, le runner appelle release : le provider est crédité et le préimage est publié. Le navigateur peut ensuite ouvrir le modèle. Le crédit en stablecoin se retire séparément.")],
            ].map(([n, title, description]) => (
              <li key={n} className="flex gap-4 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4">
                <span className="shrink-0 font-mono text-sm text-muted">{n}</span>
                <div><div className="font-semibold text-foreground">{title}</div><p className="mt-1">{description}</p></div>
              </li>
            ))}
          </ol>
        </DocSection>

        <DocSection id="etat" title={d("État de l’implémentation")}>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              [d("Escrow en stablecoin"), d("Implémenté"), d("Hashlock SHA-256, transferts exacts en stablecoin, KYB des deux parties, remboursement et retraits pull-only.")],
              ["KYB", d("Implémenté"), d("Attestations EIP-712, expiration, révocation durable et consentement du wallet ; l’émetteur est externe.")],
              [d("Contrôles croisés"), d("Implémenté"), d("L’escrow lie le prêt au titre et au profil ; le runner les recoupe avec les KYB et les termes du prêt avant déchiffrement.")],
            ].map(([name, state, description]) => <div key={name} className="min-w-0 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4 [overflow-wrap:anywhere]"><div className="text-xs font-medium tracking-widest text-muted">{state}</div><div className="mt-1 font-semibold text-foreground">{name}</div><p className="mt-1 text-sm text-muted">{description}</p></div>)}
          </div>
          <p>{d("Cette distinction est volontaire : la documentation décrit le comportement déployable du code, pas seulement la cible produit.")}</p>
        </DocSection>

        <DocSection id="fair-exchange" title={d("Le fair-exchange atomique")}>
          <p>{d("Le runner TEE contrôle le release, pas les deux contreparties. Le borrower possède d’abord une capsule inutilisable ; le préimage qui l’ouvre n’est publié qu’avec le crédit du provider.")}</p>
          <FairExchangeDiagram d={d} />
          <p>{d("`release` est autorisé uniquement avant l’échéance. Après celle-ci, seul `refund` peut créditer le borrower : aucun préimage ne peut alors être publié par l’escrow.")}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Scénario")}</th><th className="py-2 font-medium">{d("Issue")}</th></tr></thead>
              <tbody className="align-top">
                {[
                  [d("Calcul réussi"), d("Une transaction crédite le provider et publie le préimage. Le navigateur déchiffre ensuite la capsule hors chaîne.")],
                  [d("Job invalide ou infructueux"), d("Aucun préimage n’est révélé ; le borrower récupère les fonds après échéance.")],
                  [d("Tentative d'obtenir le modèle sans payer"), d("Impossible : la capsule exige le préimage publié au règlement.")],
                  [d("Litige subjectif sur la qualité"), d("Non tranché par l’escrow seul ; arbitrage à venir.")],
                ].map(([scenario, outcome]) => <tr key={scenario} className="border-b border-border/60"><td className="py-2.5 pr-4 text-foreground">{scenario}</td><td className="py-2.5">{outcome}</td></tr>)}
              </tbody>
            </table>
          </div>
        </DocSection>

        <DocSection id="escrow" title={d("Cycle de vie de l'escrow")}>
          <p>{d("Le borrower signe le verrouillage depuis son wallet. Un prêt créé est Locked, puis Released ou Refunded : release et refund sont mutuellement exclusifs. Les statuts applicatifs comme TRAINING ne sont pas des états du contrat.")}</p>
          <EscrowLifecycleDiagram d={d} />
          <p>{d("Les crédits sont retirés séparément, par `withdraw` ou `withdrawFor`. Un wallet de provider qui refuse un transfert ne peut pas bloquer la transition du prêt.")}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Appel")}</th><th className="py-2 pr-4 font-medium">{d("Qui peut l’appeler")}</th><th className="py-2 font-medium">{d("Effet vérifiable")}</th></tr></thead>
              <tbody className="align-top">
                {[
                  ["lock", d("Le borrower"), d("Crée un prêt en stablecoin lié au titre et au profil d’entraînement, fixe provider, montant, hashlock et échéance de 1 à 30 jours ; les deux KYB doivent être valides.")],
                  ["release", d("Toute adresse qui connaît le préimage, avant l’échéance"), d("Révèle le préimage et crédite le provider, sans transfert externe dans cette transaction.")],
                  ["refund", d("Toute adresse, après échéance"), d("Crédite uniquement le borrower ; cet appel ferme définitivement la fenêtre de release.")],
                  ["withdrawFor", d("Toute adresse"), d("Transfère le crédit uniquement au compte désigné, avec protection anti-réentrance.")],
                ].map(([action, caller, effect]) => <tr key={action} className="border-b border-border/60"><td className="py-2.5 pr-4 font-mono text-foreground">{action}</td><td className="py-2.5 pr-4">{caller}</td><td className="py-2.5">{effect}</td></tr>)}
              </tbody>
            </table>
          </div>
        </DocSection>

        <DocSection id="confidentialite" title={d("Confidentialité : qui voit quoi")}>
          <p>{d("Ce tableau décrit le mode Phala distant attesté, sans partage volontaire des artefacts par les participants. Il ne s’applique pas au mode stub local, où le serveur a accès à la donnée brute et aux clés. Le préimage public ne suffit pas à ouvrir la capsule sans la clé du navigateur destinataire.")}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Artefact")}</th><th className="py-2 pr-4 font-medium">Provider</th><th className="py-2 pr-4 font-medium">Borrower</th><th className="py-2 pr-4 font-medium">Sirius</th><th className="py-2 font-medium">TEE</th></tr></thead>
              <tbody className="align-top">
                {[
                  [d("Donnée brute"), d("oui (la sienne)"), d("non"), d("non"), d("oui, en enclave")],
                  [d("Dataset chiffré"), d("oui"), d("oui"), d("oui"), d("oui")],
                  [d("Clé du dataset (DEK)"), d("non"), d("non"), d("non"), d("oui")],
                  [d("Préimage avant release"), d("non"), d("non"), d("non"), d("oui")],
                  [d("Préimage publié au release"), d("oui"), d("oui"), d("oui"), d("oui")],
                  [d("Titre et événements EVM"), d("oui"), d("oui"), d("oui"), d("oui")],
                  [d("Modèle déchiffré"), d("non"), d("oui"), d("non"), d("oui, pendant le job")],
                ].map((row) => <tr key={row[0]} className="border-b border-border/60"><td className="py-2.5 pr-4 text-foreground">{row[0]}</td>{row.slice(1).map((cell, index) => <td key={`${row[0]}-${index}`} className="py-2.5 pr-4">{cell}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </DocSection>

        <DocSection id="custody" title={d("Custody : qui détient quoi")}>
          <ul className="ml-5 list-disc space-y-2 marker:text-muted">
            <li><span className={strong}>{d("Les fonds")}</span> {d("restent dans le wallet ou dans `SiriusEscrow` ; Sirius ne peut pas les déplacer discrétionnairement.")}</li>
            <li><span className={strong}>{d("Le titre du dataset")}</span> {d("reste lié au provider. Le hash du CID, le Merkle root, la taille et l’empreinte du profil d’entraînement sont publics.")}</li>
            <li><span className={strong}>{d("Les clés")}</span> {d("de dataset restent dans le runner ; la master key est scellée par dstack en mode Phala attesté. En mode stub local, le processus serveur accède aux clés. Le préimage devient public lors du release.")}</li>
            <li><span className={strong}>{d("La suppression")}</span> {d("détruit la clé de dataset et laisse un tombstone vérifiable, sans rendre le contenu récupérable.")}</li>
          </ul>
        </DocSection>

        <DocSection id="evm" title={d("Les contrats EVM")}>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["SiriusEscrow", d("Règlement"), d("Pas d’admin, pas d’upgrade ni de frais. Montants exacts en stablecoin, hashlock SHA-256, KYB des deux parties, échéance stricte et crédits pull-only.")],
              ["SiriusKybRegistry", "KYB", d("Attestations EIP-712 avec consentement, nonce anti-rejeu, expiration, révocation et époque de vérificateur. L’admin pilote les vérificateurs.")],
              ["SiriusDatasetRegistry", d("Provenance"), d("Titre déterministe, contrôle KYB, hash du CID, Merkle root, taille, profil d’entraînement immuable et tombstone après destruction.")],
            ].map(([name, role, description]) => <div key={name} className="min-w-0 rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl p-4 [overflow-wrap:anywhere]"><div className="text-xs font-medium tracking-widest text-muted">{role}</div><div className="mt-1 font-semibold text-foreground">{name}</div><p className="mt-1 text-sm text-muted">{description}</p></div>)}
          </div>
          <p>{d("Le profil d’entraînement utilise SiriusEscrow v5 et SiriusDatasetRegistry v4. Un changement de contrats nécessite une migration coordonnée de l’application, de la base et des services ; cette page n’atteste pas la configuration d’une instance.")}</p>
        </DocSection>

        <DocSection id="securite" title={d("Garanties & limites de sécurité")}>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="font-semibold text-foreground">{d("Ce que la chaîne garantit")}</h3>
              <ul className="mt-3 ml-5 list-disc space-y-2 marker:text-muted">
                <li>{d("Un prêt ne passe qu’une fois de `Locked` vers `Released` ou `Refunded`.")}</li>
                <li>{d("Le provider ne peut être crédité sans que le préimage soit rendu public, et réciproquement.")}</li>
                <li>{d("Le retrait ne peut pas modifier un prêt ni rediriger un crédit vers une autre adresse.")}</li>
                <li>{d("Le registre considère un titre détruit comme inactif et une attestation KYB comme invalide après expiration, révocation ou retrait du vérificateur.")}</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-foreground">{d("Ce qui reste hors contrat")}</h3>
              <ul className="mt-3 ml-5 list-disc space-y-2 marker:text-muted">
                <li>{d("La qualité, la licéité du dataset et la qualité du modèle restent hors de portée des contrats.")}</li>
                <li>{d("Le hash du CID, le Merkle root, la taille et les identifiants de prêt sont publics et permanents : ils ne doivent contenir aucune donnée sensible.")}</li>
                <li>{d("L’émetteur KYB, sa clé de signature et l’administration du registre sont des points de gouvernance à protéger hors de Next et du runner.")}</li>
                <li>{d("Une démonstration testnet ne vaut ni audit indépendant, ni validation d’attestation Phala, ni autorisation d’utiliser des données sensibles ou des fonds réels.")}</li>
              </ul>
            </div>
          </div>
        </DocSection>

        <div className="pt-12">
          <p className="text-xs leading-relaxed text-muted">
            {d("Un registre KYB ouvert de démonstration accepte toute adresse : il ne vérifie aucune entreprise. Un registre gouverné exige des attestations d’un émetteur externe.")}
          </p>
          <p className="mt-6 text-sm">
            <Link href="/" className="text-foreground underline underline-offset-4 hover:text-muted">{d("← Retour à l’accueil")}</Link>
          </p>
        </div>
      </div>
    </DocsShell>
  );
}

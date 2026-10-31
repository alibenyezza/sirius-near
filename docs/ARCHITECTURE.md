# Architecture

État local au 23 septembre 2026. La facturation v7 est intégrée avec activation explicite ; le mode par défaut reste v6. Le [suivi de l'audit](AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026) distingue les correctifs locaux des limites encore bloquantes. Phala reste arrêté, sans bascule distante effectuée.

## Principe

Sirius sépare données, calcul et règlement. Le dataset reste chiffré sur IPFS, le calcul confidentiel cible un TEE Phala et les états économiques sont portés par trois contrats EVM sur Robinhood Chain. Le mode démonstration sans `RUNNER_URL` exécute le runner dans Next : il ne fournit pas l'isolation d'une enclave et reste réservé aux données synthétiques ou non sensibles. La persistance applicative utilise PostgreSQL via Prisma.

Le testnet cible est `46630` ; le mainnet cible est `4663`. Le réseau, le RPC et les adresses sont lus depuis l'environnement par [`src/lib/evm/networks.ts`](../src/lib/evm/networks.ts).

## Contrats

| Contrat | Responsabilité | Propriétés clés |
|---|---|---|
| `SiriusEscrow` v6 | Règlement d'un prêt | Autorisation EIP-712 des conditions du lock par le runner, USDC ERC-20 exact, hashlock SHA-256, KYB des deux parties, liaison obligatoire au registre dataset et au profil d'entraînement, `release` avant l'échéance, états exclusifs et crédit pull-only |
| `SiriusEscrowV7` | Prépaiement dataset + compute | Devis signé, deux bénéficiaires, reçus de consommation plafonnée, échec et remboursement à échéance, crédits pull-only ; intégré localement, non déployé |
| `SiriusKybRegistry` v3 | Conformité KYB | attestations EIP-712, consentement du sujet, expiration, révocation et époque de vérificateur |
| `SiriusDatasetRegistry` v4 | Titre d'un dataset | identité déterministe, KYB bloquant, hash de CID/Merkle root/taille, profil d'entraînement immuable, tombstone de suppression ; ne prouve pas la destruction des copies de clés |

Le titre n'est pas un NFT transférable : il représente la provenance d'un dataset et non un actif de spéculation.

## Parcours de règlement

1. Le provider choisit le profil linéaire ou logistique et chiffre le dataset dans le navigateur pour la clé d'ingestion du runner. Avec un runner distant, Next ne reçoit pas le CSV en clair.
2. Le runner valide le CSV et le budget d’opérations du profil avant de sceller une DEK par dataset, stocke le blob chiffré sur IPFS et signe son reçu.
3. Le provider publie le titre du dataset via `SiriusDatasetRegistry.mint` après validation KYB ; seuls les hash du `datasetId` et du CID entrent dans la transaction.
4. Le runner dérive un préimage de 32 octets, son hashlock et un `loanKey` lié au borrower et au hash du `loanId`.
5. Le borrower et le provider doivent détenir un KYB valide. Le borrower approuve l'escrow puis appelle `SiriusEscrow.lock` avec les USDC, le provider, le hashlock, la durée de challenge, le hash du `loanId`, le titre dataset, son profil d'entraînement et une autorisation EIP-712 du runner, renouvelée après l'approbation USDC.
6. Avant de calculer, le runner vérifie le KYB des deux parties, le titre `matchesScope` du dataset et les termes de l'escrow.
7. Après l'entraînement, le runner atteste un payload canonique liant modèle/version, scope EVM et CID. En v6, il produit aussi une capsule liée à la clé ECDH du navigateur et au préimage ; le borrower la persiste. En v7, il n'envoie aucune capsule avant règlement : Next ne reçoit qu'un engagement de livraison attesté. En Phala, la quote TDX et son evidence sont vérifiées puis persistées.
8. Avant l'échéance, le runner appelle `release(loanKey, preimage)`. Le préimage devient public et le provider est crédité atomiquement ; en v7, la trésorerie compute l'est aussi. La clé du modèle v7 est livrée après vérification du reçu canonique et des confirmations configurées.
9. Si le prêt n'est pas réglé, `refund(loanKey)` devient possible après l'échéance. Next prépare la transaction, le wallet du borrower la signe, puis Next confirme son inclusion. Le borrower retire ensuite son crédit depuis Wallet ou Dashboard avec `withdrawFor(session.address)` ; Next n'utilise aucune clé de règlement pour rembourser.

Le contrat vérifie le delta de solde à chaque transfert USDC et n'accepte donc ni token à frais ni transfert silencieux. Il n'effectue aucun transfert externe pendant `release` ou `refund` : les fonds sont crédités puis retirés séparément.

### Extension de facturation v7

Avant le devis, le runner réserve dans SQLite le budget maximal du calcul et de sa clôture : une exécution, les requêtes bornées et deux transactions maximales. Le devis signé lie réseau, escrow, parties, profil, montants dataset/compute, bénéficiaire Sirius, barème d'échec, limites et expiration. Le borrower approuve et verrouille exactement le total. Les paramètres sont persistés avec le prêt par la migration additive `20260923000000_add_compute_billing`.

Le worker v7 borne l'exécution selon le devis, entre 1 et 30 secondes, avec interruption du worker. Après réussite, `release` crédite le prix dataset au provider et le compute à Sirius. En cas d'échec mesuré, un reçu signé permet de rembourser le dataset et le compute non consommé en ne retenant que les frais engagés plafonnés. Sans reçu enregistré, le remboursement à échéance reste intégral. Les crédits sont retirés séparément.

Le registre conserve atomiquement le résultat public, son contexte de livraison et la mesure d'exécution. Après perte de la réponse Next, le reaper récupère ce résultat par `recover-loan-job`, vérifie son attestation puis peut le régler sans nouveau calcul ni grant du borrower. Une coupure avant ce checkpoint SQLite peut encore laisser une dépense non facturée.

Les transactions signées sont chiffrées dans le journal avant diffusion. Après réconciliation, une transaction sans reçu peut être rediffusée à l'identique : trois envois au total, espacés d'au moins 30 secondes, sans nouveau nonce ni hausse des frais. Une ancienne intention sans transaction chiffrée ou toujours introuvable après ces reprises reste bloquée. Le registre ne constitue pas une comptabilité fournisseur réconciliée. Le navigateur exige le devis v7 et reconstruit les transactions v6. Voir [BILLING-INTEGRATION.md](BILLING-INTEGRATION.md) et [RECOVERY-OPERATIONS.md](RECOVERY-OPERATIONS.md).

## Séparation de domaine

Le préimage est dérivé dans le TEE avec le `chainId`, l'adresse du contrat escrow, le borrower et le `loanId`. Cette liaison empêche qu'un préimage révélé sur un déploiement ou un réseau ouvre une capsule destinée à un autre.

Les attestations KYB strictes v3 utilisent EIP-712 : le domaine version `2` inclut le `chainId` et l’adresse de `SiriusKybRegistry`. Le message inclut `verifierEpoch` en plus du sujet, du vérificateur, de l’expiration et du nonce ; retirer puis réactiver un vérificateur ne réactive aucune ancienne signature inutilisée.

L'authentification HTTP utilise un domaine canonique propre au déploiement. La branche résout ce domaine et ses alias dans `scripts/deployment-target.mjs` ; la pipeline les synchronise avant de construire Next. Les alias autorisés partagent le domaine signé du runner, mais pas leurs cookies ni leur IndexedDB. Le navigateur vérifie la clé d'ingestion contre `NEXT_PUBLIC_SIRIUS_APP_ORIGIN`, figée au build, et contre son empreinte épinglée. Les origines de staging et main restent disjointes. Voir [DEPLOYMENT.md](DEPLOYMENT.md).

## Frontières de confiance

- Le navigateur chiffre le dataset avant transit et conserve la clé privée ECDH non exportable de livraison.
- Le runner Phala est le seul détenteur de la master key dstack ; il ouvre le dataset, entraîne le modèle, génère le préimage et signe les reçus.
- Next orchestre, persiste l'état applicatif et vérifie les attestations, mais ne reçoit ni la donnée brute ni les secrets de règlement.
- `RUNNER_TRANSPORT_SECRET` authentifie le canal Next→runner. Pour préparer un lock, Next fait autorité sur le prêt et sa visibilité en base ; le runner vérifie le reçu provider, le titre et les conditions avant de signer.
- Le login et le runner acceptent les comptes EOA ; les comptes contractuels sont refusés explicitement. Le wallet autorise une délégation par signature EIP-191 ; les grants P-256 de cette délégation sont scopés, expirables et contrôlés par un registre anti-rejeu. Le nettoyage préserve une réservation encore vide ; la concurrence a été validée entre huit processus partageant le même stockage local. Cela ne valide pas une coordination entre plusieurs CVM.
- Restaurer un wallet et une session sur `/` ne déclenche aucune redirection : l'accueil garde le blob ; le dashboard s'ouvre par navigation explicite.
- Le RPC de règlement reçoit le préimage lors de la simulation et de l'envoi avant inclusion : il doit être de confiance. La suppression des erreurs brutes dans les logs ne protège pas contre un RPC hostile.

La réussite atomique de `release` ne garantit pas que le préimage reste secret si une transaction échoue ou est incluse trop tard. En v7, aucune capsule n'est remise avant règlement et la clé est livrée après contrôle du reçu canonique et de la politique `SIRIUS_EVM_FINALITY`. Le mode `finalized` est celui par défaut en production et obligatoire sur mainnet ; son indisponibilité bloque la livraison. La sémantique du RPC cible et les scénarios de réorganisation du rollup restent à valider.

Les états des pages privées et des soldes sont recréés selon une révision de connexion et l’authentification. Le login contrôle cette révision et le provider après chaque attente ; les écritures du cookie de connexion/déconnexion sont sérialisées. Entraîner charge ses listes par pages de 24, sans charger tout le catalogue en mémoire.

## Reprise et historique

Chaque nouveau prêt conserve `evmChainId`, `evmEscrowAddress` et `evmPreparedBlock`. Les lectures historiques sont limitées aux escrows explicitement autorisés du même réseau. Les crédits et les preuves d’attestation utilisent eux aussi les déploiements historiques autorisés ; une panne de lecture d’un ancien crédit n’empêche pas d’afficher les autres. Les décimales du crédit sont lues sur le token de chaque escrow. Un reçu HMAC v2 peut relivrer une clé après règlement, mais ne peut pas autoriser un nouvel entraînement ou règlement.

Le reaper parcourt les prêts par lots avec un curseur stable. L'absence de hash en base ne suffit pas pour annuler : il vérifie l'escrow et récupère les transactions déjà minées. Un mauvais hash peut être remplacé sur preuve d'un vrai `lock` du même borrower et du même prêt. Les transitions concurrentes sont protégées par comparaison de l'état lu, et une panne RPC ne crée pas de confirmation locale.

La pipeline exécute un préflight avant la migration des profils, y compris pour les prêts annulés sans preuve de remboursement. Une transaction connue encore en attente bloque la migration. Le schéma PostgreSQL supporté est `public`.

Les admissions concurrentes ont été vérifiées sur PostgreSQL 17 entre huit processus, avec reprise bornée des conflits de sérialisation et deadlocks. Une sauvegarde cohérente chiffrée de la base réelle PostgreSQL 18 a été restaurée et migrée localement sans altérer les valeurs historiques. Les 13 blobs de modèles sont sauvegardés ; leur déchiffrement et leur re-livraison restent à prouver. Voir [OPERATIONS-PREPARATION.md](OPERATIONS-PREPARATION.md).

La suppression d'un dataset conserve sa fiche d'audit (`DELETED`). `deletionReconciledAt` enregistre la fin du parcours applicatif, même si le titre est déjà détruit ou absent du registre courant et qu'aucune nouvelle transaction n'est nécessaire. `evmDestroyTxHash` reste réservé à une transaction réellement confirmée ; constater l'absence d'un titre dans le nouveau registre ne prouve pas sa destruction dans un ancien registre. Les suppressions non finalisées restent accessibles au provider. Un brouillon sans titre peut être supprimé sans RPC ; un ancien dataset sans profil valide doit être réimporté et ne peut pas être publié tel quel.

La copie Prisma de `wrappedKey` est supprimée ; le résultat de scellement n'est plus conservé dans le registre budgétaire, et l'ouverture du registre purge les anciennes copies actives. Les sauvegardes et anciennes copies du WAL ne sont pas effacées par ce code. `keyDestroyedAt` ne prouve donc pas un effacement cryptographique de toutes les copies (S-08).

La migration additive `20260906000000_reconcile_dataset_deletion` doit être appliquée avant de déployer ce code. Elle ne supprime aucune donnée et ne requiert aucun redéploiement des contrats.

## Langue de l'interface

Le site est en anglais, y compris les profils d'entraînement, confirmations, info-bulles et erreurs affichées. `LocaleProvider` utilise `src/lib/i18n/english.ts` ; les erreurs de l'API sont traduites à l'affichage via `errors-en.ts`, sans changer les messages utilisés par la logique métier. Les noms et colonnes fournis par l'utilisateur restent inchangés. La documentation publique garde son dictionnaire anglais dédié.

`pnpm test` contrôle les clés de traduction statiques, les paramètres et les erreurs dynamiques. Les tests navigateur vérifient aussi qu'un ancien choix de langue française ne réactive pas le français.

## Organisation du code

```text
contracts/
  src/                    # SiriusEscrow, SiriusKybRegistry, SiriusDatasetRegistry
  test/                   # invariants et scénarios hostiles
  scripts/                # compile, export ABI, déploiement et smoke
src/
  lib/evm/                # réseau, adresses, montants, signatures, client et escrow
  lib/billing/            # devis, politiques tarifaires, exécution bornée et règlement v7
  lib/runner/             # autorisations, livraison et registre SQLite de budgets
  lib/tee/                # cœur sans DB, liaison EVM, chiffrement et attestation
  runner/                 # opérations confidentielles et règlement du runner
  lib/sirius/             # orchestration applicative et persistance
```

## État de migration

La migration applicative est EVM-only. La validation sur testnet avec des wallets réels et une CVM Phala reste requise. Voir [ROADMAP.md](ROADMAP.md).

## Sécurité et production

- En mode strict, l'émetteur KYB signe hors de Next et du runner, idéalement depuis un HSM/KMS. La démonstration testnet possède un chemin de parrainage distinct, dont la clé ne doit pas être réutilisée en production réelle.
- Les contrats sont testés localement, mais ne sont pas déclarés prêts mainnet sans déploiement testnet, revue externe et parcours réel complet.
- Le runner Phala doit être déployé avec RA-TLS, quote TDX, replay RTMR3 et valeurs d'attestation épinglées côté Next.
- Les adresses de contrat, le réseau attendu et le RPC sont des paramètres de déploiement : aucune valeur vide ne doit atteindre une instance de production.

La migration v6 demeure une [référence historique](ESCROW-V6.md). La prochaine bascule suit v7 après correction des bloqueurs, validation des tarifs, de la comptabilité et des plafonds fournisseurs. Elle exige des contrats cohérents, la clôture des anciens prêts, la préservation des modèles et les préflights adaptés. Aucun changement d'adresse ne migre les prêts actifs. Voir [PHALA.md](PHALA.md).

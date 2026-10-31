# Escrow v7 — contrat local de facturation

Le contrat, les tests Hardhat et l’ABI v7 sont complétés par l’[intégration locale du devis jusqu’au remboursement](BILLING-INTEGRATION.md). Next, runner, reaper, migration Prisma et interface prennent en charge v7 avec activation explicite ; le mode par défaut reste v6. Aucun tarif réel ni déploiement public v7, aucune migration distante ; Phala reste arrêté. Les [budgets durables](RUNNER-BUDGETS.md) réservent désormais le parcours avant émission du devis.

**État au 23 septembre 2026 : activation toujours bloquée.** Le [suivi de l'audit](AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026) et la [reprise](RECOVERY-OPERATIONS.md) décrivent la récupération des résultats durables après perte de la réponse Next, les rediffusions identiques bornées, le devis obligatoire et la livraison différée. Restent la coupure avant checkpoint runner, les transactions toujours introuvables après les reprises autorisées, la finalité/RPC cible, les anciennes copies de clés et la validation économique. Les invariants contractuels ci-dessous ne valent pas validation de l’ensemble du parcours.

## Conditions du prêt

Le constructeur reçoit le token, le KYB, le registre dataset et l’adresse du signataire runner. Aucun propriétaire, proxy, retrait administratif ni permission de débit de la trésorerie n’est ajouté. Le registre dataset doit utiliser le même KYB et être lié à ce nouvel escrow avant tout lock.

`lock(terms, authorization)` bloque exactement `datasetAmount + computeAmount`. Les deux prix sont strictement positifs et leur somme ne dépasse pas `uint96.max`. Le plancher total de 0,001 token dépend des décimales du token ; il s’agit d’une limite technique, pas du tarif minimum commercial. Les précisions 6 et 18 sont testées avec de vrais transferts locaux.

`LockTerms`, dans l’ordre ABI :

| Champ | Type | Engagement |
|---|---|---|
| `provider` | `address` | Bénéficiaire dataset, KYB valide |
| `computeRecipient` | `address` | Bénéficiaire compute, distinct du provider, du borrower, de zéro et du contrat |
| `datasetAmount` | `uint256` | Prix dataset atomique |
| `computeAmount` | `uint256` | Prix compute atomique fixé à la réussite |
| `maxFailureFee` | `uint256` | Plafond de retenue en échec, entre zéro et `computeAmount` |
| `hashlock` | `bytes32` | SHA-256 du préimage de livraison |
| `challengeDays` | `uint8` | Durée de 1 à 30 jours |
| `loanIdHash` | `bytes32` | Identifiant unique dans l’espace du borrower |
| `datasetId` | `bytes32` | Titre vivant du provider |
| `trainingProfile` | `bytes32` | Profil exact du titre |
| `quoteHash` | `bytes32` | Empreinte non nulle du devis complet, dont tarif, plafonds d’exécution et identité runner |

Le manifeste canonique correspondant à `quoteHash` est défini dans `src/lib/billing/quote.ts` et vérifié côté Next et runner. Le navigateur vérifie indépendamment la version de l'escrow, exige le devis signé en v7 et reconstruit les transactions proposées au wallet. Le contrat lie l’empreinte du devis mais n’en interprète pas le contenu ; ses contrôles ne protègent pas une approbation ou une autre transaction wallet envoyée ailleurs. Les prix, bénéficiaires et le plafond de retenue sont contrôlés directement lors du lock ; les caractéristiques du dataset et le barème doivent être vérifiés dans le TEE.

```text
termsHash = keccak256(abi.encode(borrower, terms))
LockAuthorization(bytes32 termsHash,uint40 deadline)
domaine EIP-712 : SiriusEscrow / 7 / chainId / adresse escrow
```

Le permis expire strictement avant sa `deadline`, avec au plus cinq minutes restantes lors du lock. Le contrat refuse les signatures non canoniques, les autres signataires et les anciens domaines v6. Une même clé de prêt ne peut pas être réutilisée après clôture. `termsHashOf` expose le calcul canonique ; `matchesScope(loanKey, expectedTermsHash, minimumRemaining)` vérifie toutes les conditions via cette empreinte et la fenêtre restante. Le runner la reconstruit depuis le devis signé, jamais simplement depuis celle retournée par `getLoan`.

## Consommation et issues

Un reçu d’exécution est signé par le même autorisateur sous le domaine v7 :

```text
ExecutionReceipt(bytes32 loanKey,bytes32 termsHash,uint256 consumedCompute,bytes32 evidenceHash,uint40 observedAt,bool finalFailure)
```

`consumedCompute` est un montant cumulatif de frais justifiés, en unités atomiques du token, plafonné au montant accepté pour l’échec. Une valeur supérieure au plafond est refusée. Le runner doit calculer la retenue à partir des coûts réellement engagés et la borner avant signature. Aucun bénéfice commercial ou provision non consommée ne doit entrer dans ce montant.

`evidenceHash` engage un justificatif d’exécution authentifié et conservé durablement ; il ne doit pas exposer de donnée brute ni de secret. L’EVM vérifie la signature et les bornes, pas la réalité physique du calcul ou la facture Phala. Le runner conserve désormais durablement une mesure de durée active et signe le reçu final ; voir [le barème et ses limites](BILLING-INTEGRATION.md#devis-et-consommation). Sa calibration fournisseur reste requise.

| Opération | Conditions | Résultat |
|---|---|---|
| `recordExecution`, `finalFailure=false` | Avant échéance, frais strictement croissants, preuve non nulle, horodatage depuis le lock, non futur et non décroissant | Conserve le dernier montant cumulatif ; aucun crédit immédiat |
| `release` | Avant échéance, préimage SHA-256 valide | Publie le préimage, crédite le prix dataset au provider et le prix compute complet à Sirius |
| `recordExecution`, `finalFailure=true` | Avant échéance, reçu valide, frais au moins égaux au dernier reçu | Clôture en échec, rembourse dataset + compute moins les frais attestés, crédite ces frais à Sirius |
| `refund` | Dès l’échéance, sans signature du runner | Rembourse dataset + compute moins le dernier montant attesté enregistré sur la chaîne |

Un reçu final à zéro permet une annulation intégrale anticipée s’il n’existe aucune consommation enregistrée. Une réussite ne rajoute pas les checkpoints au prix compute : le total crédité reste exactement celui bloqué. L’échec et le remboursement ne publient aucun préimage.

Cette dernière propriété concerne les appels de remboursement : elle ne protège pas un préimage déjà divulgué par une tentative de `release`. Le RPC reçoit sa calldata avant confirmation ; une inclusion tardive peut rejeter le règlement tout en laissant le préimage observable. Le parcours v7 ne fournit pas de capsule avant règlement et ne livre la clé qu'après reçu canonique et confirmations configurées ; leur profondeur ne garantit pas une finalité irréversible. Voir S-02 et son [suivi](AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026).

**Panne sans reçu publié : remboursement intégral à échéance.** Une signature présente seulement dans le runner ou en base ne réduit pas ce remboursement. Aucun reçu, même signé plus tôt, ne peut être enregistré à partir de l’échéance. Les coûts non prouvés doivent donc rester couverts dans le budget de risque de Sirius. L’intégration actuelle réserve deux maxima de transaction et refuse un calcul trop proche de l’échéance. Elle émet uniquement des reçus finaux d’échec, sans checkpoints intermédiaires ; les coûts non prouvés restent à la charge de Sirius et leur couverture dépend des bornes et de la marge justifiées dans la politique du registre.

Après le checkpoint SQLite du runner, le reaper peut récupérer un résultat v7 perdu par Next via `recover-loan-job`, vérifier son attestation puis appeler `settle-loan` sans nouveau grant du borrower. Le test EVM local couvre cette reprise sans recalcul ni nouvel upload. Une coupure avant ce checkpoint peut encore laisser une dépense non facturée. Ce checkpoint local est distinct des reçus non finaux on-chain, que le contrat accepte mais que le runner ne publie pas actuellement. Aucun frais futur ou simple réservation ne doit être transformé en consommation facturable.

Les checkpoints ne doivent attester que des frais déjà engagés. Ne pas signer à l’avance une consommation future pour contourner le risque de panne. Le runner ne doit pas émettre des résolutions contradictoires : le premier règlement valide inclus clôture définitivement le prêt.

## Conservation des fonds et reprises

- États : `None=0`, `Locked=1`, `Released=2`, `Refunded=3`, `Failed=4`. Toutes les issues terminales refusent un deuxième règlement et un nouveau lock avec la même clé.
- À toute clôture, le total bloqué devient exactement le total dû. Les remboursements et les revenus sont des crédits pull-only ; aucune sortie vers une adresse arbitraire d’un appelant.
- `withdrawFor(account)` envoie uniquement à `account`. L’état et le crédit sont restaurés si le token refuse, prélève des frais ou débite un montant excessif. Le garde de réentrance couvre les mutations.
- Les transferts contrôlent à la fois le débit émetteur et le crédit destinataire. Les retours ERC-20 vides sont acceptés. Un token malveillant qui falsifierait ses propres soldes reste hors de cette garantie ; le choix du token demeure une condition de déploiement.
- Pour un token exact, le solde du contrat couvre `lockedUsdc + owedUsdc`. Un don direct augmente le surplus et n’accorde aucun droit de retrait supplémentaire.
- Les montants cumulés ne s’additionnent pas entre checkpoints. Un reçu identique ou antérieur ne consomme rien de plus ; après clôture, la reprise doit relire l’état au lieu de renvoyer une transaction payante.
- Le séquenceur d’événements avance une fois par lock, checkpoint ou résolution. Un `ExecutionRecorded` final et son `LoanFailed` partagent la même séquence.
- Le compteur de prêts actifs protège la suppression du dataset et est décrémenté exactement une fois. La révocation KYB ne bloque pas les remboursements ou retraits existants.

La conservation des USDC dans ce contrat ne protège pas à elle seule le wallet gas ni le budget des fournisseurs cloud. Les réservations atomiques, plafonds de tentatives, contrôle de nonce, séparation des wallets et coupe-circuits restent des prérequis applicatifs distincts.

Après perte de confirmation RPC, le runner réconcilie le hash durable avant le prochain envoi, indépendamment du statut métier du prêt. Il vérifie le reçu canonique, la portée et la politique de finalité. Le journal chiffré autorise trois envois identiques au total, espacés d'au moins 30 secondes, sans nouveau nonce ni hausse des frais. Une ancienne intention sans transaction chiffrée ou toujours introuvable après ces reprises reste bloquée pour examen opérateur. Voir les [budgets durables](RUNNER-BUDGETS.md#règlement-et-wallet-gas).

## Validation et suite

Validation locale du 23 septembre après correctifs : **79 tests Hardhat réussis**, dont **32 tests v7**, compilation Solidity, export ABI, lint applicatif et typages application/v7 réussis. Les tests de [escrow-v7.test.ts](../contracts/test/escrow-v7.test.ts) couvrent les deux précisions du token, les signatures et domaines falsifiés, les sommes exactes, plafonds nuls ou maximaux, KYB, expiration, reçus cumulatifs, pannes, rejouements, isolation de plusieurs prêts, frais cachés et réentrance. Le test supplémentaire v6 borne la durée de l'autorisation de lock. La validation complémentaire du runner sur EVM locale et du client wallet simulé est décrite dans [BILLING-INTEGRATION.md](BILLING-INTEGRATION.md). Aucun déploiement public n’a été effectué.

La dernière passe valide **304 tests applicatifs et 13 tests des outils d'exploitation**. Les passes précédentes ont aussi validé 62 tests navigateur, le parcours EVM local et les admissions PostgreSQL 17 entre huit processus. La sauvegarde réelle a été restaurée et migrée sur PostgreSQL 18 local. Ces vérifications ne prouvent pas la reprise après toute panne, la finalité du rollup, l'effacement des anciennes copies de clés ou l'exploitation Phala. Tarifs, comptabilité réconciliée et plafonds fournisseurs restent à valider ; voir [OPERATIONS-PREPARATION.md](OPERATIONS-PREPARATION.md).

```bash
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
pnpm exec tsc -p contracts/tsconfig.v7.json --noEmit
pnpm lint
pnpm exec tsc --noEmit
```

Le typage dédié v7 inclut ses tests, leurs helpers et l’export ABI. Le typage global historique `tsc -p contracts/tsconfig.json` reste en échec dans les anciennes suites (ABI `unknown` et types d’assertions Chai) ; le typage applicatif ne couvre pas ces fichiers. Le nouveau test utilise l’ABI exportée typée et les assertions Node pour ne pas ajouter ces erreurs.

L’ABI v7 est exportée dans `src/lib/evm/abi/siriusescrowv7.ts`. L’ABI et le contrat v6 sont conservés pour le parcours courant et les historiques. Les signatures de lock, de portée, les retours et les événements diffèrent. L’intégration locale sélectionne la bonne ABI et conserve les prêts historiques. Après correction et validation des bloqueurs de l’audit, préparer la migration et les paramètres nécessaires au premier déploiement public v7 ; aucune migration ni opération distante n’est effectuée ici. Phala reste arrêté pendant ce travail local.

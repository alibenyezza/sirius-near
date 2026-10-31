# Correctifs F1–F4 et passage à Escrow v6

État local sur staging au 13 septembre 2026. Aucun contrat ni environnement distant n'a été modifié pendant cette correction. Les observations initiales sont conservées dans [l'audit du 12 septembre](AUDIT-STAGING-2026-09-12.md).

**Priorité de reprise du 23 septembre :** avant un nouveau déploiement pour Phala, valider les risques restants de la [facturation du compute au borrower](COMPUTE-BILLING.md). Le [contrat v7 et ses tests](ESCROW-V7.md), ainsi que le [parcours applicatif signé](BILLING-INTEGRATION.md), sont intégrés localement ; le [suivi de l'audit](AUDIT-2026-09-23.md#suivi-des-correctifs-locaux--23-septembre-2026) distingue les correctifs des limites bloquantes. Ce document conserve les garanties et procédures v6 comme référence historique : il ne déclenche pas un redéploiement v6 intermédiaire. Lire [PHALA.md](PHALA.md) pour l’état actuel et la contrainte de crédits.

## Front et authentification

- **F1** : la découverte EIP-6963 notifie les changements de provider ; le connecteur détache les anciens listeners, s'abonne au wallet choisi et ignore les retours obsolètes. Une annonce tardive est prise en compte. Un changement de compte est appliqué avant l'attente réseau pour ne pas être perdu si `chainChanged` arrive immédiatement après.
- **F2** : le contenu datasets est recréé à chaque changement d'adresse, de réseau ou d'authentification. Les requêtes sont annulées au démontage et lorsqu'une lecture plus récente les remplace, pagination comprise. L'ancien compte ne conserve ni cartes ni curseur dans le nouveau contexte.
- **F3** : le login et le runner exigent désormais la même preuve EOA. Un compte contractuel n'obtient plus une session ensuite inutilisable ; le refus explique la limite. **Le support complet des smart accounts n'a pas été ajouté.** Aucune vérification ERC-1271 distante n'a été introduite dans le runner.

## F4 — Autorisation obligatoire du lock

`SiriusEscrow` passe de **v5 à v6**. Son constructeur reçoit une quatrième adresse, `lockAuthorizer`, immuable et non nulle. Elle doit correspondre au compte de règlement dérivé par le runner depuis sa master key. Seule son adresse publique est copiée dans `SIRIUS_LOCK_AUTHORIZER` pour le déploiement.

`lock` reçoit un huitième argument `{ deadline, signature }`. La signature EIP-712 porte sur le hash des conditions exactes : borrower, provider, montant atomique, hashlock, durée de challenge, hash du prêt, titre dataset et profil d'entraînement. Le domaine contient `SiriusEscrow`, la version `6`, le `chainId` et l'adresse du contrat. L'expiration est également signée ; le code local refuse désormais une autorisation valable plus de cinq minutes au moment du lock. Ce changement Solidity exige un nouveau déploiement et ne modifie pas l'escrow déjà déployé. Les signatures malformées, les valeurs `s` non canoniques et les mauvais signataires sont refusés. La clé unique du prêt empêche une deuxième consommation, même après règlement ou remboursement.

Le runner ne reçoit pas un hashlock libre à signer : il le dérive lui-même. L'opération `prepare-escrow-lock` exige une capability Next liée au dataset, au prêt et au borrower. Elle vérifie le reçu provider et le titre on-chain, puis signe les conditions du reçu. Elle ne renvoie que le hashlock et l'autorisation, jamais le préimage.

**Frontière de confiance :** Next vérifie l'existence du prêt, sa propriété, les quotas et la visibilité du dataset. Le runner vérifie les conditions attestées du provider et le titre, mais n'accède pas à la base. Next et son canal de capability sont donc une autorité sur l'admission des prêts ; les contrôles de confidentialité et de règlement du runner restent distincts.

Après confirmation de l'approbation USDC, le navigateur appelle `POST /api/loans/:id/authorize`. Le serveur refuse un autre borrower, un prêt déjà soumis, un changement de déploiement, un titre indisponible ou un hashlock différent. L'autorisation est renouvelée pour au maximum cinq minutes, sans dépasser **création du prêt + neuf minutes**. Le reaper peut libérer un prêt PENDING à dix minutes : le renouvellement ne prolonge pas sa réservation. Une préparation trop ancienne est refusée avant l'envoi du lock ; l'approbation USDC demeure valable.

Les anciens sélecteurs `lock` v4/v5 restent décodables uniquement pour l'historique. Le contrat v6 ne propose aucun chemin de lock sans autorisation. `release`, `refund`, les crédits et la dérivation des clés historiques conservent leur fonctionnement.

Le worker reaper peut démarrer sur le couple Escrow v5 / DatasetRegistry v4 existant et continuer ses réconciliations pendant la transition. Il vérifie les versions et les liaisons réciproques avec un contrôle distinct de celui des nouveaux prêts, qui restent réservés à v6. Le contrôle de lecture du worker ne valide pas le cache des nouvelles préparations.

## Déploiement et migration staging

Le passage du runner in-process à Phala exige un nouvel escrow v6 même si le contrat courant est déjà en v6 : sa nouvelle master key produit un autre `lockAuthorizer`. Le registre dataset associé doit également être redéployé. Dans ce cas, ne pas transférer l’ancienne master key dans la CVM ; la conservation de clé évoquée ci-dessous concerne les changements de contrats sous une même identité runner. Suivre [PHALA.md](PHALA.md) pour l’amorçage sans contrats, la réimportation et la préservation séparée des modèles historiques.

Un merge de code ne transforme pas les contrats existants. Le contrat escrow est immuable et le registre dataset ne peut lier qu'un escrow, une seule fois : **un nouvel escrow v6 et un nouveau registre v4 associé sont nécessaires**. Le script de déploiement crée aussi un registre KYB. Le correctif A8 du 13 septembre fait passer le registre strict à **v3**, avec un domaine EIP-712 version **2** et le champ signé `uint64 verifierEpoch`. Prévoir de nouvelles attestations si le mode KYB gouverné est utilisé ; une signature de l’ancien registre est inutilisable sur le nouveau. Le registre ouvert de démonstration reste distinct et ne fournit pas ces garanties. Le token USDC peut rester le même.

Procédure pour l'opérateur, dans une fenêtre de maintenance :

1. Sauvegarder la base et conserver la master key. Bloquer les nouvelles préparations et attendre la fin des transactions wallet en cours. Le nouveau code refuse la préparation de prêts sur v5 via son contrôle de version ; il peut encore terminer les prêts du contrat courant v5 tant que ses anciennes adresses restent configurées.
2. Régler ou rembourser les anciens prêts avant de changer le contrat courant du runner. Une lecture historique ou une livraison de modèle déjà réglé ne permet pas de continuer automatiquement l'entraînement ou le règlement d'un ancien prêt actif sur v6.
3. Récupérer l'adresse publique de règlement annoncée au démarrage du runner et la passer comme `SIRIUS_LOCK_AUTHORIZER` au script de déploiement. Ne pas exporter sa clé privée. Pour un runner local de démonstration, garder exactement la même master key entre instances ; un changement de signataire sera refusé par le contrat.
4. Compiler et tester, puis déployer sur **testnet** après validation de la cible et des paramètres. Le script vérifie le signataire déployé et lie le nouveau registre avec le compte du déployeur, autorisé uniquement pour cette liaison unique. Il ne réutilise ni ne remplace un ancien contrat.
5. Dans l'environnement de contrôle, charger les nouvelles adresses serveur et publiques, le réseau, la base de staging et `SIRIUS_LEGACY_ESCROW_ADDRESSES` contenant tous les escrows précédents. Appliquer les migrations Prisma nécessaires, puis exécuter `pnpm contracts:check-upgrade` avant la bascule finale.
6. Ce préflight **indépendant des migrations Prisma déjà appliquées** vérifie v6 et les liaisons, le réseau RPC, la déclaration des historiques, l'absence de prêts applicatifs ouverts sur les anciens déploiements et l'absence de fonds encore verrouillés dans chacun des anciens escrows déclarés. Un prêt portant une trace EVM mais dépourvu de réseau ou d'adresse d'escrow doit être réconcilié, même marqué `CANCELLED` ou `SETTLED` : les anciennes migrations ne remplissent pas ces colonnes rétroactivement. Le préflight ne modifie ni base ni chaîne. Une panne ou un doute bloque sa validation.
7. Configurer les mêmes adresses dans Next, le worker et le runner. Garder les anciens escrows autorisés et la master key pour la livraison des modèles historiques. Avec Phala, reconstruire et réattester l'image/compose ; le compte public doit rester celui attendu par v6.
8. Réimporter et publier les datasets utilisés pour les nouveaux prêts dans le nouveau registre, avec de nouveaux titres applicatifs. Les titres et identifiants de l'ancien registre ne sont pas migrés automatiquement. Une ancienne migration Prisma déjà appliquée ne suspend pas une deuxième fois les anciennes fiches ; retirer celles-ci du catalogue avant la réouverture.
9. Avec le registre strict, vérifier `VERSION = sirius-kyb-v3` et produire les nouveaux consentements pour les deux wallets. Le parrainage navigateur renvoie le domaine complet et refuse un ancien registre strict ; le script `contracts:attest-kyb` lit directement le digest on-chain.
10. Vérifier un prêt complet avec deux wallets EOA : login, approve, renouvellement de l'autorisation, lock, entraînement, release, livraison et retrait du crédit provider. Après un remboursement, vérifier aussi le retrait borrower depuis Wallet. Vérifier également la suppression sans prêt actif et la livraison d'un modèle historique déjà réglé, puis rouvrir les emprunts.

Le préflight est une observation à un instant donné : il ne peut pas prédire une transaction diffusée ensuite sur un ancien contrat immuable. Maintenir la maintenance jusqu'à la fin de la bascule. La pipeline existante ne déploie pas automatiquement les contrats et son préflight de migration des profils ne remplace pas `contracts:check-upgrade`.

```bash
pnpm contracts:compile
pnpm contracts:test
pnpm contracts:abi
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
```

Le préflight ci-dessous lit la base et le RPC de l'environnement **déjà chargé** ; il ne choisit pas staging depuis le lien Vercel local et ne charge pas implicitement `.env.local` :

```bash
pnpm contracts:check-upgrade
```

`contracts:smoke` reste un smoke de primitives sur un **escrow testnet dédié dont le déployeur est l'autorisateur**. Il refuse l'escrow du vrai runner avant toute approbation. Le parcours applicatif ci-dessus valide l'escrow du runner sans jamais exporter sa clé pour fabriquer un préimage ou une autorisation de test.

## Vérifications locales

- 196 tests applicatifs : admission EOA, signature du runner, reçu altéré, titre détruit, mauvais signataire, expiration et renouvellement borné, préflight v6 et ordre approve → autorisation fraîche → lock.
- 53 tests Chromium : restauration d'accueil, refus de signature, changement de provider, annonce tardive, compte/réseau simultanés et réponses datasets obsolètes, dont pagination.
- 44 tests Hardhat : lifecycle USDC existant, lock non autorisé sans blocage de suppression, substitution des termes/domaines/borrower, expiration et rejeu.
- Le typage applicatif, le lint et le build sont vérifiés séparément. Le `tsc -p contracts/tsconfig.json` supplémentaire expose des problèmes de typage du harness Hardhat (`unknown` pour les lectures d'artefacts, augmentation Chai manquante), également dans les fichiers KYB/dataset non modifiés ; il n'est pas déclaré passant. La compilation Solidity et les tests Hardhat passent.

Aucun smoke distant, changement de variable Vercel, déploiement Solidity ou commande Git n'a été exécuté pour ces correctifs.

Les constats A1–A9, les tests supplémentaires et les mises à jour de dépendances sont suivis dans [les correctifs du 13 septembre](AUDIT-CORRECTIFS-2026-09-13.md). Les chiffres ci-dessus décrivent la passe F1–F4, pas la suite étendue.

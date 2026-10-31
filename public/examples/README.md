# Jeux de données d'exemple

État au 23 septembre 2026 : ces jeux servent à la recette locale ou de démonstration. Le [parcours de facturation v7](../../docs/BILLING-INTEGRATION.md) est intégré localement, mais les [bloqueurs de l’audit](../../docs/AUDIT-2026-09-23.md) restent ouverts ; Phala est arrêté. Les données publiques et synthétiques ne valident ni la confidentialité d’un usage réel ni un tarif fournisseur.

Jeux prêts à déposer dans Sirius pour exécuter un prêt complet sans préparer de
données. Ils sont rangés par famille de modèle :

```text
examples/
├── regression/
│   ├── housing-prices-*.csv
│   ├── energy-demand-*.csv
│   └── bike-sharing-demand-*.csv
├── classification/
│   └── credit-default-*.csv
└── benchmarks/
```

Chaque paire contient un fichier `-train.csv` à déposer et un fichier `-test.csv`
à conserver localement pour évaluer le modèle livré.

Sur staging, utiliser `sirius-evm-staging.vercel.app`. `sirius-evm.vercel.app`
est un alias de main, indépendamment de la branche ouverte dans l'éditeur.
Les jeux de test sont réutilisables ; les comptes, datasets publiés et clés restent
propres à chaque environnement. Voir [le guide des branches](../../docs/DEPLOYMENT.md).

## Régression linéaire

### `regression/housing-prices-train.csv` et `regression/housing-prices-test.csv`

Régression tabulaire synthétique : prédire `price_eur` depuis `surface_m2`,
`rooms`, `age_years`, `distance_km` et `energy_score`. Les 140 lignes sont
séparées de façon déterministe en 112 lignes d'entraînement et 28 de test.

### `regression/energy-demand-train.csv` et `regression/energy-demand-test.csv`

Régression synthétique de demande d'énergie horaire. La cible `energy_mwh`
dépend de la météo, du solaire, du calendrier et des pics de consommation. Les
7 008 premières lignes entraînent le modèle ; les 1 752 dernières l'évaluent.

Pour régénérer les jeux synthétiques et leurs séparations :

```bash
pnpm datasets:generate
```

La commande recrée aussi les fixtures nécessaires à `pnpm test`. La pipeline la
lance avant les tests : un fichier `energy-demand*.csv` absent de `regression/`
ne doit pas être compensé par une modification du modèle ou de ses métriques.

### `regression/bike-sharing-demand-train.csv` et `regression/bike-sharing-demand-test.csv`

Régression réelle sur les locations de vélos horaires (`cnt`) depuis des mesures
météo et calendaires. La source UCI est téléchargée puis séparée
chronologiquement à 80/20. Les colonnes qui révèlent la cible sont retirées.

```bash
pnpm datasets:fetch
```

Source : Fanaee-T, H. (2013), *Bike Sharing*, UCI Machine Learning Repository,
https://doi.org/10.24432/C5W894. Licence CC BY 4.0.

## Régression logistique binaire

### `classification/credit-default-train.csv` et `classification/credit-default-test.csv`

Classification synthétique de défaut de crédit. Entraîne avec **Régression
logistique binaire**, puis évalue avec le fichier de test : la cible `defaulted`
est strictement encodée en `0` ou `1`. Les variables numériques sont le revenu,
le ratio d'endettement, le score de crédit, les incidents de paiement,
l'utilisation du crédit et l'ancienneté professionnelle.

Le jeu contient 480 lignes d'entraînement et 120 lignes de test. Il combine des
profils qui se chevauchent et une part d'aléa : les métriques restent bonnes sans
être parfaites, comme dans un cas de scoring réaliste.

## Évaluer un modèle livré

Les métriques d'entraînement sont informatives : elles portent sur les lignes
utilisées pour ajuster le modèle. Après livraison, ouvre **Évaluer sur un CSV de
test** et choisis le fichier `-test.csv` correspondant. Ce fichier reste dans le
navigateur.

- Régression linéaire : R², RMSE, MAE et valeur prédite.
- Régression logistique : accuracy, precision, recall, F1, classe et probabilité.

## Benchmarks réalistes

Quatre paires plus volumineuses couvrent la revente automobile, la demande
retail, la livraison du dernier kilomètre et le rendement industriel. Elles sont
dans [`benchmarks/`](benchmarks/README.md) et se régénèrent avec :

```bash
pnpm datasets:benchmarks
```

## Contraintes CSV

- Un fichier CSV de 3 Mio maximum, une ligne d'en-tête, au moins 100 lignes et entre 2 et 32 colonnes numériques.
- La cible est la dernière colonne numérique ; les autres colonnes numériques
  servent de variables explicatives.
- Pour la régression logistique, la cible doit contenir les deux classes et être
  strictement écrite `0` ou `1`.
- Les colonnes non numériques sont ignorées.

Le navigateur chiffre le fichier avant son envoi. Avec un runner Phala distant et
attesté, Next.js ne reçoit pas les données brutes. En démonstration sans
`RUNNER_URL`, le runner s'exécute dans Next et y déchiffre le CSV : utiliser des
données synthétiques ou non sensibles. Le borrower ne reçoit que le modèle livré.

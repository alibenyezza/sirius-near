# Realistic regression benchmarks

Status — 23 September 2026: these fixtures remain synthetic local benchmarks. The [v7 billing flow](../../../docs/BILLING-INTEGRATION.md) is integrated locally, but the [audit findings](../../../docs/AUDIT-2026-09-23.md) remain open and Phala is stopped. Benchmark scores and local execution times do not establish commercial prices, supplier costs or production readiness.

These datasets are synthetic and deterministic, but they are designed around the
failure modes of operational data rather than around a target score. They contain
categorical variables ignored by the MVP, nonlinear effects, interactions,
heteroscedastic noise, censored outcomes, outliers and chronological distribution
shift. No feature is derived from the target or from a post-outcome measurement.

Upload only each `-train.csv` file. Keep its matching `-test.csv` local, then use
Sirius' **Evaluate on a test CSV** after the model is delivered. Every split is
chronological: the test period is later than the training period.

| Dataset | Train / test rows | Target | What it exercises |
|---|---:|---|---|
| `vehicle-resale` | 6,000 / 1,500 | `resale_price_eur` | Depreciation curves, unobserved trims, accident effects and market-rate shifts. |
| `retail-demand` | 10,080 / 2,520 | `units_sold` | Promotions, stock-out censoring, seasonality, local events and price elasticity. |
| `last-mile-delivery` | 9,600 / 2,400 | `actual_duration_min` | Traffic interactions, rare incidents, queueing, weather and a late construction shift. |
| `industrial-yield` | 15,600 / 3,900 | `yield_pct` | 31 numeric features (the MVP maximum), correlated sensors, nonlinear process windows, faults and supplier drift. |

These benchmarks target the linear-regression baseline. A lower held-out R² is a
valid result here: it means that the available linear features do not explain
part of the real-world signal. Treat it as a model limitation to investigate,
not as a dataset defect.

Regenerate all four datasets with:

```bash
pnpm datasets:benchmarks
```

Use `sirius-evm-staging.vercel.app` for staging. The `sirius-evm.vercel.app`
alias belongs to main, regardless of the branch open in your editor. Uploaded
datasets and delivered models belong to their deployment; switching branches
does not move them. See the [deployment guide](../../../docs/DEPLOYMENT.md).

These files are safe synthetic inputs for the local demo runner, which decrypts
inside the Next process when `RUNNER_URL` is unset. Confidential production data
requires a separately validated Phala runner. Regenerating these benchmarks is
separate from `pnpm datasets:generate`, which prepares the smaller test fixtures.

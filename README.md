# Sirius on NEAR

**Confidential datasets you can own, sell and earn from.** A data provider publishes an encrypted dataset; buyers pay
for a training run inside a TEE and only ever receive the trained model. On NEAR, each dataset becomes an **NFT that
owns a wallet**: the NFT is tied to a keyless vault account that collects every payment for that dataset. Sell the
NFT and the vault, its balance and the right to withdraw move with it.

Built at NEAR HACKATHON (Nov 2026). Tracks: **NFTs That Do Something** (`nfts`), **Privacy & Private AI**
(`privacy`), **Agent Economy** (`agents`).

## The problem

A dataset that earns money is an asset, but today its income is tied to the person who uploaded it. You cannot sell
"this dataset and everything it will earn" without trusting a platform to redirect payments. And buyers have to trust
that the provider's data was checked for personal information before it was published.

## What is on NEAR (and what is not)

| Part | Where | Status |
|---|---|---|
| Dataset NFT (NEP-171, NEP-177, NEP-178, NEP-181, NEP-199) | `near/contracts/market` | live on testnet |
| One vault per NFT: `ds-<id>.<market>`, **no access key**, immutable global code (NEP-591, by hash) | `near/contracts/vault` | live on testnet |
| Training escrow in NEAR: pay, delivery by a registered TEE runner (90 % to the vault, 10 % to the treasury), refund after the deadline | `near/contracts/market` | live on testnet |
| Withdraw by the current holder only, lock during withdrawal, approvals revoked on withdrawal | `near/contracts/market` | live on testnet |
| History per NFT: earnings, withdrawals, holders | `get_history`, `get_holders` | live on testnet |
| Training inside an Intel TDX enclave (Phala) | base project, `src/runner` | pre-hackathon, **not NEAR**; the testnet demo uses a simulated runner (declared below) |

The full threat model for the sale (every way a seller could try to keep the money) is in
[`near/THREAT-MODEL.md`](near/THREAT-MODEL.md).

## Live on testnet

| What | Account or id |
|---|---|
| Market contract | [`sirius-ali-market.testnet`](https://testnet.nearblocks.io/address/sirius-ali-market.testnet) |
| Vault code (global, by hash) | `4NdNArHpcvARoBb1Fi7hp8dCKtVQGJNvoTFGrUN5YkBu` (sha256 `321d6034…6afc` of `sirius_vault.wasm`), published in tx `4TVkc5V747qb6vvUSqyeDXVJ2RVK5qYMp797UzsuqRNm` |
| Demo NFT and its vault | token `3`, vault [`ds-3.sirius-ali-market.testnet`](https://testnet.nearblocks.io/address/ds-3.sirius-ali-market.testnet) |

The demo journey on token `3` (`near/scripts/demo-testnet.sh`), every step a real testnet transaction:

| Step | Signer | Result | Transaction |
|---|---|---|---|
| Alice publishes the fictional dataset: vault created, NFT minted | alice | `true` | `Ay9bf1ZoTHx1GsHbWdCSYWo35B8BCkbqA6fD2iEgV4YK` |
| Carol pays a training run (0.5 NEAR) | carol | order `4` | `GY7BwChZ9FEKKd7mB7LP5FRyLgBs5yptAMGa6MTawa11` |
| The runner delivers: 0.45 NEAR to the vault, 0.05 to the treasury | runner | | `HnCKTKzVdZfPbcGWf6QzDHiAM8Kbeha8MtxpbZuECQCk` |
| Alice withdraws the vault | alice | 0.45802 NEAR | `7KErLn346Zzv283s8uxw7FuxJtGQbFbqUfjSKX5ozGEF` |
| Carol pays a second run | carol | order `5` | `DhwGcc7GNBS626R6MrKatjxmitzQKbnW87HviSV8suEC` |
| Alice sells the NFT to Bob **before** the delivery | alice | | `DF87pT2PSCNVZk7Q35nQPzrFGfaNmdJegHPMqZvc5byK` |
| The runner delivers after the sale: the money lands in the vault | runner | | `5wsB1rqrXZHupXoZrDwWkCCCqDkTtq2kks6vcjoV6cMg` |
| Alice tries to withdraw again | alice | refused: `Only the current holder can withdraw` | (failed, no outcome) |
| Alice calls the vault directly | alice | refused: `Only the parent market can pay out` | (failed, no outcome) |
| Bob withdraws | bob | 0.45 NEAR | `4nXkfsBiH3h55L793Bz9n1mJwwSjrAMJFQ7JWDMvwZAn` |

Accounts: `sirius-ali-{owner,alice,bob,carol,runner}.testnet`, created with the near-cli faucet.

## Try it

You need Rust, [`cargo-near`](https://github.com/near/cargo-near) and [`near-cli-rs`](https://github.com/near/near-cli-rs).

1. **Run the contract tests.** `cd near/contracts && cargo test`. You see 27 market tests and 6 vault tests pass,
   including `sale_in_the_middle_of_a_payout_pays_the_buyer`, `cannot_sell_while_withdrawal_in_flight` and
   `publish_creates_a_keyless_vault_on_global_code`.
2. **Read the live NFT.** `near contract call-function as-read-only sirius-ali-market.testnet get_history json-args '{"token_id":"3"}' network-config testnet now`.
   You see `Published`, `Earned`, `Withdrawn` (Alice), `Transferred` (Alice to Bob), `Earned`, `Withdrawn` (Bob).
3. **Check that the vault has no key.** `near account list-keys ds-3.sirius-ali-market.testnet network-config testnet now`.
   You see an empty table.
4. **Check who the vault obeys.** `near contract call-function as-read-only ds-3.sirius-ali-market.testnet get_parent json-args '{}' network-config testnet now`.
   You see `"sirius-ali-market.testnet"`.
5. **Replay the whole journey on your own accounts.** Create six testnet accounts, deploy (see
   [`near/DEPLOY.md`](near/DEPLOY.md)), then `MARKET=... OWNER=... ALICE=... BOB=... CAROL=... RUNNER=... bash near/scripts/demo-testnet.sh`.
   You see each step above, with your own transaction ids in `near/scripts/demo-testnet.log`.

## What is simulated

- **The training runner in the testnet demo.** The demo runner is a plain testnet account registered with the label
  `simulated-local-runner`; it delivers hashes computed by the script, not a model trained in an enclave. The real
  runner (Intel TDX on Phala) exists in the base project and is not yet wired to NEAR.
- **The TDX attestation check is off-chain.** The contract checks that the caller is a registered, non-revoked
  runner. The owner checks the quote before registering it and stores its hash on-chain (`get_runner`).
- **The dataset is fictional.** `near/examples/hospital-stays-fictional.csv` is generated; every name, e-mail and phone
  number in it is invented.

## Pre-hackathon code (disclosure)

This repository starts from a copy of Sirius, a confidential data marketplace built before the hackathon on EVM
(Robinhood Chain), with its training runner on Phala. That copy is the first commit, tagged
[`pre-hackathon`](../../tree/pre-hackathon); its README is kept in [`docs/EVM-BASE.md`](docs/EVM-BASE.md). Internal
operations notes of the private original were left out of the copy.

**Everything judged is the NEAR integration, built during the hackathon:**
[`pre-hackathon...main`](../../compare/pre-hackathon...main). The EVM contracts, the Next.js app and the Phala runner
are baseline.

Non-NEAR integrations in the base project: Robinhood Chain (EVM), Phala Cloud (Intel TDX), IPFS (Pinata).

## Libraries and AI help

- Contracts: `near-sdk` 5.30.0, `near-contract-standards` 5.30.0 (NEP-171 core, approvals, enumeration, metadata).
  Built with `cargo-near` 0.22.0, deployed with `near-cli-rs` 0.30.1.
- Code written with the help of an AI coding agent (Claude Code), reviewed and run by the author. Every testnet
  transaction listed here was sent and checked.

## Other project by the same author

Ali also submits **Warband** ([github.com/alibenyezza/warband-near](https://github.com/alibenyezza/warband-near)), an
independent project. The two share no code.

## License

MIT, see [`LICENSE`](LICENSE).

# Sirius on NEAR

**Confidential datasets you can own, sell and earn from.** A data provider publishes an encrypted dataset; buyers pay
for a training run and only ever receive the trained model. On NEAR, each dataset becomes an **NFT that owns a
wallet**: the NFT is tied to a keyless vault account that collects every payment for that dataset. Sell the NFT and
the vault, its balance and the right to withdraw move with it. Before publishing, the dataset is audited for personal
data by a **private model of NEAR AI Cloud whose TEE we verify ourselves**. Agents can buy training runs **from a
budget a human gave them**, with a key that cannot do anything else.

Built at NEAR HACKATHON (Nov 2026). Tracks: **NFTs That Do Something** (`nfts`), **Privacy & Private AI**
(`privacy`), **Agent Economy** (`agents`).

![NFT page: vault, earnings, holders, history](near/docs/nft-page.png)

## The problem

- A dataset that earns money is an asset, but its income is tied to whoever uploaded it. You cannot sell "this dataset
  and everything it will earn" without trusting a platform to redirect payments.
- Buyers have to trust that a provider checked the data for personal information, and providers cannot send their
  data to an AI auditor without exposing it.
- An AI agent that buys data or compute either holds a key that can drain its wallet, or cannot pay at all.

## How Sirius on NEAR answers it

| Track | What it does | Where |
|---|---|---|
| `nfts` | Dataset NFT (NEP-171/177/178/181/199). Each one has a vault account `ds-<id>.<market>` with **no access key**, running immutable global code (NEP-591, by hash), that obeys the market only; the market pays only the current holder. Withdrawals lock the token, revoke listings, and every sale is in the NFT's history. | `near/contracts`, [`near/THREAT-MODEL.md`](near/THREAT-MODEL.md) |
| `privacy` | Privacy audit of a dataset sample on a private TEE model of NEAR AI Cloud. Before anything is sent, a fresh nonce attestation is verified **here**: Intel TDX quote signed by Intel (dcap-qvl), signing key and nonce bound in the TDX report data, compose manifest measured in MRCONFIGID, NVIDIA GPU tokens verified with NVIDIA's keys and the same nonce. The reply's ECDSA signature must come from the attested key. The audit hash goes into the NFT. Nothing is stored. | `near/agent/lib/nearai.mjs`, `near/agent/privacy-audit.mjs`, `/verified` page |
| `agents` | A human funds an agent's budget in the market (`fund_agent`). The agent pays training runs with a **function-call key** limited to `order_with_budget` on the market: it cannot attach deposits, send NEAR or call anything else, and the contract refuses any price above the agent's offer, the per-order limit or what is left. Exposed as an MCP server; every purchase returns a receipt. | `near/contracts`, `near/agent/mcp-server.mjs` |

## Live on testnet

| What | Account or id |
|---|---|
| Market contract | [`sirius-ali-market.testnet`](https://testnet.nearblocks.io/address/sirius-ali-market.testnet) |
| Vault code (global, by hash) | `4NdNArHpcvARoBb1Fi7hp8dCKtVQGJNvoTFGrUN5YkBu` (sha256 `321d6034…6afc` of `sirius_vault.wasm`), published in tx `4TVkc5V747qb6vvUSqyeDXVJ2RVK5qYMp797UzsuqRNm` |
| Demo NFT and its vault | token `4`, vault [`ds-4.sirius-ali-market.testnet`](https://testnet.nearblocks.io/address/ds-4.sirius-ali-market.testnet) |
| Agent | [`agent.sirius-ali-carol.testnet`](https://testnet.nearblocks.io/address/agent.sirius-ali-carol.testnet): one function-call key only (`order_with_budget` on the market, 0.25 NEAR gas allowance), funded by Carol |
| Runner | `sirius-ali-runner.testnet`, delivers with a key limited to `deliver` |

The full journey on token `4` (`near/scripts/demo-testnet.sh`), every step a real testnet transaction:

| Step | Signer | Result | Transaction |
|---|---|---|---|
| Alice publishes the fictional dataset: vault created, NFT minted | alice | `true` | `4RQuMqaMA3vrMKiWkq3kZg5B1793XSVQBuzoLeSXcRWE` |
| NEAR AI Cloud attestation with a fresh nonce | (off-chain) | `VERIFIED: every check passed` | |
| Carol pays a training run (0.5 NEAR) | carol | order `6` | `F4UJwW5vFJnrNzgDTBKtL2K2nPrBWTkCiAARTGUae7nR` |
| The runner bridge trains (R² 0.840) and delivers: 0.45 NEAR to the vault, 0.05 to the treasury | runner (deliver-only key) | | `q1wR9f34s6rduin1nR9JXKEiaEwiAWzjkCUyDdwMdUC` |
| Alice withdraws the vault | alice | 0.45802 NEAR | `8mBec4wPrAJUHvouhuGj5s8yKMwS4hpvwRn3EQ9jaXRr` |
| The agent offers 0.25 NEAR over MCP | agent | refused: `Price above the agent's offer`, nothing spent | |
| The agent offers 0.6 NEAR, pays 0.5 from its budget | agent (function-call key) | order `7`, receipt | `3oJQRJLK2EcqQbhtz7kkVBYSbs3YDUnooz65ivmdCkUS` |
| Alice sells the NFT to Bob **before** order 7 is delivered | alice | | `FpNv8bzmxue9wugYLcHBdF67zWKiNvdrGtXYKQJZkZqS` |
| The runner delivers order 7 after the sale: the money lands in the vault | runner | | `HZwZyFhGA2tXXkZ2opcmV73knU15BaasKtsuHvR3hYjq` |
| Alice tries to withdraw again | alice | refused: `Only the current holder can withdraw` | (failed) |
| Alice calls the vault directly | alice | refused: `Only the parent market can pay out` | (failed) |
| Bob withdraws | bob | 0.45 NEAR | `2oTRctx1iDcsxX4xbdEkHo98WLDQqKwK9xZ8MBqGn923` |
| The holder page with real NEP-413 signatures (`near/scripts/holder-gate-check.sh`) | bob, then alice | Bob in; replay refused; Alice `does not hold NFT 4` | (off-chain) |

## Try it

Requirements: Node 22, and for the contracts Rust with [`cargo-near`](https://github.com/near/cargo-near) and
[`near-cli-rs`](https://github.com/near/near-cli-rs).

1. **See the TEE proof.** `cd near/agent && npm ci && node privacy-audit.mjs --attest-only`. You see about 20 to 40
   `PASS` lines (Intel TDX, NVIDIA GPUs, key and nonce binding, for the model and the gateway) and
   `VERIFIED: every check passed`. No API key is needed for this step.
2. **Open the pages.** `node web.mjs`, then <http://localhost:4320>. You see the dataset NFTs read live from testnet.
   Open `/dataset/4`: the vault, its live balance, Alice → Bob in the holders, the history above. Open `/verified`:
   a new attestation with a new nonce on every load.
3. **Try the holder page.** Open `/holder/4` and sign with a NEAR testnet wallet. Unless you are
   `sirius-ali-bob.testnet`, you see `Refused · <your account> does not hold NFT 4`.
4. **Run the tests.** `npm test` in `near/agent` (21 tests, some read testnet live) and `cargo test` in
   `near/contracts` (36 market tests, 6 vault tests). Look for `sale_in_the_middle_of_a_payout_pays_the_buyer`,
   `cannot_sell_while_withdrawal_in_flight`, `withdrawal_revokes_listing`, `agent_walks_away_above_its_offer`,
   `live: a replayed report (other nonce) fails the binding checks`.
5. **Use it from an agent.** Add the MCP server to any MCP client:
   `{"mcpServers":{"sirius-near":{"command":"node","args":["near/agent/mcp-server.mjs"]}}}`. Tools: `search_datasets`,
   `get_dataset`, `verify_private_ai`, `get_budget`, `buy_training_run`, `get_receipt`. Read-only tools work as is;
   `buy_training_run` needs an agent account with a budget (see `near/agent/.env.example`).
6. **Run the privacy audit itself.** Put a NEAR AI Cloud key in `near/agent/.env` (`NEARAI_CLOUD_API_KEY=`, from
   <https://cloud.near.ai>), then `node --env-file=.env privacy-audit.mjs ../examples/hospital-stays-fictional.csv --token 4 --holder <holder>`.
   You see the attestation, the signed-reply checks, the columns flagged as personal data, and the `near` command that
   records the audit hash in the NFT.
7. **Replay the whole journey on your own accounts.** Deploy as in [`near/DEPLOY.md`](near/DEPLOY.md), fill
   `near/agent/.env`, then `MARKET=... OWNER=... ALICE=... BOB=... CAROL=... RUNNER=... bash near/scripts/demo-testnet.sh`.

## What is real and what is simulated

| Real | Simulated or not done yet |
|---|---|
| Every contract call above, on testnet | **The TEE of the training runner.** The runner bridge trains here, with the same least-squares method as the base project, and its certificate says `"mode": "local-simulated", "tee": null`. The TDX runner of the base project (Phala) is not wired to NEAR yet. |
| The NEAR AI Cloud attestation checks (Intel, NVIDIA, bindings), run on every call | **The audit completion.** It needs a NEAR AI Cloud API key, which was not set when this README was written: no audit hash is recorded on token `4` yet, and none is invented. The code path is tested up to the API call. |
| The model trained by the bridge and its hash | **The runner's TDX quote on-chain.** `register_runner` stores the hash of a quote checked off-chain; the contract does not verify quotes. |
| The NEP-413 holder gate, with near-cli signatures | The dataset is fictional (`near/examples/hospital-stays-fictional.csv`): every name, e-mail and phone is invented. |

Known limits are listed at the end of [`near/THREAT-MODEL.md`](near/THREAT-MODEL.md).

## Pre-hackathon code (disclosure)

This repository starts from a copy of Sirius, a confidential data marketplace built before the hackathon on EVM
(Robinhood Chain), with its training runner on Phala. That copy is the first commit, tagged
[`pre-hackathon`](../../tree/pre-hackathon); its README is kept in [`docs/EVM-BASE.md`](docs/EVM-BASE.md). Internal
operations notes of the private original were left out of the copy.

**Everything judged is under `near/`, built during the hackathon:**
[`pre-hackathon...main`](../../compare/pre-hackathon...main). The EVM contracts, the Next.js app (`src/`) and the
Phala runner are baseline. The NEAR pages are a small standalone server (`near/agent/web.mjs`) rather than routes of
the base Next.js app, because that app needs PostgreSQL, Prisma and an EVM wallet to start; they reuse its branding.

Non-NEAR services used by the NEAR part: NEAR AI Cloud's attestation relies on Intel (PCCS collateral via dcap-qvl)
and NVIDIA NRAS. The base project also uses Robinhood Chain, Phala Cloud and IPFS (Pinata).

## Libraries and AI help

- Contracts: `near-sdk` 5.30.0, `near-contract-standards` 5.30.0. Built with `cargo-near` 0.22.0, deployed with
  `near-cli-rs` 0.30.1.
- Agent, web and verification: `near-api-js` 7.4.0, `@modelcontextprotocol/sdk` 1.32.2, `@phala/dcap-qvl` 0.7.0
  (Intel quote verification), `jose` 6 (NVIDIA tokens), `viem` 2 (ECDSA recovery), `zod` 4; `@hot-labs/near-connect`
  0.12.0 in the browser. The verification flow follows `near-examples/nearai-cloud-verification-example` and the
  `near-ai-cloud` agent skill.
- Code written with the help of an AI coding agent (Claude Code), reviewed and run by the author. Every testnet
  transaction listed here was sent and checked.

## Other project by the same author

Ali also submits **Warband** ([github.com/alibenyezza/warband-near](https://github.com/alibenyezza/warband-near)), an
independent project. The two share no code.

## License

MIT, see [`LICENSE`](LICENSE).

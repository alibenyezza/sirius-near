# Threat model: selling a dataset NFT

Each Sirius dataset is an NEP-171 token on the `market` contract. Each token is tied to a vault account
`ds-<id>.<market>` that collects the dataset's earnings. Whoever holds the token can withdraw from the vault, set the
training price and open the holder-only page. When the token is sold, the vault, its balance and these rights move
with it.

The question this file answers: **how could a seller try to keep the money or the access after selling, and what
stops them?**

## Actors

| Actor | Can do |
|---|---|
| Holder (seller before the sale) | `withdraw`, `set_price`, `nft_transfer`, `nft_transfer_call`, `nft_approve` |
| Buyer | buys through a marketplace (approval + `nft_transfer`) or a direct transfer |
| Marketplace | holds an approval and calls `nft_transfer` / `nft_transfer_payout` |
| Data buyer | pays for a training run (`order`) |
| Runner | the registered TEE runner account, the only one that can `deliver` |
| Market owner | registers or revokes runners; has no access to vaults or tokens |

## Ways a seller could try to keep money or access

| # | Attack | What stops it | Where |
|---|---|---|---|
| 1 | Keep a key on the vault account and drain it later | The vault is created by the market with `CreateAccount + Transfer + UseGlobalContract + FunctionCall(new)`, with **no `AddKey` action**. It has no access key at all, so no one can sign a transaction as the vault. Check with `near account list-keys ds-<id>.<market>`: the list is empty. | `market::publish` |
| 2 | Call the vault directly | `vault.pay_out` panics unless the caller is the parent market. The vault has no other mutating method. | `vault::pay_out` |
| 3 | Change the vault code later | The vault runs global code referenced **by hash** (immutable, NEP-591). The hash is stored in the market and readable with `get_config`. No upgrade path exists in the vault. | `vault`, `market::get_config` |
| 4 | Withdraw after the sale | `market.withdraw` reads the current owner from the NFT state at call time and only pays `env::predecessor_account_id()` if it is that owner. The old owner fails with `Only the current holder can withdraw`. | `market::withdraw` |
| 5 | Start a withdrawal, then sell before the vault pays (the payment is asynchronous) | `withdraw` locks the token. `nft_transfer` and `nft_transfer_call` refuse a locked token (`Token is locked: withdrawal in progress`). The lock is cleared in the callback, which never panics, whether the payout succeeded or failed. | `market::withdraw`, `market::on_withdrawn` |
| 6 | List the token, then empty the vault just before the sale executes (buyer pays for a balance that is gone) | `withdraw` revokes every approval on the token. A listing whose vault was emptied loses its approval, so the marketplace's transfer fails and the buyer's money is never taken. The seller has to list again, at a price that reflects the new balance. | `market::withdraw` |
| 7 | Use `nft_transfer_call` to a contract they control, withdraw during the call, then let the transfer revert | While a transfer call is pending, the token is locked: `withdraw` refuses it (`Token is locked: transfer in progress`). The lock is cleared in `nft_resolve_transfer`. | `market::nft_transfer_call`, `market::nft_resolve_transfer` |
| 8 | Earnings in flight during the sale: an order was paid before the sale and is delivered after it | Earnings are sent to the **vault**, never to a person. Whoever holds the token when they withdraw gets them. A run paid before the sale and delivered after it belongs to the buyer. This is the intended rule: the vault and everything in it move with the token. | `market::deliver` |
| 9 | Keep an approval so a friendly account can transfer the token back after the sale | NEP-178: every transfer clears all approvals (`internal_transfer`). | near-contract-standards |
| 10 | Keep the holder-only page open | The page checks the current owner on-chain on every request, from a fresh NEP-413 signature. A session issued before the sale is not reused. | web app |
| 11 | Lower the price to zero before selling | This lowers future earnings, so it only hurts the seller's own sale. The price is public (`get_dataset`), so the buyer sees it before buying. | `market::set_price` |
| 12 | Market owner steals vault funds | The owner can only register or revoke runners. No method lets the owner move vault funds or tokens. The market account has **no access key** since 6 Nov 2026 (tx `GuZAoVk3CvKf9V4UQ1GqDG36cCJfhGXrYqrrtJBYd7nE`): nobody can redeploy its code or sign as it, so the code checked by `verify-build.sh` is final. Check with `near account list-keys sirius-ali-market.testnet network-config testnet now`: the list is empty. | `market` |
| 13 | A fake runner delivers a fake model to release payment | Only accounts registered by the market owner can `deliver`. What is checked on-chain: the caller is a registered, non-revoked runner. What is **not** checked on-chain: the TDX quote itself. The owner verifies it off-chain before registering the runner, and the quote hash is stored next to the runner so anyone can check it again. | `market::register_runner`, `market::deliver` |
| 14 | The runner never delivers, and the data buyer's money is stuck | After the deadline, the data buyer calls `refund`. Only an order that is still `Paid` can be refunded, and a delivered order cannot be. Done on testnet for Carol's orders 1 and 3 (`near/scripts/refund-demo.log`). An agent needs `refund` in its key to do the same (see Known limits). | `market::refund` |

## Who can read the data

| Party | What it sees | Why it cannot see more |
|---|---|---|
| Anyone (chain, mirrors, explorers) | sha256 of the sealed file in the NFT, the sealed file itself | It is sealed to the runner's X25519 key (XChaCha20-Poly1305, `lib/seal.mjs`); a flipped byte or another key fails the AEAD tag (`test/seal.test.mjs`). |
| NEAR AI's gateway and operators | ciphertext of the audit sample for the model | The sample is encrypted to the model's Ed25519 key, which the Intel TDX quote binds with our nonce (checked before encrypting). The gateway cannot swap the key: `X-Model-Pub-Key` pins it and `x-no-aliasing` forbids rerouting. |
| NEAR AI's model TEE | the 20-row sample, decrypted inside the enclave | It is the attested model: debug off, RTMR3 and MRCONFIGID match, GPUs attested by NVIDIA. Its reply is encrypted to a one-time client key. |
| Privacy filter and gateway TEEs | the same sample, column by column, over TLS | `/privacy/classify` has no E2EE (it classifies the ciphertext itself). Both TEEs are attested, the gateway's quote binds its TLS key (`tls_cert_fingerprint`), and the connection that carries the sample is pinned to that key during the TLS handshake (any other key aborts it before a byte is sent); `--no-filter` skips this step. |
| Anyone reading an audit transcript (`near/audits/<id>.json`) | the attestation reports, hashes and signatures, the model's request as ciphertext, its reply with the one-time key that opens it (the verdict: column names), the filter's flagged columns | No value of the sample is in it, and none in what the one-time key opens: the model runs with its reasoning off, the audit refuses to write a transcript if any opened field quotes a cell of the sample, and a test decrypts every field. The request is ciphertext to the model's key; the filter's input and reply are published only as hashes. (The first transcripts of 7 Nov let the key open the model's reasoning, which quoted a fictional postcode; they were replaced.) |
| The runner | the full dataset, in memory, during training | It holds the seal key. **Simulated TEE on testnet:** the key lives on the runner's machine, not in an enclave. |
| The data buyer | the trained model and its certificate | The dataset never leaves the runner. |

## Reports on accounts

| # | Attack | What stops it | Where |
|---|---|---|---|
| R1 | Spam reports to fill the contract's storage | Each report costs a 0.05 NEAR bond, which covers its storage; one report per reporter and account, at most 20 per account; 300 bytes per text. | `market::report` |
| R1b | A scammer fills its own report list (20 reports from its own accounts, 1 NEAR of refundable bonds) so a trusted reporter cannot add one | The market is locked, so the cap stays. The check treats a full list as a warning ("nobody else, a trusted reporter included, can add one"), so the scammer still needs a human's approval. Limit: the trusted report itself is missing; a reporter can still publish its evidence elsewhere. | `guard.mjs::judgePerson` |
| R2 | Pay a bond to block an honest seller (griefing) | The contract does not judge reports. A report blocks only when the agent's policy trusts its reporter (`trustedReporters`); any other report is a warning a human reads. | `guard.mjs`, `policy.json` |
| R3 | The reported account, or the market owner, deletes a report | No such method: only the reporter can retract their own report (`You have no report on this account`). | `market::retract_report` |
| R4 | A prompt-injected agent files false reports | The agent's key only calls `order_with_budget`; `report_account` drafts the transaction and the human signs it. | `mcp-server.mjs` |
| R5 | A throwaway account publishes a poisoned dataset | The check reads the age and activity of holder and publisher from their key nonces (a new key starts at block height × 10⁶): younger than 3 days or fewer than 3 transactions is a warning. It is a lower bound (deleted old keys make an account look younger, never older) and costs nothing to fake except time. | `guard.mjs::ageFromKeys` |
| R6 | The contract the agent pays is upgraded under it to a malicious version | The human pins the code hash of the build they checked (`pinnedCode`, from `verify-build.sh`); any other hash blocks. A contract that still has a full-access key is a warning. The market has no key at all, so it cannot be upgraded. | `guard.mjs::judgeCode` |
| R7 | The agent pays twice for the same run, or keeps paying a seller whose runs never arrive | The check reads the agent's own orders: one still pending on the same NFT warns; earlier orders with the holder that were never delivered warn. | `guard.mjs::priorOrders` |
| R8 | The RPC throttles or fails while the reports are read, so a trusted report is silently missed | A failed read is not "no report": the check blocks until the reports can be read. | `guard.mjs::accountSignals` |
| R9 | A holder records a fake audit hash to get the "audited" badge and pass the check | The contract cannot tell, but the check counts an audit only when its public transcript recomputes the hash in the NFT (no transcript: a warning; another hash: a block), and the runner refuses to train without a matching transcript or on a file that is not the audited plaintext. The check recomputes the hash only; `verify-audit.mjs` re-checks every TEE proof and signature. The card the contract draws still says "audit recorded" for any hash (the market is locked). | `guard.mjs`, `runner-bridge.mjs::auditBinding`, `verify-audit.mjs` |
| R10 | A provider audits a clean CSV, or a clean sample, and publishes a different file | NFT 6's audit binds the sha256 of the audited CSV (`plaintextHash`) next to the sealed file's hash, and seals the model request's E2EE secrets to the runner: the runner re-encrypts the sample of the file it opens and compares it byte for byte with the request the model TEE signed; the filter's request is rebuilt from the CSV and compared by hash. Limit: the detectors see the first 20 rows; personal data placed only below row 20 is not seen. | `lib/audit.mjs::checkSampleProof`, `runner-bridge.mjs::auditBinding` |
| R11 | The agent edits `approvals.json` to approve itself | An approval covers one NFT, one offer, the holder and price the human saw, once. The file must live where the agent's tools cannot write (`SIRIUS_APPROVALS`); an agent with write access there can approve itself. | `lib/approvals.mjs` |

## Known limits (stated plainly)

- History entries and orders are stored by the market contract. The contract pays their storage from its own balance.
  This is fine for a testnet demo, but not for an open market (a spammer could make the contract pay for storage).
- The vault pays `balance - storage reserve` and reports that amount to the market. If the receiving account no longer
  exists, the transfer fails and the funds stay in the vault, while the history records the attempted amount.
- Attestation of the training enclave is checked off-chain (see #13), not by the contract.
- Agent budgets and the "paid from a budget" flag of each order are also stored at the contract's expense. Anyone can
  fund a budget for any agent id with 1 yoctoNEAR: that costs the contract storage, and the first funder of an agent id
  keeps it (another funder is refused). Pick an agent id nobody else knows before funding it.
- `refund` is accepted only from the buyer. An agent whose key allows only `order_with_budget` cannot get its
  undelivered orders back; give agents a key with `refund` too (`gas-key-setup.mjs` does). The two demo agents predate
  this; all their orders were delivered. A refund after `close_agent_budget` fails (`Budget missing`): close a budget
  only when none of its orders is pending.
- `refund_order` refuses when the agent's budget is closed: a refund then fails, or would land in a budget that
  someone else opened for that agent id with 1 yoctoNEAR.
- The market is locked, so none of the limits above can be fixed in the contract; they are handled on the agent's side
  and stated here.
- A plain function-call key spends its gas allowance (0.25 NEAR on `agent.sirius-ali-carol.testnet`); when it runs
  out, the agent cannot send transactions until a human adds a new key. The gas-key agent
  (`gk-agent.sirius-ali-carol.testnet`, NEP-611) has no allowance: its key holds prepaid gas that the funder tops up
  from outside, so it cannot lock itself out; an empty key only pauses it. Neither key gives access to the budget,
  which only the funder can close.

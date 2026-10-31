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
| 12 | Market owner steals vault funds | The owner can only register or revoke runners. No method lets the owner move vault funds or tokens. Disclosed limit: if the market account keeps a full-access key, the code could be redeployed. The demo deployment deletes it (`near/scripts/lock-market.sh`). | `market` |
| 13 | A fake runner delivers a fake model to release payment | Only accounts registered by the market owner can `deliver`. What is checked on-chain: the caller is a registered, non-revoked runner. What is **not** checked on-chain: the TDX quote itself. The owner verifies it off-chain before registering the runner, and the quote hash is stored next to the runner so anyone can check it again. | `market::register_runner`, `market::deliver` |
| 14 | The runner never delivers, and the data buyer's money is stuck | After the deadline, the data buyer calls `refund`. Only an order that is still `Paid` can be refunded, and a delivered order cannot be. | `market::refund` |

## Known limits (stated plainly)

- History entries and orders are stored by the market contract. The contract pays their storage from its own balance.
  This is fine for a testnet demo, but not for an open market (a spammer could make the contract pay for storage).
- The vault pays `balance - storage reserve` and reports that amount to the market. If the receiving account no longer
  exists, the transfer fails and the funds stay in the vault, while the history records the attempted amount.
- Attestation of the training enclave is checked off-chain (see #13), not by the contract.

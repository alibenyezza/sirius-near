//! Vault of one Sirius dataset: the account `ds-<id>.<market>` that collects the dataset's earnings.
//!
//! The market creates it with no access key and attaches this code as an immutable global contract (by hash).
//! The only mutating method, `pay_out`, can be called by the parent market alone, which pays the current holder
//! of the dataset NFT.
//!
//! Written against the low-level `env` API, without the `#[near]` macros, so the published global code stays a few
//! kilobytes: publishing global code burns 10 NEAR per 100 KB.
use near_sdk::{env, AccountId, NearToken, Promise};

/// Kept on the vault on top of its storage, so the account never drops under its storage requirement.
const RESERVE: NearToken = NearToken::from_millinear(10);
const PARENT: &[u8] = b"p";

fn parent() -> AccountId {
    let raw = env::storage_read(PARENT).unwrap_or_else(|| env::panic_str("Vault not initialized"));
    String::from_utf8(raw).ok().and_then(|s| s.parse().ok()).unwrap_or_else(|| env::panic_str("Corrupt state"))
}

fn payable() -> NearToken {
    let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    env::account_balance().saturating_sub(storage).saturating_sub(RESERVE)
}

fn return_json_string(s: &str) {
    env::value_return(format!("\"{s}\"").as_bytes());
}

/// Reads `receiver_id` from the JSON arguments `{"receiver_id":"<account>"}`.
fn receiver_from(input: &[u8]) -> AccountId {
    let text = core::str::from_utf8(input).unwrap_or_else(|_| env::panic_str("Arguments must be UTF-8"));
    let key = "\"receiver_id\"";
    let start = text.find(key).unwrap_or_else(|| env::panic_str("Missing receiver_id"));
    let rest = text[start + key.len()..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or_else(|| env::panic_str("Invalid arguments")).trim_start();
    let rest = rest.strip_prefix('"').unwrap_or_else(|| env::panic_str("Invalid arguments"));
    let end = rest.find('"').unwrap_or_else(|| env::panic_str("Invalid arguments"));
    rest[..end].parse().unwrap_or_else(|_| env::panic_str("Invalid receiver_id"))
}

/// Called by the market in the batch that creates this account, so the predecessor is the market.
#[no_mangle]
pub extern "C" fn new() {
    init();
}

fn init() {
    if env::storage_has_key(PARENT) {
        env::panic_str("Already initialized");
    }
    env::storage_write(PARENT, env::predecessor_account_id().as_bytes());
}

#[no_mangle]
pub extern "C" fn get_parent() {
    return_json_string(parent().as_str());
}

/// Amount that `pay_out` would send now, in yoctoNEAR.
#[no_mangle]
pub extern "C" fn available() {
    return_json_string(&payable().as_yoctonear().to_string());
}

/// Sends everything above the reserve to `receiver_id`. Parent market only. Returns the amount sent.
#[no_mangle]
pub extern "C" fn pay_out() {
    let amount = pay_out_from(&env::input().unwrap_or_default());
    return_json_string(&amount.as_yoctonear().to_string());
}

fn pay_out_from(input: &[u8]) -> NearToken {
    if env::predecessor_account_id() != parent() {
        env::panic_str("Only the parent market can pay out");
    }
    let receiver = receiver_from(input);
    let amount = payable();
    if !amount.is_zero() {
        Promise::new(receiver).transfer(amount).detach();
    }
    amount
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: &str, balance: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("ds-1.market.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .account_balance(balance)
            .build());
    }

    const TO_HOLDER: &[u8] = br#"{"receiver_id": "holder.testnet"}"#;

    #[test]
    fn parent_is_the_creator() {
        ctx("market.testnet", NearToken::from_near(1));
        init();
        assert_eq!(parent().as_str(), "market.testnet");
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn cannot_init_twice() {
        ctx("market.testnet", NearToken::from_near(1));
        init();
        ctx("seller.testnet", NearToken::from_near(1));
        init();
    }

    #[test]
    #[should_panic(expected = "Only the parent market can pay out")]
    fn stranger_cannot_pay_out() {
        ctx("market.testnet", NearToken::from_near(1));
        init();
        ctx("seller.testnet", NearToken::from_near(1));
        pay_out_from(br#"{"receiver_id":"seller.testnet"}"#);
    }

    #[test]
    fn parent_pays_everything_above_reserve() {
        ctx("market.testnet", NearToken::from_near(100));
        init();
        ctx("market.testnet", NearToken::from_near(100));
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        let expected = NearToken::from_near(100).as_yoctonear() - storage - RESERVE.as_yoctonear();
        assert_eq!(pay_out_from(TO_HOLDER).as_yoctonear(), expected);
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), "holder.testnet");
    }

    #[test]
    fn empty_vault_pays_zero() {
        ctx("market.testnet", NearToken::from_millinear(5));
        init();
        ctx("market.testnet", NearToken::from_millinear(5));
        assert!(pay_out_from(TO_HOLDER).is_zero());
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    #[should_panic(expected = "Invalid receiver_id")]
    fn rejects_bad_receiver() {
        ctx("market.testnet", NearToken::from_near(1));
        init();
        pay_out_from(br#"{"receiver_id":"NOT VALID"}"#);
    }
}

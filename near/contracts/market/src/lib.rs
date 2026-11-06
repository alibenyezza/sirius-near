//! Sirius market on NEAR.
//!
//! - Each dataset is an NEP-171 token. Publishing a dataset creates its vault, `ds-<id>.<this account>`: an account
//!   with no access key that runs the immutable vault code (global contract, by hash) and only obeys this contract.
//! - A data buyer pays a training run in NEAR (`order`). A registered TEE runner delivers the hashes of the model
//!   and of the execution certificate (`deliver`): the net price goes to the dataset's vault, the fee to the
//!   treasury. Without delivery, the buyer is refunded after the deadline (`refund`).
//! - The current holder of the token withdraws the vault (`withdraw`). Selling the token moves the vault, its balance
//!   and the holder's rights. See `near/THREAT-MODEL.md` for every way a seller could try to keep the money.
use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CryptoHash, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

/// Sent to each new vault: its reserve plus a margin. Above the zero-balance limit it covers its own storage.
pub const VAULT_FUNDING: NearToken = NearToken::from_millinear(20);
/// Upper bound of the storage a published token needs (token, metadata, dataset record, first history entry).
pub const PUBLISH_STORAGE_BOUND: NearToken = NearToken::from_millinear(60);
const MAX_HISTORY: usize = 200;
const MAX_FEE_BPS: u16 = 2_000;
const GAS_FOR_VAULT_INIT: Gas = Gas::from_tgas(10);
const GAS_FOR_VAULT_READY: Gas = Gas::from_tgas(30);
const GAS_FOR_PAY_OUT: Gas = Gas::from_tgas(15);
const GAS_FOR_WITHDRAWN: Gas = Gas::from_tgas(15);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Owners,
    TokenMetadata,
    Enumeration,
    Approvals,
    Datasets,
    History,
    Locks,
    Runners,
    Orders,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Lock {
    /// A withdrawal is in flight: the token cannot be transferred until the vault answers.
    Withdrawal,
    /// An `nft_transfer_call` is in flight: the vault cannot be withdrawn until it resolves.
    Transfer,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Published { publisher: AccountId, price: U128 },
    PriceChanged { price: U128 },
    PrivacyAudit { report_hash: String, model: String },
    Earned { order_id: U64, amount: U128 },
    Withdrawn { to: AccountId, amount: U128 },
    WithdrawalFailed { to: AccountId },
    Transferred { from: AccountId, to: AccountId },
    TransferReverted { from: AccountId, to: AccountId },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub at_ms: U64,
    pub event: Event,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PrivacyAudit {
    /// sha256 of the attestation report and signed reply returned by NEAR AI Cloud (computed off-chain).
    pub report_hash: String,
    pub model: String,
    pub nonce: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Dataset {
    pub vault: AccountId,
    pub publisher: AccountId,
    pub price: U128,
    pub profile: String,
    /// sha256 of the encrypted dataset's CID.
    pub cid_hash: String,
    pub earned: U128,
    pub withdrawn: U128,
    pub privacy_audit: Option<PrivacyAudit>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Runner {
    /// sha256 of the TDX quote checked off-chain by the owner before registering this runner.
    pub quote_hash: String,
    /// TDX measurement (MRTD or compose hash) the quote was checked against.
    pub measurement: String,
    pub registered_at_ms: U64,
    pub revoked: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    Paid,
    Delivered { runner: AccountId, model_hash: String, certificate_hash: String },
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub token_id: TokenId,
    pub buyer: AccountId,
    pub amount: U128,
    pub profile: String,
    pub deadline_ms: U64,
    pub status: OrderStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct AgentBudget {
    pub funder: AccountId,
    pub balance: U128,
    pub max_per_order: U128,
    pub spent: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub treasury_id: AccountId,
    pub fee_bps: u16,
    pub vault_code_hash: Base58CryptoHash,
    pub vault_funding: U128,
    pub publish_deposit: U128,
}

#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[ext_contract(ext_vault)]
#[allow(dead_code)]
trait VaultContract {
    fn pay_out(&mut self, receiver_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_vault_ready(&mut self, token_id: TokenId, publisher: AccountId, metadata: TokenMetadata, dataset: Dataset, deposit: U128) -> bool;
    fn on_withdrawn(&mut self, token_id: TokenId, to: AccountId) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner_id: AccountId,
    treasury_id: AccountId,
    fee_bps: u16,
    vault_code_hash: CryptoHash,
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    next_token: u64,
    next_order: u64,
    datasets: LookupMap<TokenId, Dataset>,
    history: LookupMap<TokenId, Vec<HistoryEntry>>,
    locks: LookupMap<TokenId, Lock>,
    runners: LookupMap<AccountId, Runner>,
    orders: LookupMap<u64, Order>,
}

#[near]
impl Market {
    /// `fee_bps` and `vault_code_hash` are fixed here and cannot be changed later.
    #[init]
    pub fn new(owner_id: AccountId, treasury_id: AccountId, fee_bps: u16, vault_code_hash: Base58CryptoHash) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        Self {
            tokens: NonFungibleToken::new(
                Key::Owners,
                env::current_account_id(),
                Some(Key::TokenMetadata),
                Some(Key::Enumeration),
                Some(Key::Approvals),
            ),
            metadata: NFTContractMetadata {
                spec: NFT_METADATA_SPEC.to_string(),
                name: "Sirius datasets".to_string(),
                symbol: "SIRIUS".to_string(),
                icon: None,
                base_uri: None,
                reference: None,
                reference_hash: None,
            },
            owner_id,
            treasury_id,
            fee_bps,
            vault_code_hash: vault_code_hash.into(),
            next_token: 1,
            next_order: 1,
            datasets: LookupMap::new(Key::Datasets),
            history: LookupMap::new(Key::History),
            locks: LookupMap::new(Key::Locks),
            runners: LookupMap::new(Key::Runners),
            orders: LookupMap::new(Key::Orders),
        }
    }

    // ---------- datasets ----------

    /// Publishes a dataset: creates its vault, then mints the token to the caller.
    /// Attach at least `publish_deposit` (see `get_config`); what is not used is refunded.
    #[payable]
    pub fn publish(&mut self, title: String, description: String, profile: String, cid_hash: String, price: U128) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= Self::publish_deposit(), "Attach the publish deposit (see get_config)");
        require!(!title.is_empty() && title.len() <= 120, "Title must be 1 to 120 characters");
        require!(description.len() <= 1_000, "Description too long");
        require!(cid_hash.len() == 64 && cid_hash.bytes().all(|b| b.is_ascii_hexdigit()), "cid_hash must be a sha256 hex digest");
        require!(!profile.is_empty() && profile.len() <= 64, "Invalid profile");

        let n = self.next_token;
        self.next_token += 1;
        let token_id = n.to_string();
        let vault: AccountId = format!("ds-{n}.{}", env::current_account_id()).parse().unwrap();
        let publisher = env::predecessor_account_id();
        let metadata = TokenMetadata {
            title: Some(title),
            description: Some(description),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        };
        let dataset = Dataset {
            vault: vault.clone(),
            publisher: publisher.clone(),
            price,
            profile,
            cid_hash,
            earned: U128(0),
            withdrawn: U128(0),
            privacy_audit: None,
        };

        // No AddKey action: the vault never has an access key.
        Promise::new(vault)
            .create_account()
            .transfer(VAULT_FUNDING)
            .use_global_contract(self.vault_code_hash)
            .function_call("new".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_FOR_VAULT_INIT)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_VAULT_READY)
                    .on_vault_ready(token_id, publisher, metadata, dataset, U128(deposit.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_vault_ready(&mut self, token_id: TokenId, publisher: AccountId, metadata: TokenMetadata, dataset: Dataset, deposit: U128) -> bool {
        let deposit = NearToken::from_yoctonear(deposit.0);
        if matches!(env::promise_result_checked(0, 0), Err(near_sdk::PromiseError::Failed)) {
            // The batch failed and the vault funding came back to this account: refund everything.
            Promise::new(publisher).transfer(deposit).detach();
            return false;
        }
        let before = env::storage_usage();
        self.tokens.internal_mint_with_refund(token_id.clone(), publisher.clone(), Some(metadata), None);
        let price = dataset.price;
        self.datasets.insert(token_id.clone(), dataset);
        self.push_history(&token_id, Event::Published { publisher: publisher.clone(), price });
        self.datasets.flush();
        self.history.flush();
        let used = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let refund = deposit.saturating_sub(VAULT_FUNDING).saturating_sub(used);
        if !refund.is_zero() {
            Promise::new(publisher).transfer(refund).detach();
        }
        true
    }

    /// Training price for this dataset. Current holder only.
    #[payable]
    pub fn set_price(&mut self, token_id: TokenId, price: U128) {
        assert_one_yocto();
        self.assert_holder(&token_id);
        self.dataset_mut(&token_id).price = price;
        self.push_history(&token_id, Event::PriceChanged { price });
    }

    /// Records the privacy audit made on NEAR AI Cloud (see `near/scripts/privacy-audit.mjs`). Current holder only.
    /// The contract stores the hash; it cannot check the attestation itself.
    #[payable]
    pub fn set_privacy_audit(&mut self, token_id: TokenId, report_hash: String, model: String, nonce: String) {
        assert_one_yocto();
        self.assert_holder(&token_id);
        require!(report_hash.len() == 64 && report_hash.bytes().all(|b| b.is_ascii_hexdigit()), "report_hash must be a sha256 hex digest");
        require!(nonce.len() == 64 && nonce.bytes().all(|b| b.is_ascii_hexdigit()), "nonce must be 32 bytes in hex");
        require!(!model.is_empty() && model.len() <= 128, "Invalid model");
        self.dataset_mut(&token_id).privacy_audit = Some(PrivacyAudit { report_hash: report_hash.clone(), model: model.clone(), nonce });
        self.push_history(&token_id, Event::PrivacyAudit { report_hash, model });
    }

    /// Sends the vault's balance to the current holder. Locks the token until the vault answers and revokes every
    /// approval, so a listing made before the withdrawal cannot be filled at the old price.
    #[payable]
    pub fn withdraw(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let holder = env::predecessor_account_id();
        require!(self.owner_of(&token_id) == holder, "Only the current holder can withdraw");
        self.assert_unlocked(&token_id);
        self.locks.insert(token_id.clone(), Lock::Withdrawal);
        if let Some(approvals) = self.tokens.approvals_by_id.as_mut() {
            approvals.remove(&token_id);
        }
        let vault = self.dataset(&token_id).vault;
        ext_vault::ext(vault)
            .with_static_gas(GAS_FOR_PAY_OUT)
            .pay_out(holder.clone())
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_WITHDRAWN).on_withdrawn(token_id, holder))
    }

    /// Never panics: the lock is always cleared.
    #[private]
    pub fn on_withdrawn(&mut self, token_id: TokenId, to: AccountId) -> U128 {
        self.locks.remove(&token_id);
        let amount = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        match amount {
            Some(amount) => {
                if let Some(d) = self.datasets.get_mut(&token_id) {
                    d.withdrawn = U128(d.withdrawn.0 + amount.0);
                }
                self.push_history(&token_id, Event::Withdrawn { to, amount });
                amount
            }
            None => {
                self.push_history(&token_id, Event::WithdrawalFailed { to });
                U128(0)
            }
        }
    }

    // ---------- runners ----------

    /// Registers a TEE runner after its quote was checked off-chain. Owner only.
    pub fn register_runner(&mut self, runner_id: AccountId, quote_hash: String, measurement: String) {
        self.assert_owner();
        require!(quote_hash.len() == 64 && quote_hash.bytes().all(|b| b.is_ascii_hexdigit()), "quote_hash must be a sha256 hex digest");
        require!(!measurement.is_empty() && measurement.len() <= 128, "Invalid measurement");
        self.runners.insert(runner_id, Runner { quote_hash, measurement, registered_at_ms: U64(env::block_timestamp_ms()), revoked: false });
    }

    pub fn revoke_runner(&mut self, runner_id: AccountId) {
        self.assert_owner();
        self.runners.get_mut(&runner_id).unwrap_or_else(|| env::panic_str("Unknown runner")).revoked = true;
    }

    // ---------- orders ----------

    /// Pays a training run on a dataset. Attach at least the dataset's price; the rest is refunded.
    #[payable]
    pub fn order(&mut self, token_id: TokenId, profile: String, deadline_minutes: u32) -> U64 {
        let d = self.dataset(&token_id);
        require!(profile == d.profile, "This dataset only accepts its own training profile");
        require!((1..=10_080).contains(&deadline_minutes), "Deadline must be 1 minute to 7 days");
        let price = NearToken::from_yoctonear(d.price.0);
        require!(!price.is_zero(), "This dataset is not for sale");
        let deposit = env::attached_deposit();
        require!(deposit >= price, "Attach at least the dataset's price");
        let buyer = env::predecessor_account_id();
        let id = self.next_order;
        self.next_order += 1;
        self.orders.insert(id, Order {
            token_id,
            buyer: buyer.clone(),
            amount: U128(price.as_yoctonear()),
            profile,
            deadline_ms: U64(env::block_timestamp_ms() + deadline_minutes as u64 * 60_000),
            status: OrderStatus::Paid,
        });
        let extra = deposit.saturating_sub(price);
        if !extra.is_zero() {
            Promise::new(buyer).transfer(extra).detach();
        }
        U64(id)
    }

    /// Delivery by a registered runner: pays the dataset's vault (whoever holds the token at withdrawal time) and
    /// the treasury.
    pub fn deliver(&mut self, order_id: U64, model_hash: String, certificate_hash: String) {
        let runner = env::predecessor_account_id();
        let r = self.runners.get(&runner).unwrap_or_else(|| env::panic_str("Not a registered runner"));
        require!(!r.revoked, "Runner revoked");
        require!(model_hash.len() == 64 && model_hash.bytes().all(|b| b.is_ascii_hexdigit()), "model_hash must be a sha256 hex digest");
        require!(certificate_hash.len() == 64 && certificate_hash.bytes().all(|b| b.is_ascii_hexdigit()), "certificate_hash must be a sha256 hex digest");
        let order = self.orders.get_mut(&order_id.0).unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(order.status == OrderStatus::Paid, "Order is not waiting for delivery");
        require!(env::block_timestamp_ms() <= order.deadline_ms.0, "Deadline passed");
        order.status = OrderStatus::Delivered { runner, model_hash, certificate_hash };
        let (token_id, amount) = (order.token_id.clone(), order.amount.0);
        let fee = amount * self.fee_bps as u128 / 10_000;
        let net = amount - fee;
        let d = self.datasets.get_mut(&token_id).unwrap();
        d.earned = U128(d.earned.0 + net);
        Promise::new(d.vault.clone()).transfer(NearToken::from_yoctonear(net)).detach();
        if fee > 0 {
            Promise::new(self.treasury_id.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
        }
        self.push_history(&token_id, Event::Earned { order_id, amount: U128(net) });
    }

    /// Refund of a run that was not delivered before its deadline. Buyer only. A run paid from an agent budget
    /// goes back to that budget.
    pub fn refund(&mut self, order_id: U64) -> PromiseOrValue<()> {
        let order = self.orders.get_mut(&order_id.0).unwrap_or_else(|| env::panic_str("Unknown order"));
        require!(env::predecessor_account_id() == order.buyer, "Only the buyer can ask for a refund");
        require!(order.status == OrderStatus::Paid, "Only a paid, undelivered order can be refunded");
        require!(env::block_timestamp_ms() > order.deadline_ms.0, "Deadline not reached");
        order.status = OrderStatus::Refunded;
        let (buyer, amount) = (order.buyer.clone(), order.amount.0);
        if Self::order_paid_from_budget(order_id.0) {
            let mut b = Self::budget_of(&buyer).unwrap_or_else(|| env::panic_str("Budget missing"));
            b.balance = U128(b.balance.0 + amount);
            Self::save_budget(&buyer, &b);
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(Promise::new(buyer).transfer(NearToken::from_yoctonear(amount)))
    }

    // ---------- agent budgets ----------

    /// A human funds a spending budget for an agent account. The agent can only spend it on training runs here,
    /// at most `max_per_order` each, through `order_with_budget` (callable with a function-call key, which cannot
    /// attach deposits). The funder can take back what is left at any time.
    #[payable]
    pub fn fund_agent(&mut self, agent_id: AccountId, max_per_order: U128) -> AgentBudget {
        let funder = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "Attach the budget");
        let mut b = Self::budget_of(&agent_id).unwrap_or(AgentBudget { funder: funder.clone(), balance: U128(0), max_per_order, spent: U128(0) });
        require!(b.funder == funder, "This agent is funded by another account");
        b.balance = U128(b.balance.0 + deposit);
        b.max_per_order = max_per_order;
        Self::save_budget(&agent_id, &b);
        b
    }

    /// Funder only: sends back what is left of the agent's budget and closes it.
    pub fn close_agent_budget(&mut self, agent_id: AccountId) -> Promise {
        let b = Self::budget_of(&agent_id).unwrap_or_else(|| env::panic_str("No budget for this agent"));
        require!(env::predecessor_account_id() == b.funder, "Only the funder can close this budget");
        env::storage_remove(&Self::budget_key(&agent_id));
        Promise::new(b.funder).transfer(NearToken::from_yoctonear(b.balance.0))
    }

    /// The agent pays a training run from its budget. Never takes more than the dataset's price, never more than
    /// `max_per_order`, never more than what is left.
    pub fn order_with_budget(&mut self, token_id: TokenId, profile: String, deadline_minutes: u32, max_price: U128) -> U64 {
        let agent = env::predecessor_account_id();
        let mut b = Self::budget_of(&agent).unwrap_or_else(|| env::panic_str("No budget for this agent"));
        let d = self.dataset(&token_id);
        require!(profile == d.profile, "This dataset only accepts its own training profile");
        require!((1..=10_080).contains(&deadline_minutes), "Deadline must be 1 minute to 7 days");
        let price = d.price.0;
        require!(price > 0, "This dataset is not for sale");
        require!(price <= max_price.0, "Price above the agent's offer");
        require!(price <= b.max_per_order.0, "Price above the budget's per-order limit");
        require!(price <= b.balance.0, "Budget too low");
        b.balance = U128(b.balance.0 - price);
        b.spent = U128(b.spent.0 + price);
        Self::save_budget(&agent, &b);
        let id = self.next_order;
        self.next_order += 1;
        self.orders.insert(id, Order {
            token_id,
            buyer: agent,
            amount: U128(price),
            profile,
            deadline_ms: U64(env::block_timestamp_ms() + deadline_minutes as u64 * 60_000),
            status: OrderStatus::Paid,
        });
        env::storage_write(&Self::budget_order_key(id), &[1]);
        U64(id)
    }

    pub fn get_agent_budget(&self, agent_id: AccountId) -> Option<AgentBudget> {
        Self::budget_of(&agent_id)
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            treasury_id: self.treasury_id.clone(),
            fee_bps: self.fee_bps,
            vault_code_hash: self.vault_code_hash.into(),
            vault_funding: U128(VAULT_FUNDING.as_yoctonear()),
            publish_deposit: U128(Self::publish_deposit().as_yoctonear()),
        }
    }

    pub fn get_dataset(&self, token_id: TokenId) -> Option<Dataset> {
        self.datasets.get(&token_id).cloned()
    }

    pub fn get_history(&self, token_id: TokenId) -> Vec<HistoryEntry> {
        self.history.get(&token_id).cloned().unwrap_or_default()
    }

    /// Everyone who has held the token, in order.
    pub fn get_holders(&self, token_id: TokenId) -> Vec<AccountId> {
        let mut holders = Vec::new();
        for e in self.get_history(token_id) {
            match e.event {
                Event::Published { publisher, .. } => holders.push(publisher),
                Event::Transferred { to, .. } | Event::TransferReverted { to, .. } => holders.push(to),
                _ => {}
            }
        }
        holders
    }

    pub fn get_lock(&self, token_id: TokenId) -> Option<Lock> {
        self.locks.get(&token_id).cloned()
    }

    pub fn get_runner(&self, runner_id: AccountId) -> Option<Runner> {
        self.runners.get(&runner_id).cloned()
    }

    pub fn get_order(&self, order_id: U64) -> Option<Order> {
        self.orders.get(&order_id.0).cloned()
    }

    pub fn is_holder(&self, token_id: TokenId, account_id: AccountId) -> bool {
        self.tokens.owner_by_id.get(&token_id).is_some_and(|o| o == account_id)
    }

    // ---------- NEP-199 payouts (the whole sale price goes to the holder) ----------

    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        require!(max_len_payout.unwrap_or(1) >= 1, "max_len_payout too small");
        Payout { payout: HashMap::from([(self.owner_of(&token_id), balance)]) }
    }

    #[payable]
    pub fn nft_transfer_payout(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, balance: U128, max_len_payout: Option<u32>) -> Payout {
        assert_one_yocto();
        let payout = self.nft_payout(token_id.clone(), balance, max_len_payout);
        self.nft_transfer(receiver_id, token_id, approval_id, memo);
        payout
    }
}

// ---------- NEP-171 with the vault rules ----------

#[near]
impl NonFungibleTokenCore for Market {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        self.assert_unlocked(&token_id);
        let (from, _) = self.tokens.internal_transfer(&env::predecessor_account_id(), &receiver_id, &token_id, approval_id, memo);
        self.push_history(&token_id, Event::Transferred { from, to: receiver_id });
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.assert_unlocked(&token_id);
        let from = self.owner_of(&token_id);
        let out = self.tokens.nft_transfer_call(receiver_id.clone(), token_id.clone(), approval_id, memo, msg);
        self.locks.insert(token_id.clone(), Lock::Transfer);
        self.push_history(&token_id, Event::Transferred { from, to: receiver_id });
        out
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).map(|t| self.live(t))
    }
}

#[near]
impl NonFungibleTokenResolver for Market {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.locks.remove(&token_id);
        let kept = self.tokens.nft_resolve_transfer(previous_owner_id.clone(), receiver_id.clone(), token_id.clone(), approved_account_ids);
        if !kept {
            self.push_history(&token_id, Event::TransferReverted { from: receiver_id, to: previous_owner_id });
        }
        kept
    }
}

#[near]
impl NonFungibleTokenApproval for Market {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.assert_unlocked(&token_id);
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id)
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id)
    }

    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Market {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit).into_iter().map(|t| self.live(t)).collect()
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit).into_iter().map(|t| self.live(t)).collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Market {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

// ---------- internals ----------

impl Market {
    // Budgets live under their own keys, outside the contract struct, so they were added without migrating state.
    fn budget_key(agent: &AccountId) -> Vec<u8> {
        [b"budget:".as_slice(), agent.as_bytes()].concat()
    }

    fn budget_order_key(order_id: u64) -> Vec<u8> {
        [b"budget-order:".as_slice(), &order_id.to_le_bytes()].concat()
    }

    fn budget_of(agent: &AccountId) -> Option<AgentBudget> {
        env::storage_read(&Self::budget_key(agent)).map(|v| near_sdk::borsh::from_slice(&v).unwrap())
    }

    fn save_budget(agent: &AccountId, b: &AgentBudget) {
        env::storage_write(&Self::budget_key(agent), &near_sdk::borsh::to_vec(b).unwrap());
    }

    fn order_paid_from_budget(order_id: u64) -> bool {
        env::storage_has_key(&Self::budget_order_key(order_id))
    }

    fn publish_deposit() -> NearToken {
        VAULT_FUNDING.saturating_add(PUBLISH_STORAGE_BOUND)
    }

    fn owner_of(&self, token_id: &TokenId) -> AccountId {
        self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("Token not found"))
    }

    fn assert_holder(&self, token_id: &TokenId) {
        require!(self.owner_of(token_id) == env::predecessor_account_id(), "Only the current holder can do this");
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
    }

    fn assert_unlocked(&self, token_id: &TokenId) {
        match self.locks.get(token_id) {
            Some(Lock::Withdrawal) => env::panic_str("Token is locked: withdrawal in progress"),
            Some(Lock::Transfer) => env::panic_str("Token is locked: transfer in progress"),
            None => {}
        }
    }

    fn dataset(&self, token_id: &TokenId) -> Dataset {
        self.datasets.get(token_id).cloned().unwrap_or_else(|| env::panic_str("Unknown dataset"))
    }

    fn dataset_mut(&mut self, token_id: &TokenId) -> &mut Dataset {
        self.datasets.get_mut(token_id).unwrap_or_else(|| env::panic_str("Unknown dataset"))
    }

    /// Dynamic NFT: the card is drawn from the contract state on every read, so a wallet always shows what the
    /// vault has earned, how much is still in it, how many sales it went through and whether its privacy audit is
    /// recorded. Nothing is stored: `media` is an SVG data URL built here, `extra` the same figures as JSON.
    fn live(&self, mut token: Token) -> Token {
        let Some(d) = self.datasets.get(&token.token_id) else { return token };
        let history = self.history.get(&token.token_id).map(|h| h.as_slice()).unwrap_or(&[]);
        let sales = history.iter().filter(|e| matches!(e.event, Event::Transferred { .. })).count();
        let runs = history.iter().filter(|e| matches!(e.event, Event::Earned { .. })).count();
        let in_vault = d.earned.0.saturating_sub(d.withdrawn.0);
        let near = |y: u128| format!("{}.{:03}", y / 10u128.pow(24), (y % 10u128.pow(24)) / 10u128.pow(21));
        let owner = token.owner_id.to_string();
        let mut meta = token.metadata.take().unwrap_or_else(|| TokenMetadata {
            title: None, description: None, media: None, media_hash: None, copies: None, issued_at: None,
            expires_at: None, starts_at: None, updated_at: None, extra: None, reference: None, reference_hash: None,
        });
        let title = esc(meta.title.as_deref().unwrap_or("Sirius dataset"));
        let (badge, color) = if d.privacy_audit.is_some() { ("PRIVACY AUDIT RECORDED", "#3ddc97") } else { ("NO PRIVACY AUDIT", "#f5a524") };
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><rect width='400' height='400' fill='#0b0f1a'/>\
<text x='24' y='44' fill='#8aa0c8' font-family='monospace' font-size='14'>SIRIUS DATASET #{id}</text>\
<text x='24' y='80' fill='#fff' font-family='sans-serif' font-size='20'>{title}</text>\
<text x='24' y='140' fill='#8aa0c8' font-family='monospace' font-size='13'>EARNED</text>\
<text x='24' y='170' fill='#fff' font-family='monospace' font-size='28'>{earned} NEAR</text>\
<text x='24' y='210' fill='#8aa0c8' font-family='monospace' font-size='13'>IN THE VAULT</text>\
<text x='24' y='240' fill='#fff' font-family='monospace' font-size='28'>{in_vault} NEAR</text>\
<text x='24' y='282' fill='#8aa0c8' font-family='monospace' font-size='13'>{runs} TRAINING RUN{rs} · {sales} SALE{ss}</text>\
<text x='24' y='306' fill='#8aa0c8' font-family='monospace' font-size='12'>VAULT {vault}</text>\
<rect x='24' y='326' width='352' height='44' rx='8' fill='none' stroke='{color}'/>\
<text x='40' y='354' fill='{color}' font-family='monospace' font-size='15'>{badge}</text></svg>",
            id = esc(&token.token_id), title = title, earned = near(d.earned.0), in_vault = near(in_vault),
            runs = runs, sales = sales, rs = if runs == 1 { "" } else { "S" }, ss = if sales == 1 { "" } else { "S" }, vault = esc(d.vault.as_str()), color = color, badge = badge,
        );
        use near_sdk::base64::Engine;
        meta.media = Some(format!("data:image/svg+xml;base64,{}", near_sdk::base64::engine::general_purpose::STANDARD.encode(svg)));
        meta.media_hash = None;
        meta.extra = Some(near_sdk::serde_json::json!({
            "vault": d.vault, "holder": owner, "earned": d.earned, "withdrawn": d.withdrawn, "in_vault": U128(in_vault),
            "training_runs": runs, "sales": sales, "price": d.price,
            "privacy_audit": d.privacy_audit.as_ref().map(|a| &a.report_hash), "cid_hash": d.cid_hash,
        }).to_string());
        token.metadata = Some(meta);
        token
    }

    fn push_history(&mut self, token_id: &TokenId, event: Event) {
        let entry = HistoryEntry { at_ms: U64(env::block_timestamp_ms()), event };
        let list = self.history.entry(token_id.clone()).or_default();
        if list.len() >= MAX_HISTORY {
            list.remove(0);
        }
        list.push(entry);
    }
}

#[cfg(test)]
mod tests;

/// Escapes text for the SVG card (titles are chosen by publishers).
fn esc(s: &str) -> String {
    s.chars().take(60).map(|c| match c {
        '<' => "&lt;".to_string(),
        '>' => "&gt;".to_string(),
        '&' => "&amp;".to_string(),
        '\'' => "&apos;".to_string(),
        '"' => "&quot;".to_string(),
        c => c.to_string(),
    }).collect()
}

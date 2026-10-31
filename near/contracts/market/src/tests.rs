use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const MARKET: &str = "market.testnet";
const OWNER: &str = "owner.testnet";
const TREASURY: &str = "treasury.testnet";
const ALICE: &str = "alice.testnet"; // publisher, first holder, seller
const BOB: &str = "bob.testnet"; // buyer of the NFT
const CAROL: &str = "carol.testnet"; // data buyer
const RUNNER: &str = "runner.testnet";
const MARKETPLACE: &str = "marketplace.testnet";
const HASH: &str = "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Env {
    now_ms: u64,
}

impl Env {
    fn call(&self, who: &str, deposit: NearToken) {
        self.call_with(who, deposit, vec![]);
    }

    fn call_with(&self, who: &str, deposit: NearToken, results: Vec<PromiseResult>) {
        let ctx = VMContextBuilder::new()
            .current_account_id(acc(MARKET))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(100))
            .block_timestamp(self.now_ms * 1_000_000)
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    fn callback(&self, ok: Option<Vec<u8>>) {
        let r = match ok {
            Some(v) => PromiseResult::Successful(v),
            None => PromiseResult::Failed,
        };
        self.call_with(MARKET, NearToken::from_yoctonear(0), vec![r]);
    }
}

fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn one() -> NearToken {
    yocto(1)
}

fn setup() -> (Env, Market) {
    let env = Env { now_ms: 1_700_000_000_000 };
    env.call(OWNER, yocto(0));
    let hash: Base58CryptoHash = [7u8; 32].into();
    let mut m = Market::new(acc(OWNER), acc(TREASURY), 1_000, hash);
    env.call(OWNER, yocto(0));
    m.register_runner(acc(RUNNER), HASH.to_string(), "mrtd:abc".to_string());
    (env, m)
}

/// Publishes a dataset as Alice and runs the vault callback as a success. Returns the token id.
fn publish(env: &Env, m: &mut Market) -> TokenId {
    env.call(ALICE, Market::publish_deposit());
    let _ = m.publish("Hospital stays".into(), "Fictional sample".into(), "linear_regression".into(), HASH.into(), U128(NearToken::from_near(2).as_yoctonear()));
    let token_id = (m.next_token - 1).to_string();
    env.callback(Some(vec![]));
    let dataset = m.get_dataset(token_id.clone());
    assert!(dataset.is_none());
    let meta = TokenMetadata {
        title: Some("Hospital stays".into()),
        description: Some("Fictional sample".into()),
        media: None,
        media_hash: None,
        copies: Some(1),
        issued_at: None,
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    };
    let d = Dataset {
        vault: format!("ds-{token_id}.{MARKET}").parse().unwrap(),
        publisher: acc(ALICE),
        price: U128(NearToken::from_near(2).as_yoctonear()),
        profile: "linear_regression".into(),
        cid_hash: HASH.into(),
        earned: U128(0),
        withdrawn: U128(0),
        privacy_audit: None,
    };
    assert!(m.on_vault_ready(token_id.clone(), acc(ALICE), meta, d, U128(Market::publish_deposit().as_yoctonear())));
    token_id
}

fn order(env: &Env, m: &mut Market, token_id: &TokenId) -> U64 {
    env.call(CAROL, NearToken::from_near(2));
    m.order(token_id.clone(), "linear_regression".into(), 60)
}

fn transfers_to(receipts: &[near_sdk::mock::Receipt], to: &str) -> u128 {
    receipts
        .iter()
        .filter(|r| r.receiver_id.as_str() == to)
        .flat_map(|r| r.actions.iter())
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

// ---------- publishing ----------

#[test]
fn publish_creates_a_keyless_vault_on_global_code() {
    let (env, mut m) = setup();
    env.call(ALICE, Market::publish_deposit());
    let _ = m.publish("t".into(), "d".into(), "linear_regression".into(), HASH.into(), U128(1));
    let receipts = get_created_receipts();
    let vault = receipts.iter().find(|r| r.receiver_id.as_str() == "ds-1.market.testnet").expect("vault receipt");
    assert!(vault.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(vault.actions.iter().any(|a| matches!(a, MockAction::UseGlobalContract { .. })));
    assert!(!vault.actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. } | MockAction::AddKeyWithFunctionCall { .. })), "a vault must never get an access key");
    assert!(!vault.actions.iter().any(|a| matches!(a, MockAction::DeployContract { .. })));
}

#[test]
fn publish_mints_to_publisher_and_records_history() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    assert_eq!(m.nft_token(id.clone()).unwrap().owner_id, acc(ALICE));
    assert_eq!(m.get_dataset(id.clone()).unwrap().vault.as_str(), "ds-1.market.testnet");
    assert_eq!(m.get_holders(id.clone()), vec![acc(ALICE)]);
    assert!(matches!(m.get_history(id)[0].event, Event::Published { .. }));
}

#[test]
fn failed_vault_refunds_publisher_and_mints_nothing() {
    let (env, mut m) = setup();
    env.call(ALICE, Market::publish_deposit());
    let _ = m.publish("t".into(), "d".into(), "linear_regression".into(), HASH.into(), U128(1));
    env.callback(None);
    let d = Dataset {
        vault: acc("ds-1.market.testnet"),
        publisher: acc(ALICE),
        price: U128(1),
        profile: "linear_regression".into(),
        cid_hash: HASH.into(),
        earned: U128(0),
        withdrawn: U128(0),
        privacy_audit: None,
    };
    let meta = TokenMetadata { title: Some("t".into()), description: None, media: None, media_hash: None, copies: None, issued_at: None, expires_at: None, starts_at: None, updated_at: None, extra: None, reference: None, reference_hash: None };
    let deposit = Market::publish_deposit().as_yoctonear();
    assert!(!m.on_vault_ready("1".into(), acc(ALICE), meta, d, U128(deposit)));
    assert!(m.nft_token("1".into()).is_none());
    assert_eq!(transfers_to(&get_created_receipts(), ALICE), deposit);
}

#[test]
#[should_panic(expected = "Attach the publish deposit")]
fn publish_requires_deposit() {
    let (env, mut m) = setup();
    env.call(ALICE, yocto(1));
    let _ = m.publish("t".into(), "d".into(), "linear_regression".into(), HASH.into(), U128(1));
}

#[test]
#[should_panic(expected = "Only the current holder can do this")]
fn only_holder_sets_price() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(BOB, one());
    m.set_price(id, U128(1));
}

// ---------- withdrawals and transfers ----------

#[test]
fn holder_withdraws_through_the_vault() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    let _ = m.withdraw(id.clone());
    let receipts = get_created_receipts();
    let call = receipts.iter().find(|r| r.receiver_id.as_str() == "ds-1.market.testnet").unwrap();
    let args = call.actions.iter().find_map(|a| match a {
        MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"pay_out" => Some(String::from_utf8(args.clone()).unwrap()),
        _ => None,
    });
    assert_eq!(args.unwrap(), r#"{"receiver_id":"alice.testnet"}"#);
    assert_eq!(m.get_lock(id.clone()), Some(Lock::Withdrawal));
    env.callback(Some(b"\"5000\"".to_vec()));
    assert_eq!(m.on_withdrawn(id.clone(), acc(ALICE)), U128(5000));
    assert_eq!(m.get_lock(id.clone()), None);
    assert_eq!(m.get_dataset(id).unwrap().withdrawn, U128(5000));
}

#[test]
#[should_panic(expected = "Token is locked: withdrawal in progress")]
fn cannot_sell_while_withdrawal_in_flight() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    let _ = m.withdraw(id.clone());
    env.call(ALICE, one());
    m.nft_transfer(acc(BOB), id, None, None);
}

#[test]
fn failed_payout_still_unlocks() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    let _ = m.withdraw(id.clone());
    env.callback(None);
    assert_eq!(m.on_withdrawn(id.clone(), acc(ALICE)), U128(0));
    assert_eq!(m.get_lock(id.clone()), None);
    assert!(matches!(m.get_history(id).last().unwrap().event, Event::WithdrawalFailed { .. }));
}

#[test]
#[should_panic(expected = "Only the current holder can withdraw")]
fn seller_cannot_withdraw_after_sale() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    m.nft_transfer(acc(BOB), id.clone(), None, None);
    env.call(ALICE, one());
    let _ = m.withdraw(id);
}

#[test]
fn sale_moves_rights_and_history() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    m.nft_transfer(acc(BOB), id.clone(), None, None);
    assert!(m.is_holder(id.clone(), acc(BOB)));
    assert!(!m.is_holder(id.clone(), acc(ALICE)));
    assert_eq!(m.get_holders(id.clone()), vec![acc(ALICE), acc(BOB)]);
    env.call(BOB, one());
    m.set_price(id.clone(), U128(7));
    assert_eq!(m.get_dataset(id).unwrap().price, U128(7));
}

#[test]
#[should_panic(expected = "Sender not approved")]
fn withdrawal_revokes_listing() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, NearToken::from_millinear(10));
    m.nft_approve(id.clone(), acc(MARKETPLACE), None);
    env.call(ALICE, one());
    let _ = m.withdraw(id.clone());
    env.callback(Some(b"\"10\"".to_vec()));
    m.on_withdrawn(id.clone(), acc(ALICE));
    // The marketplace tries to fill the old listing.
    env.call(MARKETPLACE, one());
    m.nft_transfer_payout(acc(BOB), id, None, None, U128(1), None);
}

#[test]
fn sale_in_the_middle_of_a_payout_pays_the_buyer() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    // 1. Carol pays a training run while Alice holds the token.
    let o = order(&env, &mut m, &id);
    // 2. Alice sells through a marketplace before the runner delivers.
    env.call(ALICE, NearToken::from_millinear(10));
    m.nft_approve(id.clone(), acc(MARKETPLACE), None);
    env.call(MARKETPLACE, one());
    let payout = m.nft_transfer_payout(acc(BOB), id.clone(), Some(1), None, U128(1_000), Some(10));
    assert_eq!(payout.payout.get(&acc(ALICE)), Some(&U128(1_000)));
    // 3. The runner delivers: the money goes to the vault, never to a person.
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
    let receipts = get_created_receipts();
    let price = NearToken::from_near(2).as_yoctonear();
    assert_eq!(transfers_to(&receipts, "ds-1.market.testnet"), price * 9 / 10);
    assert_eq!(transfers_to(&receipts, TREASURY), price / 10);
    assert_eq!(transfers_to(&receipts, ALICE), 0);
    // 4. Alice cannot touch it, Bob can.
    env.call(BOB, one());
    let _ = m.withdraw(id.clone());
    let pay_out_to = get_created_receipts().iter().flat_map(|r| r.actions.clone()).find_map(|a| match a {
        MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"pay_out" => Some(String::from_utf8(args).unwrap()),
        _ => None,
    });
    assert_eq!(pay_out_to.unwrap(), r#"{"receiver_id":"bob.testnet"}"#);
}

#[test]
#[should_panic(expected = "Only the current holder can withdraw")]
fn sale_in_the_middle_of_a_payout_seller_is_refused() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(ALICE, one());
    m.nft_transfer(acc(BOB), id.clone(), None, None);
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
    env.call(ALICE, one());
    let _ = m.withdraw(id);
}

#[test]
#[should_panic(expected = "Token is locked: transfer in progress")]
fn no_withdrawal_during_transfer_call() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    let _ = m.nft_transfer_call(acc(BOB), id.clone(), None, None, "".into());
    env.call(BOB, one());
    let _ = m.withdraw(id);
}

#[test]
fn reverted_transfer_call_unlocks_and_returns_token() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    let _ = m.nft_transfer_call(acc(BOB), id.clone(), None, None, "".into());
    // The receiver asks for the token back.
    env.callback(Some(b"true".to_vec()));
    assert!(!m.nft_resolve_transfer(acc(ALICE), acc(BOB), id.clone(), Some(HashMap::new())));
    assert_eq!(m.get_lock(id.clone()), None);
    assert!(m.is_holder(id.clone(), acc(ALICE)));
    assert_eq!(m.get_holders(id), vec![acc(ALICE), acc(BOB), acc(ALICE)]);
}

// ---------- orders ----------

#[test]
#[should_panic(expected = "Not a registered runner")]
fn stranger_cannot_deliver() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(ALICE, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
}

#[test]
#[should_panic(expected = "Runner revoked")]
fn revoked_runner_cannot_deliver() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(OWNER, yocto(0));
    m.revoke_runner(acc(RUNNER));
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
}

#[test]
#[should_panic(expected = "Order is not waiting for delivery")]
fn no_double_delivery() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
    m.deliver(o, HASH.into(), HASH.into());
}

#[test]
#[should_panic(expected = "This dataset only accepts its own training profile")]
fn order_needs_the_dataset_profile() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(CAROL, NearToken::from_near(2));
    m.order(id, "logistic_regression".into(), 60);
}

#[test]
#[should_panic(expected = "Attach at least the dataset's price")]
fn order_needs_the_price() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(CAROL, NearToken::from_near(1));
    m.order(id, "linear_regression".into(), 60);
}

#[test]
fn order_refunds_the_excess() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(CAROL, NearToken::from_near(3));
    m.order(id, "linear_regression".into(), 60);
    assert_eq!(transfers_to(&get_created_receipts(), CAROL), NearToken::from_near(1).as_yoctonear());
}

#[test]
#[should_panic(expected = "Deadline not reached")]
fn no_refund_before_deadline() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(CAROL, yocto(0));
    let _ = m.refund(o);
}

#[test]
fn refund_after_deadline() {
    let (mut env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.now_ms += 61 * 60_000;
    env.call(CAROL, yocto(0));
    let _ = m.refund(o);
    assert_eq!(m.get_order(o).unwrap().status, OrderStatus::Refunded);
    assert_eq!(transfers_to(&get_created_receipts(), CAROL), NearToken::from_near(2).as_yoctonear());
}

#[test]
#[should_panic(expected = "Deadline passed")]
fn no_delivery_after_deadline() {
    let (mut env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.now_ms += 61 * 60_000;
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
}

#[test]
#[should_panic(expected = "Only a paid, undelivered order can be refunded")]
fn delivered_order_cannot_be_refunded() {
    let (mut env, mut m) = setup();
    let id = publish(&env, &mut m);
    let o = order(&env, &mut m, &id);
    env.call(RUNNER, yocto(0));
    m.deliver(o, HASH.into(), HASH.into());
    env.now_ms += 61 * 60_000;
    env.call(CAROL, yocto(0));
    let _ = m.refund(o);
}

#[test]
#[should_panic(expected = "Owner only")]
fn only_owner_registers_runners() {
    let (env, mut m) = setup();
    env.call(ALICE, yocto(0));
    m.register_runner(acc(ALICE), HASH.into(), "x".into());
}

#[test]
fn privacy_audit_is_recorded_by_holder() {
    let (env, mut m) = setup();
    let id = publish(&env, &mut m);
    env.call(ALICE, one());
    m.set_privacy_audit(id.clone(), HASH.into(), "some/model".into(), HASH.into());
    assert_eq!(m.get_dataset(id).unwrap().privacy_audit.unwrap().model, "some/model");
}

#!/usr/bin/env bash
# Full Sirius NEAR journey on testnet, with real transactions:
#   publish a fictional dataset (Alice) -> pay a training run (Carol) -> runner delivers -> Alice withdraws
#   -> Alice sells the NFT to Bob -> Carol pays a second run, delivered after the sale
#   -> Alice tries to withdraw (refused) -> Bob withdraws -> the vault has no access key.
#
# Needs near-cli-rs and the accounts below in the legacy keychain (~/.near-credentials/testnet).
# Every transaction id is written to near/scripts/demo-testnet.log.
set -euo pipefail

MARKET=${MARKET:-sirius-ali-market.testnet}
OWNER=${OWNER:-sirius-ali-owner.testnet}
ALICE=${ALICE:-sirius-ali-alice.testnet}
BOB=${BOB:-sirius-ali-bob.testnet}
CAROL=${CAROL:-sirius-ali-carol.testnet}
RUNNER=${RUNNER:-sirius-ali-runner.testnet}
PRICE_YOCTO=${PRICE_YOCTO:-500000000000000000000000} # 0.5 NEAR
HERE=$(cd "$(dirname "$0")" && pwd)
LOG="$HERE/demo-testnet.log"
CSV="$HERE/../examples/hospital-stays-fictional.csv"
: > "$LOG"

say() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }

# call <signer> <method> <json> <deposit> ; prints the return value, logs the transaction id
call() {
  local out tx attempt
  # A transaction without an id was never sent (RPC hiccup): retry it, at most 3 times.
  for attempt in 1 2 3; do
    out=$(near contract call-function as-transaction "$MARKET" "$2" json-args "$3" prepaid-gas '300 Tgas' \
      attached-deposit "$4" sign-as "$1" network-config testnet sign-with-legacy-keychain send 2>&1) || true
    tx=$(grep -o 'Transaction ID: [A-Za-z0-9]*' <<<"$out" | head -1 | cut -d' ' -f3)
    [ -n "$tx" ] && break
    grep -q 'ExecutionError' <<<"$out" && break # refused by the contract: never resend
    sleep 5
  done
  echo "$1 -> $2 $3 | tx $tx" >> "$LOG"
  if grep -qiE 'panicked|Error' <<<"$out"; then
    { grep -oE 'Smart contract panicked: [^"]*' <<<"$out" || grep -m1 -A2 '^Error' <<<"$out"; } | head -3 | tee -a "$LOG"
    return 1
  fi
  sed -n '/return value (printed to stdout)/,/^The "/p' <<<"$out" | sed '1d;$d' | tr -d '\n' | tee -a "$LOG"; echo | tee -a "$LOG"
}

view() {
  local out attempt
  for attempt in 1 2 3; do
    out=$(near contract call-function as-read-only "$1" "$2" json-args "$3" network-config testnet now 2>/dev/null) && break
    sleep 5
  done
  sed -n '/^{\|^\[\|^"\|^[0-9]\|^true\|^false\|^null/,$p' <<<"$out" | sed '/^Here is/,$d'
}

balance() { near account view-account-summary "$1" network-config testnet now 2>/dev/null | grep -o 'Native account balance *[0-9.]* NEAR' | grep -o '[0-9.]* NEAR'; }

say "0. Runner registered by the owner (quote checked off-chain, its hash stored on-chain)"
QUOTE_HASH=$(printf 'demo runner: no TDX quote, see README' | sha256sum | cut -d' ' -f1)
call "$OWNER" register_runner "{\"runner_id\":\"$RUNNER\",\"quote_hash\":\"$QUOTE_HASH\",\"measurement\":\"simulated-local-runner\"}" '0 NEAR' || true

say "1. Alice publishes the fictional dataset: the market creates its vault and mints the NFT"
CID_HASH=$(sha256sum "$CSV" | cut -d' ' -f1)
call "$ALICE" publish "{\"title\":\"Hospital stays (fictional)\",\"description\":\"60 fictional patients, length of stay\",\"profile\":\"linear_regression\",\"cid_hash\":\"$CID_HASH\",\"price\":\"$PRICE_YOCTO\"}" '0.08 NEAR'
TOKEN=$(view "$MARKET" nft_total_supply '{}' | tr -d '"')
VAULT="ds-$TOKEN.$MARKET"
echo "token $TOKEN, vault $VAULT" | tee -a "$LOG"
view "$MARKET" nft_token "{\"token_id\":\"$TOKEN\"}" | tee -a "$LOG"

say "2. The vault has no access key"
near account list-keys "$VAULT" network-config testnet now 2>&1 | grep -iE 'key|empty|no access' | tee -a "$LOG" || true

say "3. Carol pays a training run (0.5 NEAR)"
ORDER1=$(call "$CAROL" order "{\"token_id\":\"$TOKEN\",\"profile\":\"linear_regression\",\"deadline_minutes\":60}" '0.5 NEAR' | tr -d '"')

say "4. The runner delivers: 90% to the vault, 10% to the treasury"
MODEL_HASH=$(printf 'model of order %s' "$ORDER1" | sha256sum | cut -d' ' -f1)
CERT_HASH=$(printf 'certificate of order %s' "$ORDER1" | sha256sum | cut -d' ' -f1)
call "$RUNNER" deliver "{\"order_id\":\"$ORDER1\",\"model_hash\":\"$MODEL_HASH\",\"certificate_hash\":\"$CERT_HASH\"}" '0 NEAR'
echo "vault available: $(view "$VAULT" available '{}')" | tee -a "$LOG"

say "5. Alice withdraws"
echo "alice before: $(balance "$ALICE")" | tee -a "$LOG"
call "$ALICE" withdraw "{\"token_id\":\"$TOKEN\"}" '1 yoctoNEAR'
echo "alice after: $(balance "$ALICE")" | tee -a "$LOG"

say "6. Carol pays a second run, then Alice sells the NFT to Bob before delivery"
ORDER2=$(call "$CAROL" order "{\"token_id\":\"$TOKEN\",\"profile\":\"linear_regression\",\"deadline_minutes\":60}" '0.5 NEAR' | tr -d '"')
call "$ALICE" nft_transfer "{\"receiver_id\":\"$BOB\",\"token_id\":\"$TOKEN\"}" '1 yoctoNEAR'

say "7. Delivery after the sale: the money lands in the vault, which now belongs to Bob"
MODEL_HASH=$(printf 'model of order %s' "$ORDER2" | sha256sum | cut -d' ' -f1)
CERT_HASH=$(printf 'certificate of order %s' "$ORDER2" | sha256sum | cut -d' ' -f1)
call "$RUNNER" deliver "{\"order_id\":\"$ORDER2\",\"model_hash\":\"$MODEL_HASH\",\"certificate_hash\":\"$CERT_HASH\"}" '0 NEAR'
echo "vault available: $(view "$VAULT" available '{}')" | tee -a "$LOG"

say "8. Alice (old holder) tries to withdraw: refused"
if call "$ALICE" withdraw "{\"token_id\":\"$TOKEN\"}" '1 yoctoNEAR'; then echo "UNEXPECTED: Alice could withdraw" | tee -a "$LOG"; exit 1; fi

say "9. Alice tries to call the vault directly: refused"
out=$(near contract call-function as-transaction "$VAULT" pay_out json-args "{\"receiver_id\":\"$ALICE\"}" prepaid-gas '30 Tgas' \
  attached-deposit '0 NEAR' sign-as "$ALICE" network-config testnet sign-with-legacy-keychain send 2>&1 || true)
echo "$ALICE -> $VAULT.pay_out | tx $(grep -o 'Transaction ID: [A-Za-z0-9]*' <<<"$out" | head -1 | cut -d' ' -f3)" >> "$LOG"
grep -oE 'Smart contract panicked: [^"]*' <<<"$out" | head -1 | tee -a "$LOG"

say "10. Bob withdraws"
echo "bob before: $(balance "$BOB")" | tee -a "$LOG"
call "$BOB" withdraw "{\"token_id\":\"$TOKEN\"}" '1 yoctoNEAR'
echo "bob after: $(balance "$BOB")" | tee -a "$LOG"

say "11. History and holders of the NFT"
view "$MARKET" get_dataset "{\"token_id\":\"$TOKEN\"}" | tee -a "$LOG"
view "$MARKET" get_holders "{\"token_id\":\"$TOKEN\"}" | tee -a "$LOG"
view "$MARKET" get_history "{\"token_id\":\"$TOKEN\"}" | tee -a "$LOG"

#!/usr/bin/env bash
# Refunds on the locked market: Carol's orders 1 and 3 were paid but never delivered (the first demo runs, before the
# runner bridge existed) and their deadlines passed. The buyer asks for the refund; the market sends the price back.
# Log: near/scripts/refund-demo.log
#   MARKET=... CAROL=... bash near/scripts/refund-demo.sh
set -uo pipefail
export PATH=$HOME/.cargo/bin:$PATH
MARKET=${MARKET:-sirius-ali-market.testnet}
CAROL=${CAROL:-sirius-ali-carol.testnet}
LOG="$(dirname "$0")/refund-demo.log"
say() { echo "$*" | tee -a "$LOG"; }
clean() { sed 's/\x1b\[[0-9;]*m//g'; }
view() { near contract call-function as-read-only "$MARKET" "$1" json-args "$2" network-config testnet now 2>&1 | clean | sed -n '/^{/,/^}/p' | tr -d '\n '; echo; }

echo "# refund demo $(date -u '+%F %T') UTC on $MARKET" > "$LOG"
for id in 1 3; do
  say ""
  say "== order $id before: $(view get_order "{\"order_id\":\"$id\"}")"
  out=$(near contract call-function as-transaction "$MARKET" refund json-args "{\"order_id\":\"$id\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    sign-as "$CAROL" network-config testnet sign-with-legacy-keychain send 2>&1 | clean)
  say "   refund: $(echo "$out" | grep -o 'Transaction ID: [A-Za-z0-9]*' | head -1)$(echo "$out" | grep -o 'panicked: [^"]*' | head -1)"
  say "   order $id after: $(view get_order "{\"order_id\":\"$id\"}")"
done
say ""
say "== a second refund of order 1 is refused"
out=$(near contract call-function as-transaction "$MARKET" refund json-args '{"order_id":"1"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$CAROL" network-config testnet sign-with-legacy-keychain send 2>&1 | clean)
say "   $(echo "$out" | grep -o 'Transaction ID: [A-Za-z0-9]*' | head -1) $(echo "$out" | grep -o 'Smart contract panicked: [^"\\]*' | head -1)"

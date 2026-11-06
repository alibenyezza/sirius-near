#!/usr/bin/env bash
# On-chain reports and account signals on testnet, with real transactions:
#   1. Carol (the human who funds the agent, a reporter her policy trusts) reports Mallory, with a 0.05 NEAR bond
#      and the evidence of the attack demo -> NFT 5 is blocked by the report.
#   2. Mallory takes revenge and reports Alice -> NFT 1 only gets a warning: Mallory is not a trusted reporter.
#   3. The market owner tries to delete Carol's report -> refused: no one but the reporter can remove a report.
#   4. Mallory retracts her report and gets her bond back -> NFT 1 is as before.
# Requires near-cli (legacy keychain with the demo accounts) and node. Writes every transaction to report-demo.log.
set -euo pipefail

MARKET=${MARKET:-sirius-ali-market.testnet}
CAROL=sirius-ali-carol.testnet
MALLORY=sirius-ali-mallory.testnet
ALICE=sirius-ali-alice.testnet
OWNER=sirius-ali-owner.testnet
HERE=$(cd "$(dirname "$0")" && pwd)
LOG="$HERE/report-demo.log"
AGENT_DIR="$HERE/../agent"
NODE=${NODE:-$(command -v node || command -v node.exe)}
: > "$LOG"
say() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
check() { (cd "$AGENT_DIR" && "$NODE" check.mjs "$1") | tee -a "$LOG"; }

# call <signer> <method> <json args> <deposit>; prints the tx id, or the contract's refusal
call() {
  local out tx
  out=$(near contract call-function as-transaction "$MARKET" "$2" json-args "$3" prepaid-gas '30 Tgas' \
    attached-deposit "$4" sign-as "$1" network-config testnet-fastnear sign-with-legacy-keychain send 2>&1) || true
  tx=$(grep -o 'Transaction ID: [A-Za-z0-9]*' <<<"$out" | head -1 | cut -d' ' -f3)
  if grep -q 'Smart contract panicked' <<<"$out"; then
    echo "   $1 -> $2: refused by the contract: $(grep -oE 'Smart contract panicked: [^"\\]*' <<<"$out" | head -1 | cut -d' ' -f4-)  tx $tx" | tee -a "$LOG"
  else
    echo "   $1 -> $2: ok  tx $tx" | tee -a "$LOG"
  fi
}
reports() {
  near contract call-function as-read-only "$MARKET" get_reports json-args "{\"account_id\":\"$1\"}" \
    network-config testnet-fastnear now 2>/dev/null | grep -E '"(reporter|reason|evidence|bond)"' | sed 's/^/   /' | tee -a "$LOG"
}

echo "# report demo $(date -u +%FT%TZ) on $MARKET" >> "$LOG"

say "0. Before: NFT 5 (published by Mallory in the attack demo) and NFT 1 (Alice)"
check 5
check 1

say "1. Carol reports Mallory on-chain, bond 0.05 NEAR, with the evidence"
call "$CAROL" report "{\"account_id\":\"$MALLORY\",\"reason\":\"dataset description gives payment orders to agents (prompt injection)\",\"evidence\":\"NFT 5 on $MARKET; refused order tx CgtKqWiaJVi2VCg7MFBHUwhoGCPd1RRyKw2emvVzYuW2; near/scripts/attack-demo.log\"}" '0.05 NEAR'
reports "$MALLORY"
check 5

say "2. Mallory reports Alice in revenge (she pays the bond too)"
call "$MALLORY" report "{\"account_id\":\"$ALICE\",\"reason\":\"fake data\",\"evidence\":\"trust me\"}" '0.05 NEAR'
check 1

say "3. The market owner tries to remove Carol's report"
call "$OWNER" retract_report "{\"account_id\":\"$MALLORY\"}" '0 NEAR'
say "   and Mallory tries to report without a bond"
call "$MALLORY" report "{\"account_id\":\"$CAROL\",\"reason\":\"spam\",\"evidence\":\"none\"}" '0 NEAR'

say "4. Mallory retracts her report on Alice and gets the 0.05 NEAR bond back"
call "$MALLORY" retract_report "{\"account_id\":\"$ALICE\"}" '0 NEAR'
check 1

say "Reported accounts on the market"
near contract call-function as-read-only "$MARKET" get_reported_accounts json-args '{}' network-config testnet-fastnear now 2>/dev/null \
  | grep -A3 '^\[' | tee -a "$LOG" || true

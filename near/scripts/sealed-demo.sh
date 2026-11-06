#!/usr/bin/env bash
# The sealed-dataset journey on testnet, with real transactions:
#   Alice seals the CSV to the runner's key -> publishes NFT with cid_hash = sha256(sealed file)
#   -> end-to-end encrypted audit on NEAR AI Cloud (the sample is encrypted to the attested model key)
#   -> Alice records the audit hash in the NFT -> Carol's agent pays a run from its budget over MCP
#   -> the runner opens the sealed file in memory, trains and delivers; the certificate says datasetSealed: true.
#
# Same requirements as demo-testnet.sh, plus the runner seal key (node seal.mjs keygen, on the runner's machine).
# Every transaction id is written to near/scripts/sealed-demo.log. FROM=3 TOKEN=<id> resumes after the publish
# (steps 1-2 must not run again: sealing again makes a new file with another hash).
set -euo pipefail

MARKET=${MARKET:-sirius-ali-market.testnet}
ALICE=${ALICE:-sirius-ali-alice.testnet}
PRICE_YOCTO=${PRICE_YOCTO:-500000000000000000000000} # 0.5 NEAR
HERE=$(cd "$(dirname "$0")" && pwd)
LOG="$HERE/sealed-demo.log"
CSV_REL=../examples/hospital-stays-fictional.csv
AGENT_DIR="$HERE/../agent"
NODE=${NODE:-$(command -v node || command -v node.exe)}
node_agent() { (cd "$AGENT_DIR" && "$NODE" --env-file=.env "$@"); }
FROM=${FROM:-1}
[ "$FROM" = 1 ] && : > "$LOG"
say() { printf '\n== %s\n' "$*" | tee -a "$LOG"; }

call() {
  local out tx attempt
  for attempt in 1 2 3; do
    out=$(near contract call-function as-transaction "$MARKET" "$2" json-args "$3" prepaid-gas '300 Tgas' \
      attached-deposit "$4" sign-as "$1" network-config testnet-fastnear sign-with-legacy-keychain send 2>&1) || true
    tx=$(grep -o 'Transaction ID: [A-Za-z0-9]*' <<<"$out" | head -1 | cut -d' ' -f3)
    [ -n "$tx" ] && break
    grep -q 'ExecutionError' <<<"$out" && break
    sleep 5
  done
  echo "$1 -> $2 | tx $tx" >> "$LOG"
  if grep -qiE 'panicked|Error' <<<"$out"; then
    { grep -oE 'Smart contract panicked: [^"]*' <<<"$out" || grep -m1 -A2 '^Error' <<<"$out"; } | head -3 | tee -a "$LOG"
    return 1
  fi
  sed -n '/return value (printed to stdout)/,/^The "/p' <<<"$out" | sed '1d;$d' | tr -d '\n' | tee -a "$LOG"; echo | tee -a "$LOG"
}

view() { curl -s -X POST https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$MARKET\",\"method_name\":\"$1\",\"args_base64\":\"$(printf '%s' "$2" | base64 -w0)\"}}" | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }

if [ "$FROM" -le 2 ]; then
say "1. Alice seals the dataset to the runner's public key (runner-seal.pub); the sealed file is all she publishes"
node_agent seal.mjs seal "$CSV_REL" | tee -a "$LOG"
node_agent seal.mjs check "$CSV_REL.sealed" | tee -a "$LOG"
CID_HASH=$(sha256sum "$HERE/$CSV_REL.sealed" | cut -d' ' -f1)

say "2. Alice publishes the NFT: cid_hash = sha256 of the sealed file ($CID_HASH)"
call "$ALICE" publish "{\"title\":\"Hospital stays, sealed (fictional)\",\"description\":\"240 fictional patients, length of stay. Sealed to the runner key; audited end-to-end encrypted on NEAR AI Cloud.\",\"profile\":\"linear_regression\",\"cid_hash\":\"$CID_HASH\",\"price\":\"$PRICE_YOCTO\"}" '0.08 NEAR'
TOKEN=$(view nft_total_supply '{}' | tr -d '"')
echo "token $TOKEN, vault ds-$TOKEN.$MARKET" | tee -a "$LOG"
view get_dataset "{\"token_id\":\"$TOKEN\"}" | tee -a "$LOG"
fi
CID_HASH=$(sha256sum "$HERE/$CSV_REL.sealed" | cut -d' ' -f1)

say "3. End-to-end encrypted audit on NEAR AI Cloud, bound to the sealed file's hash"
node_agent privacy-audit.mjs "$CSV_REL" --sealed "$CSV_REL.sealed" --token "$TOKEN" --holder "$ALICE" > "$HERE/sealed-audit.out"
grep -vE '^  PASS  \[model\] GPU-[1-7]' "$HERE/sealed-audit.out" | sed '/^Record it in NFT/,$d' | tee -a "$LOG"
AUDIT_HASH=$(grep -o 'Audit hash [0-9a-f]*' "$HERE/sealed-audit.out" | cut -d' ' -f3)
MODEL=$(grep -o 'Attestation of [^ ]*' "$HERE/sealed-audit.out" | head -1 | cut -d' ' -f3)
NONCE=$(grep -o 'with a fresh nonce [0-9a-f]*' "$HERE/sealed-audit.out" | head -1 | awk '{print $5}')
rm -f "$HERE/sealed-audit.out"

say "4. Alice records the audit hash in the NFT"
call "$ALICE" set_privacy_audit "{\"token_id\":\"$TOKEN\",\"report_hash\":\"$AUDIT_HASH\",\"model\":\"$MODEL\",\"nonce\":\"$NONCE\"}" '1 yoctoNEAR'

say "5. Carol's agent checks the NFT and pays a run from its budget, over MCP"
node_agent agent-demo.mjs "$TOKEN" 0.6 | tee "$HERE/agent-demo.out" | tee -a "$LOG"
ORDER=$(grep -o '"orderId": "[0-9]*"' "$HERE/agent-demo.out" | head -1 | grep -o '[0-9]*')
rm -f "$HERE/agent-demo.out"

say "6. The runner finds the sealed file by its hash, opens it in memory, trains and delivers order $ORDER"
node_agent runner-bridge.mjs --order "$ORDER" | tee -a "$LOG"
node_agent -e "const c=JSON.parse(require('fs').readFileSync('out/order-$ORDER.json','utf8')).certificate;console.log(JSON.stringify({datasetSealed:c.datasetSealed,sealKey:c.sealKey,sealFormat:c.sealFormat,mode:c.mode,modelHash:c.modelHash},null,1))" | tee -a "$LOG"

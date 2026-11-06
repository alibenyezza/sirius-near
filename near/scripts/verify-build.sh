#!/usr/bin/env bash
# Rebuild the market contract from this repository in a pinned container and compare it with the code deployed on
# sirius-ali-market.testnet. Needs Docker, curl and python3. Run from anywhere inside the repository.
#
# The vault is checked differently (see the README, "Verify the deployed code"): its global code was built before the
# builds were pinned and does not rebuild byte for byte; this script prints its hash and the four methods it exports.
set -euo pipefail

IMAGE='sourcescan/cargo-near:0.22.0-rust-1.98.1@sha256:90cf2abe31d75946d82f1c6eee70802332b4d499ac39c01a5c41f228000ecb8a'
MARKET=${MARKET:-sirius-ali-market.testnet}
RPC=${RPC:-https://rpc.testnet.fastnear.com}
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
OUT=$ROOT/near/contracts/target/near/sirius_market/sirius_market.wasm

rpc() { curl -s "$RPC" -H 'content-type: application/json' -d "$1"; }
b58() { python3 -c "import sys
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n=int(sys.argv[1],16); s=''
while n: n,r=divmod(n,58); s=A[r]+s
print(s)" "$1"; }

echo "Building the market at commit $(git -C "$ROOT" rev-parse --short HEAD) in $IMAGE"
MOUNT=$ROOT
if command -v cygpath >/dev/null; then MOUNT=$(cygpath -m "$ROOT"); export MSYS_NO_PATHCONV=1; fi # Git Bash on Windows
BUILD_LOG=$(mktemp)
docker run --rm -v "$MOUNT:/home/near/code" -w /home/near/code/near/contracts/market "$IMAGE" \
  cargo near build non-reproducible-wasm --locked > "$BUILD_LOG" 2>&1 || { tail -20 "$BUILD_LOG"; exit 1; }
local_sha=$(sha256sum "$OUT" | cut -d' ' -f1)
local_hash=$(b58 "$local_sha")
chain_hash=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$MARKET\"}}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["code_hash"])')
echo "built    sha256 $local_sha  code hash $local_hash"
echo "deployed                                                                     code hash $chain_hash"
if [ "$local_hash" = "$chain_hash" ]; then echo "MATCH: the market runs this source"; else echo "DIFFERENT"; exit 1; fi

echo
echo "Vault global code (by hash, immutable)"
vault=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$MARKET\",\"method_name\":\"get_config\",\"args_base64\":\"e30=\"}}" \
  | python3 -c 'import sys,json; print(json.loads(bytes(json.load(sys.stdin)["result"]["result"]))["vault_code_hash"])')
rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_global_contract_code\",\"finality\":\"final\",\"code_hash\":\"$vault\"}}" \
  | python3 -c 'import sys,json,base64,hashlib
code=base64.b64decode(json.load(sys.stdin)["result"]["code_base64"])
print("vault code hash", sys.argv[1], " sha256", hashlib.sha256(code).hexdigest(), len(code), "bytes")
# list exported functions from the wasm export section (id 7)
i=8; ex=[]
def leb(b,i):
    r=s=0
    while True:
        x=b[i]; i+=1; r|=(x&127)<<s; s+=7
        if x<128: return r,i
while i<len(code):
    sid=code[i]; i+=1; size,i=leb(code,i); end=i+size
    if sid==7:
        n,j=leb(code,i)
        for _ in range(n):
            l,j=leb(code,j); name=code[j:j+l].decode(); j+=l; kind=code[j]; j+=1; _,j=leb(code,j)
            if kind==0: ex.append(name)
    i=end
print("vault exports:", ", ".join(ex), "(source: near/contracts/vault/src/lib.rs, extern \"C\" fns)")' "$vault"

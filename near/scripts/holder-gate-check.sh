#!/usr/bin/env bash
# The holder page with real NEP-413 signatures from near-cli: the current holder gets in, the previous holder and a
# replayed challenge are refused. Start the web server first (cd near/agent && node web.mjs).
#   TOKEN=4 HOLDER=sirius-ali-bob.testnet SELLER=sirius-ali-alice.testnet bash near/scripts/holder-gate-check.sh
# Under WSL with the server on Windows, use CURL=curl.exe.
set -euo pipefail
BASE=${BASE:-http://localhost:4320}
TOKEN=${TOKEN:-4}
HOLDER=${HOLDER:-sirius-ali-bob.testnet}
SELLER=${SELLER:-sirius-ali-alice.testnet}
CURL=${CURL:-curl}

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

sign() { # sign <account> <message> <nonce> -> JSON {accountId, publicKey, signature}
  near message sign-nep413 utf8 "$2" nonce "$3" recipient sirius-near sign-as "$1" sign-with-legacy-keychain \
    network-config testnet 2>/dev/null | sed -n '/^{/,/^}/p' | tr -d '\n '
}

try() { # try <account> ; prints the server's answer
  local ch nonce message signed
  ch=$($CURL -s -X POST "$BASE/api/holder/$TOKEN/challenge")
  nonce=$(field nonce <<<"$ch"); message=$(field message <<<"$ch")
  signed=$(sign "$1" "$message" "$nonce")
  LAST_BODY="{\"signed\":$signed,\"nonce\":\"$nonce\"}"
  $CURL -s -X POST "$BASE/api/holder/$TOKEN" -H 'content-type: application/json' -d "$LAST_BODY"; echo
}

echo "== current holder $HOLDER"; try "$HOLDER"
echo "== same signed challenge sent again (replay)"; $CURL -s -X POST "$BASE/api/holder/$TOKEN" -H 'content-type: application/json' -d "$LAST_BODY"; echo
echo "== previous holder $SELLER"; try "$SELLER"

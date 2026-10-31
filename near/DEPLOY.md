# Deploying Sirius on NEAR testnet

Commands as run for the live deployment. Replace the account names with yours.

```bash
# 1. Build (wasm32 target and cargo-near needed)
cd near/contracts
(cd vault && cargo near build non-reproducible-wasm --no-abi)
(cd market && cargo near build non-reproducible-wasm)

# 2. Accounts (each gets 10 testnet NEAR from the faucet)
for a in sirius-ali-market sirius-ali-owner sirius-ali-alice sirius-ali-bob sirius-ali-carol sirius-ali-runner; do
  near account create-account sponsor-by-faucet-service $a.testnet autogenerate-new-keypair \
    save-to-legacy-keychain network-config testnet create
done

# 3. Publish the vault code once, as an immutable global contract (burns ~3.5 NEAR for 35 KB)
near contract deploy-as-global use-file target/near/sirius_vault/sirius_vault.wasm \
  as-global-hash sirius-ali-owner.testnet network-config testnet sign-with-legacy-keychain send
# Its hash is the base58 sha256 of the wasm file:
python3 -c "import hashlib,sys;h=hashlib.sha256(open(sys.argv[1],'rb').read()).digest();A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(h,'big');s=''
while n: n,r=divmod(n,58);s=A[r]+s
print(s)" target/near/sirius_vault/sirius_vault.wasm

# 4. Deploy and initialize the market (fee and vault hash are fixed at init)
near contract deploy sirius-ali-market.testnet use-file target/near/sirius_market/sirius_market.wasm \
  with-init-call new json-args '{"owner_id":"sirius-ali-owner.testnet","treasury_id":"sirius-ali-owner.testnet","fee_bps":1000,"vault_code_hash":"<hash from step 3>"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send

# 5. Run the journey
bash near/scripts/demo-testnet.sh
```

`target/` is wherever `CARGO_TARGET_DIR` points; `cargo near build` prints the path of each `.wasm`.

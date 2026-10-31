// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SiriusOpenKybRegistry
/// @notice A KYB registry that accepts everyone. For demonstration deployments only.
///
/// @dev Why this contract exists, stated plainly so nobody mistakes it for the real one.
///
/// `SiriusEscrow` and `SiriusDatasetRegistry` hold their registry address in an
/// `immutable` field: a deployment cannot be repointed afterwards. Running a public
/// demonstration without business verification therefore requires giving those
/// contracts a different registry at construction — not editing them. Their source,
/// and so their bytecode, is untouched.
///
/// Every account is valid, forever. There is no admin, no verifier, no revocation and
/// no expiry: the surface is deliberately too small to be mistaken for the real
/// registry, and there is nothing here to govern.
///
/// Restoring real KYB means redeploying the same escrow and dataset registry against
/// `SiriusKybRegistry`. No application code changes in either direction — the callers
/// only ever ask `isKybValid`.
///
/// Deploying this on a network where the escrow moves real value would remove the only
/// on-chain control over who may lend and borrow. `deploy.ts` refuses it outside a
/// testnet.
contract SiriusOpenKybRegistry {
    /// @dev Field-for-field identical to `SiriusKybRegistry.Attestation`, so that
    ///      callers decoding the response cannot tell the two apart structurally.
    struct Attestation {
        address verifier;
        uint40 issuedAt;
        uint40 expiresAt;
        uint64 verifierEpoch;
        bool revoked;
    }

    /// @notice 1 January 2100. Far enough that no attestation ever lapses here.
    uint40 public constant OPEN_EXPIRY = 4102444800;

    /// @notice Always true. That is the entire point of this contract.
    function isKybValid(address) external pure returns (bool) {
        return true;
    }

    /// @dev Names this contract as the verifier rather than the zero address: a reader
    ///      of the stored credential can then see exactly which registry vouched, and
    ///      that it was this one.
    function attestationOf(address) external view returns (Attestation memory) {
        return Attestation({
            verifier: address(this),
            issuedAt: 0,
            expiresAt: OPEN_EXPIRY,
            verifierEpoch: 1,
            revoked: false
        });
    }

    /// @dev Present only so that a caller written against the real registry does not
    ///      revert. Nothing here consumes a nonce.
    function nonces(address) external pure returns (uint256) {
        return 0;
    }
}

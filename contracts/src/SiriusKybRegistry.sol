// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SiriusKybRegistry
/// @notice On-chain KYB registry for Sirius.
///
///         One credential per **entity**, never per role: the same address can be a provider
///         and a borrower with a single KYB, and it is the *action* that carries the role.
///         Gating is blocking — no valid credential, no dataset listing and no borrowing.
///
/// @dev CONSENT IS PRESERVED
///      Every entry point requires a signature from the subject, or the subject's own
///      transaction. A verifier can never unilaterally stamp an address.
///
/// @dev NO ATTESTATION SERVICE ON THIS CHAIN
///      EAS is not deployed on Robinhood Chain — checked at its three canonical addresses —
///      and there is no ERC-3643 identity layer either. Hence a purpose-built registry. The
///      cost is that this is a silo: no third party can reuse these attestations without
///      importing this interface.
contract SiriusKybRegistry {
    // ---------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------

    /// @param verifier  Who attested. Validity follows this verifier's own authorisation.
    /// @param issuedAt  Unix seconds, informational.
    /// @param expiresAt Unix seconds.
    /// @param revoked   Set by the issuing verifier; terminal for this attestation.
    struct Attestation {
        address verifier; // 20 bytes ┐
        uint40 issuedAt; //   5 bytes │
        uint40 expiresAt; //  5 bytes │
        uint64 verifierEpoch;
        bool revoked;
    }

    // ---------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------

    string public constant VERSION = "sirius-kyb-v3";

    /// @dev EIP-712. The domain embeds `chainId` and `verifyingContract`, so an attestation
    ///      signed for the testnet registry can never be replayed against the mainnet one —
    ///      the separation the escrow preimage still lacks.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("KybAttestation(address subject,address verifier,uint40 expiresAt,uint256 nonce,uint64 verifierEpoch)");

    /// @dev Magic value returned by a compliant contract signer (ERC-1271).
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    /// @notice Longest credential lifetime, so a stale attestation cannot outlive its review.
    uint40 public constant MAX_VALIDITY = 730 days;

    // ---------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------

    /// @notice Current administrator. Adds and removes verifiers.
    address public admin;

    /// @notice Pending administrator, must call {acceptAdmin}.
    /// @dev Two-step transfer: a typo in a one-step `transferAdmin` would brick the registry,
    ///      and there is no recovery path.
    address public pendingAdmin;

    /// @notice Addresses currently allowed to attest.
    mapping(address => bool) public isVerifier;

    /// @notice Version of a verifier's authorization. Re-adding it never revives old KYB.
    mapping(address => uint64) public verifierEpoch;

    /// @notice One attestation per entity — the credential is per entity, not per role.
    mapping(address => Attestation) private _attestations;

    /// @notice Consumed signature nonce, per subject. Prevents replaying a revoked credential.
    mapping(address => uint256) public nonces;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    event KybAttested(address indexed subject, address indexed verifier, uint40 expiresAt, uint256 nonce);
    event KybRevoked(address indexed subject, address indexed verifier);

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error NotAdmin();
    error NotPendingAdmin();
    error NotVerifier();
    error ZeroAddress();
    error AlreadyVerifier();
    error UnknownVerifier();
    error InvalidExpiry();
    error InvalidSubjectSignature();
    error InvalidVerifierSignature();
    error NoAttestation();
    error NotIssuingVerifier();
    error AlreadyRevoked();

    // ---------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------

    constructor(address admin_, address firstVerifier) {
        if (admin_ == address(0) || firstVerifier == address(0)) revert ZeroAddress();
        admin = admin_;
        isVerifier[firstVerifier] = true;
        verifierEpoch[firstVerifier] = 1;
        emit AdminTransferred(address(0), admin_);
        emit VerifierAdded(firstVerifier);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ---------------------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------------------

    function addVerifier(address verifier) external onlyAdmin {
        if (verifier == address(0)) revert ZeroAddress();
        if (isVerifier[verifier]) revert AlreadyVerifier();
        isVerifier[verifier] = true;
        unchecked {
            verifierEpoch[verifier] += 1;
        }
        emit VerifierAdded(verifier);
    }

    /// @notice Remove a verifier. Every credential it issued stops being valid immediately.
    /// @dev Deliberate: if a verifier is dropped because it was compromised or lost its
    ///      accreditation, its past attestations are exactly what must stop counting.
    function removeVerifier(address verifier) external onlyAdmin {
        if (!isVerifier[verifier]) revert UnknownVerifier();
        isVerifier[verifier] = false;
        emit VerifierRemoved(verifier);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(msg.sender, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, msg.sender);
    }

    // ---------------------------------------------------------------------------------
    // Attestation
    // ---------------------------------------------------------------------------------

    /// @notice The subject claims a credential a verifier signed off-chain.
    /// @dev The gasless path for the verifier, and the natural port of `CredentialAccept`:
    ///      the verifier's authority is expressed by its signature, the subject's consent by
    ///      the fact that it is the one sending the transaction.
    function acceptAttestation(address verifier, uint40 expiresAt, bytes calldata verifierSignature)
        external
    {
        _assertExpiry(expiresAt);
        if (!isVerifier[verifier]) revert NotVerifier();

        uint256 nonce = nonces[msg.sender];
        bytes32 digest = attestationDigest(msg.sender, verifier, expiresAt, nonce);
        if (!_isValidSignature(verifier, digest, verifierSignature)) revert InvalidVerifierSignature();

        _record(msg.sender, verifier, expiresAt, nonce);
    }

    /// @notice A verifier registers a credential the subject signed off-chain.
    /// @dev Mirror image, for when Sirius sponsors the gas. Consent is still explicit — the
    ///      subject's signature over the same digest.
    function attestWithConsent(address subject, uint40 expiresAt, bytes calldata subjectSignature)
        external
    {
        _assertExpiry(expiresAt);
        if (!isVerifier[msg.sender]) revert NotVerifier();
        if (subject == address(0)) revert ZeroAddress();

        uint256 nonce = nonces[subject];
        bytes32 digest = attestationDigest(subject, msg.sender, expiresAt, nonce);
        if (!_isValidSignature(subject, digest, subjectSignature)) revert InvalidSubjectSignature();

        _record(subject, msg.sender, expiresAt, nonce);
    }

    /// @notice Revoke a credential. Only the verifier that issued it.
    function revoke(address subject) external {
        Attestation storage attestation = _attestations[subject];
        if (attestation.verifier == address(0)) revert NoAttestation();
        if (attestation.verifier != msg.sender) revert NotIssuingVerifier();
        if (attestation.revoked) revert AlreadyRevoked();

        attestation.revoked = true;
        // Burning the nonce stops the very same signed attestation from being replayed.
        unchecked {
            nonces[subject] += 1;
        }
        emit KybRevoked(subject, msg.sender);
    }

    // ---------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------

    /// @notice The single gate other Sirius contracts and the backend call.
    /// @dev Four conditions, all required: an attestation exists, it is not revoked, it has
    ///      not expired, and the verifier that issued it is *still* authorised.
    function isKybValid(address subject) public view returns (bool) {
        Attestation storage attestation = _attestations[subject];
        if (attestation.verifier == address(0) || attestation.revoked) return false;
        if (block.timestamp >= attestation.expiresAt) return false;
        return isVerifier[attestation.verifier]
            && attestation.verifierEpoch == verifierEpoch[attestation.verifier];
    }

    function attestationOf(address subject) external view returns (Attestation memory) {
        return _attestations[subject];
    }

    /// @notice Digest a verifier or subject signs. Exposed so clients never rebuild it by hand.
    function attestationDigest(address subject, address verifier, uint40 expiresAt, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(ATTESTATION_TYPEHASH, subject, verifier, expiresAt, nonce, verifierEpoch[verifier]));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @dev Computed on each call rather than cached: a cached separator becomes wrong after a
    ///      chain fork, and this contract is cheap enough that the saving is not worth the bug.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("SiriusKybRegistry")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------

    function _assertExpiry(uint40 expiresAt) private view {
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_VALIDITY) {
            revert InvalidExpiry();
        }
    }

    function _record(address subject, address verifier, uint40 expiresAt, uint256 nonce) private {
        _attestations[subject] = Attestation({
            verifier: verifier,
            issuedAt: uint40(block.timestamp),
            expiresAt: expiresAt,
            verifierEpoch: verifierEpoch[verifier],
            revoked: false
        });
        unchecked {
            nonces[subject] = nonce + 1;
        }
        emit KybAttested(subject, verifier, expiresAt, nonce);
    }

    /// @dev Accepts an EOA signature, then falls back to ERC-1271 for contract signers.
    ///      Robinhood Chain ships all three ERC-4337 EntryPoints and pushes smart accounts,
    ///      so refusing them would exclude a large part of its intended audience.
    ///
    ///      Note for the enclave: this fallback performs a `staticcall`. It is fine here —
    ///      this contract is only ever read from Next — but the runner must never depend on
    ///      an ERC-1271 path, since that would require network egress from the TEE.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 0x20))
                v := byte(0, calldataload(add(signature.offset, 0x40)))
            }
            // Reject the malleable upper half of the curve order, and the v values that
            // `ecrecover` would silently turn into address(0).
            if (
                uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
                    && (v == 27 || v == 28)
            ) {
                address recovered = ecrecover(digest, v, r, s);
                if (recovered != address(0) && recovered == signer) return true;
            }
        }

        if (signer.code.length == 0) return false;
        (bool ok, bytes memory returned) =
            signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
        return ok && returned.length == 32 && abi.decode(returned, (bytes4)) == ERC1271_MAGIC;
    }
}

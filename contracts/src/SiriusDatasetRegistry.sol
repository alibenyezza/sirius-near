// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SiriusKybRegistry} from "./SiriusKybRegistry.sol";

interface ISiriusDatasetEscrow {
    function activeLoansForDataset(bytes32 datasetId) external view returns (uint256);
}

/// @title SiriusDatasetRegistry
/// @notice On-chain title of a dataset.
///
///         A provider mints a non-transferable title carrying the dataset's identity: its
///         CID hash, its Merkle root and its size. Deleting it — the crypto-shredding step,
///         where the decryption key is destroyed and the data becomes unrecoverable — leaves
///         a tombstone rather than erasing the record, because the audit trail is the point.
///
/// @dev A PURE REGISTRY, NOT AN ERC-721
///      A soulbound ERC-721 was the obvious candidate, but every one of its interfaces would
///      be a lie here: no `transferFrom`, no `approve`, no `setApprovalForAll`, and wallets
///      would still display the title as a tradable collectible. ERC-5192 exists precisely to
///      announce that the transfer half of the standard is disabled. Rather than ship a
///      standard whose main verb is forbidden, this is a registry that says what it is.
///
/// @dev DETERMINISTIC IDENTIFIER
///      `datasetIdOf` derives the on-chain id from the application's cuid, so the id is known
///      before the transaction is sent.
///
/// @dev ⚠ GDPR — WHAT MUST NEVER BE WRITTEN HERE
///      Events on this chain are permanent and end up posted as blobs on Ethereum L1. The
///      dataset *name* and *description* are therefore deliberately absent from this contract:
///      they are free-form fields a provider could fill with personal data, and no erasure
///      would ever be possible. Only the CID, the Merkle root and the size are recorded — all
///      three opaque digests of already-encrypted content. The CID itself stays off-chain.
///      The right to erasure remains served by crypto-shredding: destroying the per-dataset
///      key makes the data unrecoverable. It is never served by an on-chain operation, and the
///      product copy must keep saying so — the title's trace survives, by design.
contract SiriusDatasetRegistry {
    // ---------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------

    struct Dataset {
        address provider; // 20 bytes ┐
        uint40 mintedAt; //   5 bytes │
        uint40 destroyedAt; // 5 bytes ┘ slot 0 — zero while live
        uint64 sizeBytes; //            slot 1
        bytes32 merkleRoot; //          slot 2
        bytes32 cidHash; //             slot 3
        bytes32 trainingProfile; //     slot 4
    }

    // ---------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------

    string public constant VERSION = "sirius-dataset-v4";

    bytes32 public constant DATASET_ID_DOMAIN = keccak256("sirius.dataset.id.v1");
    bytes32 public constant LINEAR_REGRESSION_V1_PROFILE =
        keccak256("sirius.training-profile.v1:linear_regression:1.0.0");
    bytes32 public constant LOGISTIC_REGRESSION_V1_PROFILE =
        keccak256("sirius.training-profile.v1:logistic_regression:1.0.0");

    /// @notice Ceiling mirroring `MAX_DATASET_BYTES` in the application (16 MiB).
    uint64 public constant MAX_SIZE_BYTES = 16 * 1024 * 1024;

    // ---------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------

    /// @notice KYB gate. Immutable: repointing it would silently redefine who may publish.
    SiriusKybRegistry public immutable kyb;
    address public immutable admin;
    ISiriusDatasetEscrow public escrow;

    mapping(bytes32 => Dataset) private _datasets;

    /// @notice Number of live titles per provider, for cheap dashboard reads.
    mapping(address => uint256) public liveCount;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event DatasetMinted(
        bytes32 indexed datasetId,
        address indexed provider,
        bytes32 cidHash,
        bytes32 merkleRoot,
        uint64 sizeBytes,
        bytes32 trainingProfile
    );

    /// @notice The title was tombstoned after crypto-shredding.
    event DatasetDestroyed(bytes32 indexed datasetId, address indexed provider, uint40 destroyedAt);
    event EscrowBound(address indexed escrow);

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error KybRequired();
    error DatasetExists(bytes32 datasetId);
    error UnknownDataset(bytes32 datasetId);
    error NotProvider();
    error AlreadyDestroyed();
    error EmptyDatasetId();
    error InvalidCid();
    error InvalidMerkleRoot();
    error InvalidSize();
    error InvalidTrainingProfile();
    error ZeroAddress();
    error NotAdmin();
    error EscrowAlreadyBound();
    error DatasetInUse(bytes32 datasetId, uint256 activeLoans);

    // ---------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------

    constructor(SiriusKybRegistry kyb_, address admin_) {
        if (address(kyb_) == address(0)) revert KybRequired();
        if (admin_ == address(0)) revert ZeroAddress();
        kyb = kyb_;
        admin = admin_;
    }

    function bindEscrow(ISiriusDatasetEscrow escrow_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (address(escrow) != address(0)) revert EscrowAlreadyBound();
        if (address(escrow_) == address(0) || address(escrow_).code.length == 0) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowBound(address(escrow_));
    }

    // ---------------------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------------------

    /// @notice Deterministic on-chain id of a dataset.
    /// @dev Namespaced by provider so two providers can never collide on the same cuid, and
    ///      so nobody can pre-empt an id another provider will need.
    function datasetIdOf(address provider, bytes32 datasetIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(DATASET_ID_DOMAIN, provider, datasetIdHash));
    }

    // ---------------------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------------------

    /// @notice Publish a dataset title. Requires a valid KYB — the gate is blocking.
    function mint(bytes32 datasetIdHash, bytes32 cidHash, bytes32 merkleRoot, uint64 sizeBytes, bytes32 trainingProfile)
        external
        returns (bytes32 id)
    {
        if (!kyb.isKybValid(msg.sender)) revert KybRequired();
        if (datasetIdHash == bytes32(0)) revert EmptyDatasetId();
        if (cidHash == bytes32(0)) revert InvalidCid();
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (sizeBytes == 0 || sizeBytes > MAX_SIZE_BYTES) revert InvalidSize();
        if (!isSupportedTrainingProfile(trainingProfile)) revert InvalidTrainingProfile();

        id = datasetIdOf(msg.sender, datasetIdHash);
        Dataset storage dataset = _datasets[id];
        if (dataset.provider != address(0)) revert DatasetExists(id);

        dataset.provider = msg.sender;
        dataset.mintedAt = uint40(block.timestamp);
        dataset.sizeBytes = sizeBytes;
        dataset.merkleRoot = merkleRoot;
        dataset.cidHash = cidHash;
        dataset.trainingProfile = trainingProfile;

        unchecked {
            liveCount[msg.sender] += 1;
        }

        emit DatasetMinted(id, msg.sender, cidHash, merkleRoot, sizeBytes, trainingProfile);
    }

    // ---------------------------------------------------------------------------------
    // Destroy
    // ---------------------------------------------------------------------------------

    /// @notice Tombstone a title after crypto-shredding. Provider only.
    /// @dev No KYB check on the way out. A provider whose credential expired or was revoked
    ///      must still be able to destroy its own titles — tying erasure to a live credential
    ///      would turn a compliance lapse into an inability to comply.
    ///
    ///      The record is kept, not deleted. That is the audit feature the product already
    ///      promises: the data becomes unrecoverable, the trace remains.
    function destroy(bytes32 datasetIdHash) external returns (bytes32 id) {
        id = datasetIdOf(msg.sender, datasetIdHash);
        Dataset storage dataset = _datasets[id];
        if (dataset.provider == address(0)) revert UnknownDataset(id);
        if (dataset.provider != msg.sender) revert NotProvider();
        if (dataset.destroyedAt != 0) revert AlreadyDestroyed();
        uint256 activeLoans = address(escrow) == address(0) ? 0 : escrow.activeLoansForDataset(id);
        if (activeLoans != 0) revert DatasetInUse(id, activeLoans);

        dataset.destroyedAt = uint40(block.timestamp);
        unchecked {
            liveCount[msg.sender] -= 1;
        }

        emit DatasetDestroyed(id, msg.sender, dataset.destroyedAt);
    }

    // ---------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------

    function getDataset(bytes32 id) external view returns (Dataset memory) {
        return _datasets[id];
    }

    /// @notice True while the title exists and has not been tombstoned.
    function isLive(bytes32 id) external view returns (bool) {
        Dataset storage dataset = _datasets[id];
        return dataset.provider != address(0) && dataset.destroyedAt == 0;
    }

    function isLiveForProvider(bytes32 id, address provider) external view returns (bool) {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0;
    }

    function isSupportedTrainingProfile(bytes32 trainingProfile) public pure returns (bool) {
        return trainingProfile == LINEAR_REGRESSION_V1_PROFILE || trainingProfile == LOGISTIC_REGRESSION_V1_PROFILE;
    }

    function isLiveForProviderAndProfile(bytes32 id, address provider, bytes32 trainingProfile)
        external
        view
        returns (bool)
    {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0 && dataset.trainingProfile == trainingProfile;
    }

    /// @notice Confirm a title matches what the runner holds, before it decrypts anything.
    /// @dev The counterpart of `matchesScope` on the escrow: one call, no history scan.
    function matchesScope(bytes32 id, address provider, bytes32 merkleRoot, bytes32 cidHash, bytes32 trainingProfile)
        external
        view
        returns (bool)
    {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0
            && dataset.merkleRoot == merkleRoot && dataset.cidHash == cidHash
            && dataset.trainingProfile == trainingProfile;
    }
}

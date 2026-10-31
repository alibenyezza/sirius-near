// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SiriusKybRegistry} from "./SiriusKybRegistry.sol";
import {SiriusDatasetRegistry} from "./SiriusDatasetRegistry.sol";

interface IERC20 {
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SiriusEscrow
/// @notice Hashlock escrow in USDC for a Sirius confidential training loan.
/// @dev The deployed USDC address is immutable. There is no owner, proxy or upgrade path.
contract SiriusEscrow {
    enum Status { None, Locked, Released, Refunded }

    struct Loan {
        address provider;
        uint96 amount;
        address borrower;
        uint40 deadline;
        Status status;
        bytes32 hashlock;
        bytes32 preimage;
        bytes32 datasetId;
        bytes32 trainingProfile;
    }

    struct LockAuthorization {
        uint40 deadline;
        bytes signature;
    }

    string public constant VERSION = "sirius-escrow-usdc-v6";
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant LOCK_AUTHORIZATION_TYPEHASH =
        keccak256("LockAuthorization(bytes32 termsHash,uint40 deadline)");
    bytes32 public constant LOAN_KEY_DOMAIN = keccak256("sirius.escrow.loanKey.v1");
    uint8 public constant MIN_CHALLENGE_DAYS = 1;
    uint8 public constant MAX_CHALLENGE_DAYS = 30;
    /// @notice Smallest lockable amount: 0.001 token, derived from the token's own precision.
    /// @dev Kept in this casing because it is part of the published ABI. It cannot be a
    /// constant: USDC exposes 6 decimals on some networks and 18 on others, so a literal
    /// would mean a dust floor on one network and a fortune on the other — with no error
    /// raised either way.
    uint256 public immutable MIN_AMOUNT;
    uint256 internal constant MAX_AMOUNT = type(uint96).max;
    bytes32 internal constant ZERO_PREIMAGE_HASH =
        0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925;

    IERC20 public immutable usdc;
    SiriusKybRegistry public immutable kyb;
    SiriusDatasetRegistry public immutable datasets;
    address public immutable lockAuthorizer;
    mapping(bytes32 => Loan) private _loans;
    mapping(bytes32 => uint256) private _activeLoansForDataset;
    mapping(address => uint256) private _credit;
    uint256 public lockedUsdc;
    uint256 public owedUsdc;
    uint64 public eventSeq;
    uint8 private _guard;

    event LoanLocked(
        bytes32 indexed loanKey,
        address indexed borrower,
        address indexed provider,
        uint256 amount,
        uint40 deadline,
        bytes32 hashlock,
        bytes32 trainingProfile,
        uint64 seq
    );
    event LoanReleased(
        bytes32 indexed loanKey,
        address indexed provider,
        address indexed caller,
        bytes32 preimage,
        uint256 amount,
        uint64 seq
    );
    event PreimageRevealed(bytes32 indexed hashlock, bytes32 indexed loanKey, bytes32 preimage);
    event LoanRefunded(bytes32 indexed loanKey, address indexed borrower, uint256 amount, uint64 seq);
    event CreditAccrued(address indexed account, bytes32 indexed loanKey, uint256 amount, uint256 balance);
    event Withdrawn(address indexed account, uint256 amount);

    error Reentrancy();
    error ZeroAddress();
    error InvalidUsdcContract();
    error UnsupportedUsdcDecimals(uint8 tokenDecimals);
    error ZeroAmount();
    error AmountTooSmall();
    error AmountOverflow();
    error InvalidProvider();
    error SelfDealing();
    error InvalidHashlock();
    error InvalidChallengePeriod();
    error InvalidLoanId();
    error KybRequired();
    error LoanExists(bytes32 loanKey);
    error LoanNotLocked(bytes32 loanKey, Status status);
    error ChallengePeriodActive(uint40 deadline, uint256 nowTs);
    error ChallengePeriodElapsed(uint40 deadline, uint256 nowTs);
    error InvalidPreimage();
    error NothingToWithdraw();
    error TokenTransferFailed();
    error InexactTokenTransfer();
    error Sha256Unavailable();
    error InvalidDataset();
    error DatasetEscrowMismatch();
    error InvalidLockAuthorization();
    error LockAuthorizationExpired();

    modifier nonReentrant() {
        if (_guard == 1) revert Reentrancy();
        _guard = 1;
        _;
        _guard = 0;
    }

    constructor(IERC20 usdc_, SiriusKybRegistry kyb_, SiriusDatasetRegistry datasets_, address lockAuthorizer_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(usdc_).code.length == 0) revert InvalidUsdcContract();
        if (address(kyb_) == address(0)) revert ZeroAddress();
        if (address(datasets_) == address(0)) revert ZeroAddress();
        if (lockAuthorizer_ == address(0)) revert ZeroAddress();

        // The floor follows the token, not the chain. Reading decimals() here also proves
        // the address answers like an ERC-20 before a single loan can exist.
        uint8 tokenDecimals = usdc_.decimals();
        if (tokenDecimals < 3 || tokenDecimals > 30) revert UnsupportedUsdcDecimals(tokenDecimals);
        MIN_AMOUNT = 10 ** (uint256(tokenDecimals) - 3);

        usdc = usdc_;
        kyb = kyb_;
        datasets = datasets_;
        lockAuthorizer = lockAuthorizer_;
    }

    function loanKeyOf(address borrower, bytes32 loanIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(LOAN_KEY_DOMAIN, borrower, loanIdHash));
    }

    /// @notice Lock an exact USDC amount. The borrower must approve this contract first.
    function lock(
        address provider,
        uint256 amount,
        bytes32 hashlock,
        uint8 challengeDays,
        bytes32 loanIdHash,
        bytes32 datasetId,
        bytes32 trainingProfile,
        LockAuthorization calldata authorization
    )
        external
        nonReentrant
        returns (bytes32 loanKey)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount < MIN_AMOUNT) revert AmountTooSmall();
        if (amount > MAX_AMOUNT) revert AmountOverflow();
        if (provider == address(0) || provider == address(this)) revert InvalidProvider();
        if (provider == msg.sender) revert SelfDealing();
        if (address(datasets.escrow()) != address(this)) revert DatasetEscrowMismatch();
        if (datasetId == bytes32(0) || trainingProfile == bytes32(0)
            || !datasets.isLiveForProviderAndProfile(datasetId, provider, trainingProfile)) revert InvalidDataset();
        if (hashlock == bytes32(0) || hashlock == ZERO_PREIMAGE_HASH) revert InvalidHashlock();
        if (challengeDays < MIN_CHALLENGE_DAYS || challengeDays > MAX_CHALLENGE_DAYS) revert InvalidChallengePeriod();
        if (loanIdHash == bytes32(0)) revert InvalidLoanId();
        if (!kyb.isKybValid(msg.sender) || !kyb.isKybValid(provider)) revert KybRequired();
        _requireLockAuthorization(
            keccak256(abi.encode(msg.sender, provider, amount, hashlock, challengeDays, loanIdHash, datasetId, trainingProfile)),
            authorization
        );

        loanKey = loanKeyOf(msg.sender, loanIdHash);
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.None) revert LoanExists(loanKey);

        _transferFrom(msg.sender, address(this), amount);

        uint40 deadline = uint40(block.timestamp + uint256(challengeDays) * 1 days);
        loan.provider = provider;
        loan.amount = uint96(amount);
        loan.borrower = msg.sender;
        loan.deadline = deadline;
        loan.status = Status.Locked;
        loan.hashlock = hashlock;
        loan.datasetId = datasetId;
        loan.trainingProfile = trainingProfile;
        lockedUsdc += amount;
        unchecked { _activeLoansForDataset[datasetId] += 1; }

        emit LoanLocked(loanKey, msg.sender, provider, amount, deadline, hashlock, trainingProfile, _nextSeq());
    }

    function _requireLockAuthorization(bytes32 termsHash, LockAuthorization calldata authorization) private view {
        if (block.timestamp >= authorization.deadline) revert LockAuthorizationExpired();
        if (authorization.deadline > block.timestamp + 5 minutes) revert InvalidLockAuthorization();
        bytes calldata signature = authorization.signature;
        if (signature.length != 65) revert InvalidLockAuthorization();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
            || (v != 27 && v != 28)) revert InvalidLockAuthorization();
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("SiriusEscrow"), keccak256("6"), block.chainid, address(this)
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", domain, keccak256(abi.encode(LOCK_AUTHORIZATION_TYPEHASH, termsHash, authorization.deadline))
        ));
        if (ecrecover(digest, v, r, s) != lockAuthorizer) revert InvalidLockAuthorization();
    }

    /// @notice Publish a valid preimage and credit the provider atomically.
    function release(bytes32 loanKey, bytes32 preimage) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (block.timestamp >= loan.deadline) revert ChallengePeriodElapsed(loan.deadline, block.timestamp);
        if (_sha256(preimage) != loan.hashlock) revert InvalidPreimage();

        uint256 amount = loan.amount;
        loan.status = Status.Released;
        loan.preimage = preimage;
        lockedUsdc -= amount;
        unchecked { _activeLoansForDataset[loan.datasetId] -= 1; }
        uint256 balance = _credit[loan.provider] + amount;
        _credit[loan.provider] = balance;
        owedUsdc += amount;

        emit LoanReleased(loanKey, loan.provider, msg.sender, preimage, amount, _nextSeq());
        emit PreimageRevealed(loan.hashlock, loanKey, preimage);
        emit CreditAccrued(loan.provider, loanKey, amount, balance);
    }

    /// @notice Credit the borrower after the challenge period. Permissionless for liveness.
    function refund(bytes32 loanKey) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (block.timestamp < loan.deadline) revert ChallengePeriodActive(loan.deadline, block.timestamp);

        uint256 amount = loan.amount;
        loan.status = Status.Refunded;
        lockedUsdc -= amount;
        unchecked { _activeLoansForDataset[loan.datasetId] -= 1; }
        uint256 balance = _credit[loan.borrower] + amount;
        _credit[loan.borrower] = balance;
        owedUsdc += amount;

        emit LoanRefunded(loanKey, loan.borrower, amount, _nextSeq());
        emit CreditAccrued(loan.borrower, loanKey, amount, balance);
    }

    function withdrawFor(address account) public nonReentrant returns (uint256 amount) {
        amount = _credit[account];
        if (amount == 0) revert NothingToWithdraw();
        _credit[account] = 0;
        owedUsdc -= amount;
        _transfer(account, amount);
        emit Withdrawn(account, amount);
    }

    function withdraw() external returns (uint256) {
        return withdrawFor(msg.sender);
    }

    function getLoan(bytes32 loanKey) external view returns (Loan memory) {
        return _loans[loanKey];
    }

    function preimageOf(bytes32 loanKey) external view returns (bool revealed, bytes32 preimage) {
        Loan storage loan = _loans[loanKey];
        return (loan.status == Status.Released, loan.preimage);
    }

    function creditOf(address account) external view returns (uint256) {
        return _credit[account];
    }

    function activeLoansForDataset(bytes32 datasetId) external view returns (uint256) {
        return _activeLoansForDataset[datasetId];
    }

    function isReleasable(bytes32 loanKey) external view returns (bool) {
        return _loans[loanKey].status == Status.Locked;
    }

    function isRefundable(bytes32 loanKey) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && block.timestamp >= loan.deadline;
    }

    function accounting() external view returns (uint256 locked, uint256 owed, uint256 balance, uint64 seq) {
        return (lockedUsdc, owedUsdc, usdc.balanceOf(address(this)), eventSeq);
    }

    function matchesScope(
        bytes32 loanKey,
        address borrower,
        address provider,
        uint256 amount,
        bytes32 hashlock,
        bytes32 trainingProfile,
        uint256 minimumRemaining
    ) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && loan.borrower == borrower && loan.provider == provider
            && uint256(loan.amount) == amount && loan.hashlock == hashlock
            && loan.trainingProfile == trainingProfile
            && uint256(loan.deadline) > block.timestamp + minimumRemaining;
    }

    function _nextSeq() private returns (uint64 seq) {
        unchecked { seq = ++eventSeq; }
    }

    function _transferFrom(address from, address to, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(to);
        _callToken(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        uint256 afterBalance = usdc.balanceOf(to);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert InexactTokenTransfer();
    }

    function _transfer(address to, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(to);
        _callToken(abi.encodeCall(IERC20.transfer, (to, amount)));
        uint256 afterBalance = usdc.balanceOf(to);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert InexactTokenTransfer();
    }

    function _callToken(bytes memory data) private {
        (bool ok, bytes memory result) = address(usdc).call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenTransferFailed();
    }

    function _sha256(bytes32 input) private view returns (bytes32 digest) {
        bool ok;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, input)
            ok := staticcall(gas(), 0x02, ptr, 0x20, ptr, 0x20)
            digest := mload(ptr)
        }
        if (!ok) revert Sha256Unavailable();
    }
}

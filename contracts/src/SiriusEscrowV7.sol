// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "./SiriusEscrow.sol";
import {SiriusKybRegistry} from "./SiriusKybRegistry.sol";
import {SiriusDatasetRegistry} from "./SiriusDatasetRegistry.sol";

/// @notice Prepaid dataset and compute escrow. No owner, upgrade or treasury allowance.
/// @dev Execution costs are attested by the runner, not independently measured by the EVM.
contract SiriusEscrowV7 {
    enum Status { None, Locked, Released, Refunded, Failed }

    struct LockTerms {
        address provider;
        address computeRecipient;
        uint256 datasetAmount;
        uint256 computeAmount;
        uint256 maxFailureFee;
        bytes32 hashlock;
        uint8 challengeDays;
        bytes32 loanIdHash;
        bytes32 datasetId;
        bytes32 trainingProfile;
        bytes32 quoteHash;
    }

    struct Loan {
        address provider;
        uint96 datasetAmount;
        address borrower;
        uint40 lockedAt;
        uint40 deadline;
        Status status;
        address computeRecipient;
        uint96 computeAmount;
        uint96 maxFailureFee;
        uint96 consumedCompute;
        uint40 observedAt;
        bytes32 hashlock;
        bytes32 preimage;
        bytes32 datasetId;
        bytes32 trainingProfile;
        bytes32 termsHash;
        bytes32 executionEvidenceHash;
    }

    struct LockAuthorization {
        uint40 deadline;
        bytes signature;
    }

    struct ExecutionReceipt {
        uint256 consumedCompute;
        bytes32 evidenceHash;
        uint40 observedAt;
        bool finalFailure;
    }

    string public constant VERSION = "sirius-escrow-usdc-v7";
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant LOCK_AUTHORIZATION_TYPEHASH =
        keccak256("LockAuthorization(bytes32 termsHash,uint40 deadline)");
    bytes32 private constant EXECUTION_RECEIPT_TYPEHASH = keccak256(
        "ExecutionReceipt(bytes32 loanKey,bytes32 termsHash,uint256 consumedCompute,bytes32 evidenceHash,uint40 observedAt,bool finalFailure)"
    );
    bytes32 public constant LOAN_KEY_DOMAIN = keccak256("sirius.escrow.loanKey.v1");
    uint8 public constant MIN_CHALLENGE_DAYS = 1;
    uint8 public constant MAX_CHALLENGE_DAYS = 30;
    uint40 public constant MAX_AUTHORIZATION_TTL = 5 minutes;
    uint256 public immutable MIN_AMOUNT;
    uint256 private constant MAX_AMOUNT = type(uint96).max;
    bytes32 private constant ZERO_PREIMAGE_HASH =
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
        bytes32 indexed loanKey, address indexed borrower, address indexed provider,
        address computeRecipient, uint256 datasetAmount, uint256 computeAmount,
        uint256 maxFailureFee, uint40 deadline, bytes32 termsHash, uint64 seq
    );
    event LoanReleased(
        bytes32 indexed loanKey, address indexed provider, address indexed computeRecipient,
        bytes32 preimage, uint256 datasetAmount, uint256 computeAmount, uint64 seq
    );
    event ExecutionRecorded(
        bytes32 indexed loanKey, uint256 consumedCompute, bytes32 evidenceHash,
        uint40 observedAt, bool finalFailure, uint64 seq
    );
    event LoanFailed(bytes32 indexed loanKey, address indexed borrower, uint256 refundAmount, uint256 retainedFee, uint64 seq);
    event LoanRefunded(
        bytes32 indexed loanKey, address indexed borrower, uint256 refundAmount, uint256 retainedFee, uint64 seq
    );
    event PreimageRevealed(bytes32 indexed hashlock, bytes32 indexed loanKey, bytes32 preimage);
    event CreditAccrued(address indexed account, bytes32 indexed loanKey, uint256 amount, uint256 balance);
    event Withdrawn(address indexed account, uint256 amount);

    error Reentrancy();
    error ZeroAddress();
    error InvalidUsdcContract();
    error InvalidRegistry();
    error UnsupportedUsdcDecimals(uint8 tokenDecimals);
    error ZeroAmount();
    error AmountTooSmall();
    error AmountOverflow();
    error InvalidProvider();
    error InvalidComputeRecipient();
    error InvalidFailureFee();
    error SelfDealing();
    error InvalidHashlock();
    error InvalidChallengePeriod();
    error InvalidLoanId();
    error InvalidQuote();
    error KybRequired();
    error LoanExists(bytes32 loanKey);
    error LoanNotLocked(bytes32 loanKey, Status status);
    error ChallengePeriodActive(uint40 deadline, uint256 nowTs);
    error ChallengePeriodElapsed(uint40 deadline, uint256 nowTs);
    error InvalidPreimage();
    error NothingToWithdraw();
    error TokenTransferFailed();
    error InexactTokenTransfer();
    error InvalidDataset();
    error DatasetEscrowMismatch();
    error InvalidLockAuthorization();
    error LockAuthorizationExpired();
    error LockAuthorizationTooLong();
    error InvalidExecutionReceipt();
    error StaleExecutionReceipt();

    modifier nonReentrant() {
        if (_guard == 1) revert Reentrancy();
        _guard = 1;
        _;
        _guard = 0;
    }

    constructor(IERC20 usdc_, SiriusKybRegistry kyb_, SiriusDatasetRegistry datasets_, address lockAuthorizer_) {
        if (address(usdc_) == address(0) || address(kyb_) == address(0)
            || address(datasets_) == address(0) || lockAuthorizer_ == address(0)) revert ZeroAddress();
        if (address(usdc_).code.length == 0) revert InvalidUsdcContract();
        if (address(kyb_).code.length == 0 || address(datasets_).code.length == 0) revert InvalidRegistry();
        if (address(datasets_.kyb()) != address(kyb_)) revert InvalidRegistry();
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

    function termsHashOf(address borrower, LockTerms calldata terms) public pure returns (bytes32) {
        return keccak256(abi.encode(borrower, terms));
    }

    function lock(LockTerms calldata terms, LockAuthorization calldata authorization)
        external nonReentrant returns (bytes32 loanKey)
    {
        if (terms.datasetAmount == 0 || terms.computeAmount == 0) revert ZeroAmount();
        if (terms.datasetAmount > MAX_AMOUNT || terms.computeAmount > MAX_AMOUNT
            || terms.datasetAmount + terms.computeAmount > MAX_AMOUNT) revert AmountOverflow();
        uint256 total = terms.datasetAmount + terms.computeAmount;
        if (total < MIN_AMOUNT) revert AmountTooSmall();
        if (terms.maxFailureFee > terms.computeAmount) revert InvalidFailureFee();
        if (terms.provider == address(0) || terms.provider == address(this)) revert InvalidProvider();
        if (terms.provider == msg.sender) revert SelfDealing();
        if (terms.computeRecipient == address(0) || terms.computeRecipient == address(this)
            || terms.computeRecipient == msg.sender || terms.computeRecipient == terms.provider) revert InvalidComputeRecipient();
        if (address(datasets.escrow()) != address(this)) revert DatasetEscrowMismatch();
        if (terms.datasetId == bytes32(0) || terms.trainingProfile == bytes32(0)
            || !datasets.isLiveForProviderAndProfile(terms.datasetId, terms.provider, terms.trainingProfile)) revert InvalidDataset();
        if (terms.hashlock == bytes32(0) || terms.hashlock == ZERO_PREIMAGE_HASH) revert InvalidHashlock();
        if (terms.challengeDays < MIN_CHALLENGE_DAYS || terms.challengeDays > MAX_CHALLENGE_DAYS) revert InvalidChallengePeriod();
        if (terms.loanIdHash == bytes32(0)) revert InvalidLoanId();
        if (terms.quoteHash == bytes32(0)) revert InvalidQuote();
        if (!kyb.isKybValid(msg.sender) || !kyb.isKybValid(terms.provider)) revert KybRequired();
        if (block.timestamp >= authorization.deadline) revert LockAuthorizationExpired();
        if (authorization.deadline > block.timestamp + MAX_AUTHORIZATION_TTL) revert LockAuthorizationTooLong();
        bytes32 termsHash = termsHashOf(msg.sender, terms);
        if (!_isAuthorized(keccak256(abi.encode(LOCK_AUTHORIZATION_TYPEHASH, termsHash, authorization.deadline)),
            authorization.signature)) revert InvalidLockAuthorization();

        loanKey = loanKeyOf(msg.sender, terms.loanIdHash);
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.None) revert LoanExists(loanKey);
        _transferFrom(msg.sender, total);

        loan.provider = terms.provider;
        loan.borrower = msg.sender;
        loan.computeRecipient = terms.computeRecipient;
        loan.datasetAmount = uint96(terms.datasetAmount);
        loan.computeAmount = uint96(terms.computeAmount);
        loan.maxFailureFee = uint96(terms.maxFailureFee);
        loan.lockedAt = uint40(block.timestamp);
        loan.deadline = uint40(block.timestamp + uint256(terms.challengeDays) * 1 days);
        loan.status = Status.Locked;
        loan.hashlock = terms.hashlock;
        loan.datasetId = terms.datasetId;
        loan.trainingProfile = terms.trainingProfile;
        loan.termsHash = termsHash;
        lockedUsdc += total;
        _activeLoansForDataset[terms.datasetId] += 1;
        emit LoanLocked(loanKey, msg.sender, terms.provider, terms.computeRecipient,
            terms.datasetAmount, terms.computeAmount, terms.maxFailureFee, loan.deadline, termsHash, _nextSeq());
    }

    /// @dev A checkpoint reserves a cumulative failure fee; it never pays out before resolution.
    /// Receipts must be published before expiry. Missing receipts cannot reduce a timeout refund.
    function recordExecution(bytes32 loanKey, ExecutionReceipt calldata receipt, bytes calldata signature)
        external nonReentrant
    {
        Loan storage loan = _loans[loanKey];
        _requireActive(loanKey, loan);
        if (receipt.consumedCompute > loan.maxFailureFee) revert InvalidFailureFee();
        if (receipt.evidenceHash == bytes32(0) || receipt.observedAt < loan.lockedAt
            || receipt.observedAt > block.timestamp) revert InvalidExecutionReceipt();
        if (receipt.consumedCompute < loan.consumedCompute || receipt.observedAt < loan.observedAt
            || (!receipt.finalFailure && receipt.consumedCompute == loan.consumedCompute)) revert StaleExecutionReceipt();
        bytes32 receiptHash = keccak256(abi.encode(EXECUTION_RECEIPT_TYPEHASH, loanKey, loan.termsHash,
            receipt.consumedCompute, receipt.evidenceHash, receipt.observedAt, receipt.finalFailure));
        if (!_isAuthorized(receiptHash, signature)) revert InvalidExecutionReceipt();
        loan.consumedCompute = uint96(receipt.consumedCompute);
        loan.observedAt = receipt.observedAt;
        loan.executionEvidenceHash = receipt.evidenceHash;
        uint64 seq = _nextSeq();
        emit ExecutionRecorded(loanKey, receipt.consumedCompute, receipt.evidenceHash,
            receipt.observedAt, receipt.finalFailure, seq);
        if (receipt.finalFailure) {
            uint256 refundAmount = _refund(loanKey, loan, Status.Failed);
            emit LoanFailed(loanKey, loan.borrower, refundAmount, loan.consumedCompute, seq);
        }
    }

    function release(bytes32 loanKey, bytes32 preimage) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        _requireActive(loanKey, loan);
        if (sha256(abi.encodePacked(preimage)) != loan.hashlock) revert InvalidPreimage();
        loan.preimage = preimage;
        _close(loan, Status.Released);
        _accrue(loan.provider, loanKey, loan.datasetAmount);
        _accrue(loan.computeRecipient, loanKey, loan.computeAmount);
        emit LoanReleased(loanKey, loan.provider, loan.computeRecipient,
            preimage, loan.datasetAmount, loan.computeAmount, _nextSeq());
        emit PreimageRevealed(loan.hashlock, loanKey, preimage);
    }

    /// @notice Permissionless recovery, using only execution evidence already on-chain.
    function refund(bytes32 loanKey) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (block.timestamp < loan.deadline) revert ChallengePeriodActive(loan.deadline, block.timestamp);
        uint256 refundAmount = _refund(loanKey, loan, Status.Refunded);
        emit LoanRefunded(loanKey, loan.borrower, refundAmount, loan.consumedCompute, _nextSeq());
    }

    function _refund(bytes32 loanKey, Loan storage loan, Status status) private returns (uint256 refundAmount) {
        refundAmount = uint256(loan.datasetAmount) + loan.computeAmount - loan.consumedCompute;
        _close(loan, status);
        _accrue(loan.borrower, loanKey, refundAmount);
        _accrue(loan.computeRecipient, loanKey, loan.consumedCompute);
    }

    function _close(Loan storage loan, Status status) private {
        uint256 total = uint256(loan.datasetAmount) + loan.computeAmount;
        loan.status = status;
        lockedUsdc -= total;
        owedUsdc += total;
        _activeLoansForDataset[loan.datasetId] -= 1;
    }

    function _accrue(address account, bytes32 loanKey, uint256 amount) private {
        if (amount == 0) return;
        _credit[account] += amount;
        emit CreditAccrued(account, loanKey, amount, _credit[account]);
    }

    function withdrawFor(address account) public nonReentrant returns (uint256 amount) {
        amount = _credit[account];
        if (amount == 0) revert NothingToWithdraw();
        _credit[account] = 0;
        owedUsdc -= amount;
        uint256 senderBefore = usdc.balanceOf(address(this));
        uint256 recipientBefore = usdc.balanceOf(account);
        _callToken(abi.encodeCall(IERC20.transfer, (account, amount)));
        _requireExactTransfer(senderBefore, usdc.balanceOf(address(this)), recipientBefore, usdc.balanceOf(account), amount);
        emit Withdrawn(account, amount);
    }

    function withdraw() external returns (uint256) {
        return withdrawFor(msg.sender);
    }

    function getLoan(bytes32 loanKey) external view returns (Loan memory) {
        return _loans[loanKey];
    }

    function creditOf(address account) external view returns (uint256) {
        return _credit[account];
    }

    function activeLoansForDataset(bytes32 datasetId) external view returns (uint256) {
        return _activeLoansForDataset[datasetId];
    }

    function preimageOf(bytes32 loanKey) external view returns (bool revealed, bytes32 preimage) {
        Loan storage loan = _loans[loanKey];
        return (loan.status == Status.Released, loan.preimage);
    }

    function isReleasable(bytes32 loanKey) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && block.timestamp < loan.deadline;
    }

    function isRefundable(bytes32 loanKey) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && block.timestamp >= loan.deadline;
    }

    function matchesScope(bytes32 loanKey, bytes32 expectedTermsHash, uint256 minimumRemaining) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && loan.termsHash == expectedTermsHash
            && loan.deadline > block.timestamp && loan.deadline - block.timestamp > minimumRemaining;
    }

    function accounting() external view returns (uint256 locked, uint256 owed, uint256 balance, uint64 seq) {
        return (lockedUsdc, owedUsdc, usdc.balanceOf(address(this)), eventSeq);
    }

    function _requireActive(bytes32 loanKey, Loan storage loan) private view {
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (block.timestamp >= loan.deadline) revert ChallengePeriodElapsed(loan.deadline, block.timestamp);
    }

    function _isAuthorized(bytes32 structHash, bytes calldata signature) private view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
            || (v != 27 && v != 28)) return false;
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("SiriusEscrow"), keccak256("7"), block.chainid, address(this)
        ));
        return ecrecover(keccak256(abi.encodePacked("\x19\x01", domain, structHash)), v, r, s) == lockAuthorizer;
    }

    function _nextSeq() private returns (uint64) {
        return ++eventSeq;
    }

    function _transferFrom(address from, uint256 amount) private {
        uint256 senderBefore = usdc.balanceOf(from);
        uint256 recipientBefore = usdc.balanceOf(address(this));
        _callToken(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        _requireExactTransfer(senderBefore, usdc.balanceOf(from), recipientBefore, usdc.balanceOf(address(this)), amount);
    }

    function _requireExactTransfer(uint256 senderBefore, uint256 senderAfter,
        uint256 recipientBefore, uint256 recipientAfter, uint256 amount) private pure
    {
        if (senderAfter > senderBefore || senderBefore - senderAfter != amount
            || recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) revert InexactTokenTransfer();
    }

    function _callToken(bytes memory data) private {
        (bool ok, bytes memory result) = address(usdc).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenTransferFailed();
    }
}

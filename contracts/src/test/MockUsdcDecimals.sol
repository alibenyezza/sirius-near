// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Tokens that differ from MockUsdc only by their precision.
///
/// They exist to prove that SiriusEscrow derives its minimum lockable amount from the
/// token rather than from a hardcoded literal. Several contracts named "USDC" coexist on
/// public test networks — some with six decimals, some with eighteen — and picking the
/// wrong one shifts every amount by a power of ten without raising any error.
///
/// Only the surface the escrow constructor touches is implemented: these are never used
/// to move value.

/// @dev Eighteen-decimal token: the escrow floor must rise to 1e15.
contract MockUsdc18 {
    string public constant name = "Mock USDC 18";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev Zero-decimal token: outside the plausible range, the escrow must refuse it.
contract MockUsdc0 {
    string public constant name = "Mock USDC 0";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 0;

    mapping(address => uint256) public balanceOf;

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

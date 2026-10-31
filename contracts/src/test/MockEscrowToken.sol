// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Exercises exact accounting, optional ERC-20 return values and callbacks.
contract MockEscrowToken {
    uint8 public immutable decimals;
    enum Behavior { Exact, FalseReturn, NoReturn, RecipientFee, SenderFee }
    Behavior public behavior;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) { decimals = decimals_; }

    function setBehavior(Behavior behavior_) external { behavior = behavior_; }
    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }
    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        if (behavior == Behavior.FalseReturn) return false;
        balanceOf[from] -= amount + (behavior == Behavior.SenderFee ? 1 : 0);
        balanceOf[to] += amount - (behavior == Behavior.RecipientFee ? 1 : 0);
        if (callbackTarget != address(0)) {
            (callbackSucceeded,) = callbackTarget.call(callbackData);
        }
        if (behavior == Behavior.NoReturn) {
            assembly ("memory-safe") { return(0, 0) }
        }
        return true;
    }
}

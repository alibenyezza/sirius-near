// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SiriusTestUsdc
/// @notice Jeton de règlement pour les réseaux de test uniquement.
///
/// @dev Il existe parce qu'aucun USDC du testnet Robinhood n'est obtenable : celui qui
///      est vérifié réserve sa frappe à son propriétaire, et le faucet n'en distribue
///      pas. Sans jeton, aucun prêt ne peut être verrouillé et le protocole est
///      indémontrable.
///
///      Dix-huit décimales, pour correspondre à l'USDC vérifié de cette chaîne — et
///      donc à ce que `USDC_DECIMALS_BY_NETWORK` déclare pour le testnet. Un jeton à
///      six décimales imposerait de changer cette table et rendrait la démonstration
///      moins fidèle au réseau visé.
///
///      La frappe est ouverte à tous, délibérément : sur un réseau de test, un contrôle
///      d'accès n'ajoute aucune sécurité et ajoute une clé à conserver. Ce contrat n'a
///      donc rien à faire sur un mainnet, et `SiriusEscrow` y pointerait vers l'USDC
///      réel.
contract SiriusTestUsdc {
    string public constant name = "Sirius Test USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidRecipient();

    /// @notice Frappe des jetons de test. Ouvert à tous : réseau de test uniquement.
    function mint(address to, uint256 amount) external {
        if (to == address(0)) revert InvalidRecipient();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved < amount) revert InsufficientAllowance();
        // Une allocation infinie n'est pas décrémentée : c'est la convention ERC-20
        // répandue, et l'escrow s'en sert pour éviter une écriture par prêt.
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidRecipient();
        uint256 solde = balanceOf[from];
        if (solde < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = solde - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}

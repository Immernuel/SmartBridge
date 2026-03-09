// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "src/interfaces/IERC20.sol";
import {ReceiverTemplate} from "src/interfaces/ReceiverTemplate.sol";

// ============================================================
//  SmartBridge — Consumer Contract
//  Docs: https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write
//
//  This contract:
//    1. Inherits ReceiverTemplate — handles forwarder validation, ERC165,
//       metadata decoding, and optional workflow identity checks automatically
//    2. Implements _processReport() with business logic:
//       decodes (tokenAddress, recipient, amount) and executes transfer
//    3. Calls token.transfer(recipient, amount) to complete the bridge
//
//  Deploy on Sepolia, then set receiverContract in config.staging.json.
//
//  After deploying:
//    • Fund the contract with the ERC-20 token it will transfer
//    • The workflow sends `amount` tokens to `recipient` (the resolved CEX deposit address)
//
//  Forwarder addresses:
//    Simulation  → 0x... (check cre workflow simulate output or forwarder-directory docs)
//    Sepolia     → see https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory
// ============================================================

/**
 * @title SmartBridgeReceiver
 * @notice Receives a Chainlink CRE workflow report and executes an ERC-20
 *         transfer to the resolved CEX deposit address.
 *
 * Inherits ReceiverTemplate which provides:
 *   - onReport() with forwarder address validation
 *   - Optional workflow owner / name / ID validation
 *   - ERC165 supportsInterface support
 *   - _decodeMetadata() utility for extracting workflow identity
 *
 * The `report` bytes are ABI-encoded as:
 *   (address token, address recipient, uint256 amount)
 */
contract SmartBridgeReceiver is ReceiverTemplate {
    // ── Events ────────────────────────────────────────────────────────────────

    event TransferExecuted(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 indexed reportHash
    );

    event TokensWithdrawn(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    // Note: OnlyForwarder and InvalidSender are now handled by ReceiverTemplate
    error TransferFailed();
    error ZeroAddress();
    error ZeroAmount();

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _forwarder The Chainlink Forwarder address for this chain.
     *                   Passed to ReceiverTemplate which stores and validates it.
     *                   For simulation use the MockKeystoneForwarder address.
     *                   For production use the KeystoneForwarder address.
     *                   See: https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory
     */
    constructor(address _forwarder) ReceiverTemplate(_forwarder) {}

    // ── ReceiverTemplate implementation ──────────────────────────────────────

    /**
     * @notice Core business logic called by ReceiverTemplate.onReport() after
     *         forwarder validation (and optional workflow identity checks) pass.
     * @dev ReceiverTemplate handles:
     *      - Reverting if msg.sender != forwarder
     *      - Optional workflowId / workflowOwner / workflowName checks (if set via setters)
     *      - ERC165 supportsInterface
     *
     * @param report ABI-encoded (address token, address recipient, uint256 amount)
     *               Must match the CRE workflow's encodeAbiParameters encoding:
     *               encodeAbiParameters(
     *                 parseAbiParameters("address token, address recipient, uint256 amount"),
     *                 [tokenContract, depositAddress, amount]
     *               )
     */
    function _processReport(bytes calldata report) internal override {
        (address token, address recipient, uint256 amount) = abi.decode(
            report,
            (address, address, uint256)
        );

        if (token == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        bool success = IERC20(token).transfer(recipient, amount);
        if (!success) revert TransferFailed();

        emit TransferExecuted(token, recipient, amount, keccak256(report));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw ERC-20 tokens held by this contract (owner only).
     *         Ownership is managed by ReceiverTemplate → OpenZeppelin Ownable.
     *         Use onlyOwner from Ownable (inherited via ReceiverTemplate).
     */
    function withdrawTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        bool success = IERC20(token).transfer(to, amount);
        if (!success) revert TransferFailed();
        emit TokensWithdrawn(token, to, amount);
    }

    /**
     * @notice Check how many tokens this contract holds.
     */
    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // Note: transferOwnership() is inherited from OpenZeppelin Ownable via ReceiverTemplate.
    // No need to reimplement it — call transferOwnership(newOwner) directly.
}

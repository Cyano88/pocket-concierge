// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GiwaMandateExecutor
/// @notice Non-custodial, bounded ERC-20 payment authority for autonomous agents.
/// @dev Users retain funds and approve only the total mandate cap to this contract.
contract GiwaMandateExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Decision {
        APPROVE,
        ESCALATE,
        BLOCK
    }

    struct Mandate {
        address owner;
        address agent;
        address token;
        address recipient;
        uint128 maxPerPayment;
        uint128 totalCap;
        uint128 spent;
        uint64 validAfter;
        uint64 validUntil;
        uint64 intervalSeconds;
        uint64 lastExecutedAt;
        bool paused;
        bool revoked;
        bytes32 purposeHash;
    }

    struct ExceptionApproval {
        uint128 maximumAmount;
        uint64 expiresAt;
        bool used;
    }

    error ZeroAddress();
    error InvalidAmount();
    error InvalidWindow();
    error InvalidCap();
    error MandateNotFound();
    error NotMandateOwner();
    error NotAuthorizedAgent();
    error MandateIsPaused();
    error MandateIsRevoked();
    error MandateNotActive();
    error IntervalNotElapsed();
    error PaymentLimitExceeded();
    error TotalCapExceeded();
    error InvalidPaymentReference();
    error PaymentReferenceConsumed();
    error ExceptionInvalid();

    event MandateCreated(
        bytes32 indexed mandateId,
        address indexed owner,
        address indexed agent,
        address token,
        address recipient,
        uint128 maxPerPayment,
        uint128 totalCap,
        uint64 validAfter,
        uint64 validUntil,
        uint64 intervalSeconds,
        bytes32 purposeHash
    );
    event MandatePaused(bytes32 indexed mandateId, bool paused);
    event MandateRevoked(bytes32 indexed mandateId);
    event ExceptionApproved(
        bytes32 indexed mandateId,
        bytes32 indexed paymentReference,
        uint128 maximumAmount,
        uint64 expiresAt
    );
    event PaymentExecuted(
        bytes32 indexed mandateId,
        bytes32 indexed paymentReference,
        address indexed agent,
        address owner,
        address recipient,
        address token,
        uint128 amount,
        uint128 cumulativeSpent,
        bool usedException
    );

    mapping(bytes32 => Mandate) public mandates;
    mapping(bytes32 => mapping(bytes32 => ExceptionApproval)) public exceptions;
    mapping(bytes32 => bool) public consumedPaymentReferences;
    mapping(address => uint256) public ownerNonces;

    function createMandate(
        address agent,
        address token,
        address recipient,
        uint128 maxPerPayment,
        uint128 totalCap,
        uint64 validAfter,
        uint64 validUntil,
        uint64 intervalSeconds,
        bytes32 purposeHash
    ) external returns (bytes32 mandateId) {
        if (agent == address(0) || token == address(0) || recipient == address(0)) revert ZeroAddress();
        if (maxPerPayment == 0 || totalCap == 0) revert InvalidAmount();
        if (maxPerPayment > totalCap) revert InvalidCap();
        if (validUntil <= validAfter || validUntil <= block.timestamp) revert InvalidWindow();

        uint256 nonce = ownerNonces[msg.sender]++;
        mandateId = keccak256(abi.encode(msg.sender, agent, token, recipient, nonce, block.chainid));

        mandates[mandateId] = Mandate({
            owner: msg.sender,
            agent: agent,
            token: token,
            recipient: recipient,
            maxPerPayment: maxPerPayment,
            totalCap: totalCap,
            spent: 0,
            validAfter: validAfter,
            validUntil: validUntil,
            intervalSeconds: intervalSeconds,
            lastExecutedAt: 0,
            paused: false,
            revoked: false,
            purposeHash: purposeHash
        });

        emit MandateCreated(
            mandateId,
            msg.sender,
            agent,
            token,
            recipient,
            maxPerPayment,
            totalCap,
            validAfter,
            validUntil,
            intervalSeconds,
            purposeHash
        );
    }

    function setPaused(bytes32 mandateId, bool paused) external {
        Mandate storage mandate = _ownedMandate(mandateId);
        if (mandate.revoked) revert MandateIsRevoked();
        mandate.paused = paused;
        emit MandatePaused(mandateId, paused);
    }

    function revokeMandate(bytes32 mandateId) external {
        Mandate storage mandate = _ownedMandate(mandateId);
        if (mandate.revoked) revert MandateIsRevoked();
        mandate.revoked = true;
        mandate.paused = true;
        emit MandateRevoked(mandateId);
    }

    /// @notice Approves one exact, short-lived payment exception.
    /// @dev An exception may override the per-payment cap or interval, but never recipient,
    /// token, mandate validity, revocation, or remaining total cap.
    function approveException(
        bytes32 mandateId,
        bytes32 paymentReference,
        uint128 maximumAmount,
        uint64 expiresAt
    ) external {
        Mandate storage mandate = _ownedMandate(mandateId);
        if (mandate.revoked) revert MandateIsRevoked();
        if (paymentReference == bytes32(0)) revert InvalidPaymentReference();
        if (maximumAmount == 0 || maximumAmount > mandate.totalCap - mandate.spent) revert ExceptionInvalid();
        if (expiresAt <= block.timestamp || expiresAt > mandate.validUntil) revert ExceptionInvalid();

        exceptions[mandateId][paymentReference] = ExceptionApproval({
            maximumAmount: maximumAmount,
            expiresAt: expiresAt,
            used: false
        });
        emit ExceptionApproved(mandateId, paymentReference, maximumAmount, expiresAt);
    }

    function previewPayment(bytes32 mandateId, uint128 amount, bytes32 paymentReference)
        external
        view
        returns (Decision decision, uint128 remaining, uint64 nextExecutionAt)
    {
        Mandate storage mandate = mandates[mandateId];
        if (mandate.owner == address(0)) return (Decision.BLOCK, 0, 0);
        remaining = mandate.totalCap - mandate.spent;
        nextExecutionAt = mandate.lastExecutedAt == 0
            ? mandate.validAfter
            : mandate.lastExecutedAt + mandate.intervalSeconds;

        if (
            mandate.revoked || mandate.paused || block.timestamp < mandate.validAfter
                || block.timestamp > mandate.validUntil || amount == 0 || amount > remaining
                || paymentReference == bytes32(0) || consumedPaymentReferences[paymentReference]
        ) return (Decision.BLOCK, remaining, nextExecutionAt);

        bool overPerPayment = amount > mandate.maxPerPayment;
        bool intervalPending = mandate.lastExecutedAt != 0 && block.timestamp < nextExecutionAt;
        if (!overPerPayment && !intervalPending) return (Decision.APPROVE, remaining, nextExecutionAt);

        ExceptionApproval storage exception = exceptions[mandateId][paymentReference];
        if (!exception.used && exception.expiresAt >= block.timestamp && amount <= exception.maximumAmount) {
            return (Decision.APPROVE, remaining, nextExecutionAt);
        }
        return (Decision.ESCALATE, remaining, nextExecutionAt);
    }

    function executePayment(bytes32 mandateId, uint128 amount, bytes32 paymentReference)
        external
        nonReentrant
    {
        Mandate storage mandate = mandates[mandateId];
        if (mandate.owner == address(0)) revert MandateNotFound();
        if (msg.sender != mandate.agent) revert NotAuthorizedAgent();
        if (mandate.revoked) revert MandateIsRevoked();
        if (mandate.paused) revert MandateIsPaused();
        if (block.timestamp < mandate.validAfter || block.timestamp > mandate.validUntil) revert MandateNotActive();
        if (amount == 0) revert InvalidAmount();
        if (paymentReference == bytes32(0)) revert InvalidPaymentReference();
        if (consumedPaymentReferences[paymentReference]) revert PaymentReferenceConsumed();
        if (amount > mandate.totalCap - mandate.spent) revert TotalCapExceeded();

        bool intervalPending = mandate.lastExecutedAt != 0
            && block.timestamp < mandate.lastExecutedAt + mandate.intervalSeconds;
        bool needsException = amount > mandate.maxPerPayment || intervalPending;
        bool usedException = false;

        if (needsException) {
            ExceptionApproval storage exception = exceptions[mandateId][paymentReference];
            if (exception.used || exception.expiresAt < block.timestamp || amount > exception.maximumAmount) {
                if (amount > mandate.maxPerPayment) revert PaymentLimitExceeded();
                revert IntervalNotElapsed();
            }
            exception.used = true;
            usedException = true;
        }

        mandate.spent += amount;
        mandate.lastExecutedAt = uint64(block.timestamp);
        consumedPaymentReferences[paymentReference] = true;

        IERC20(mandate.token).safeTransferFrom(mandate.owner, mandate.recipient, amount);

        emit PaymentExecuted(
            mandateId,
            paymentReference,
            msg.sender,
            mandate.owner,
            mandate.recipient,
            mandate.token,
            amount,
            mandate.spent,
            usedException
        );
    }

    function _ownedMandate(bytes32 mandateId) private view returns (Mandate storage mandate) {
        mandate = mandates[mandateId];
        if (mandate.owner == address(0)) revert MandateNotFound();
        if (msg.sender != mandate.owner) revert NotMandateOwner();
    }
}

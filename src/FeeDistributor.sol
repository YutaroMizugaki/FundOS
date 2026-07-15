// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeDistributor
/// @notice Receives fee tokens (minted FUND shares or raw asset) and
///         distributes them to a configurable set of recipients by weight.
///
///         Use-cases
///         ─────────
///         • Protocol treasury
///         • Manager / strategist split
///         • Staking rewards pool
///
///         Recipients are weighted in basis points (sum must equal 10 000).
///         Anyone can call `distribute()` to push pending balances out.
contract FeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────────────────
    // Types & constants
    // ──────────────────────────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;

    struct Recipient {
        address account;
        uint16 shareBps;
        string label;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────────

    IERC20 public immutable token;
    Recipient[] public recipients;

    // ──────────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────────

    event Distributed(uint256 total);
    event RecipientSet(address indexed account, uint16 shareBps, string label);
    event RecipientsReset();

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────────

    constructor(address _token) Ownable(msg.sender) {
        require(_token != address(0), "FeeDistributor: zero token");
        token = IERC20(_token);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Configuration (owner-only)
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Replace the full recipient list.
    ///         Weights must sum to exactly BPS (10 000).
    function setRecipients(
        address[] calldata accounts,
        uint16[] calldata weights,
        string[] calldata labels
    ) external onlyOwner {
        require(
            accounts.length == weights.length && weights.length == labels.length,
            "FeeDistributor: length mismatch"
        );
        uint256 totalBps;
        for (uint256 i = 0; i < weights.length; ++i) {
            require(accounts[i] != address(0), "FeeDistributor: zero account");
            totalBps += weights[i];
        }
        require(totalBps == BPS, "FeeDistributor: weights must sum to 10000");

        delete recipients;
        for (uint256 i = 0; i < accounts.length; ++i) {
            recipients.push(Recipient({
                account: accounts[i],
                shareBps: weights[i],
                label: labels[i]
            }));
            emit RecipientSet(accounts[i], weights[i], labels[i]);
        }
        emit RecipientsReset();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Distribution (permissionless)
    // ──────────────────────────────────────────────────────────────────────────

    /// @notice Distributes the entire token balance of this contract to recipients.
    function distribute() external nonReentrant returns (uint256 total) {
        total = token.balanceOf(address(this));
        require(total > 0, "FeeDistributor: nothing to distribute");
        require(recipients.length > 0, "FeeDistributor: no recipients");

        uint256 len = recipients.length;
        uint256 distributed;

        for (uint256 i = 0; i < len - 1; ++i) {
            uint256 amount = (total * recipients[i].shareBps) / BPS;
            if (amount > 0) {
                token.safeTransfer(recipients[i].account, amount);
                distributed += amount;
            }
        }
        // Last recipient receives the remainder to avoid dust from rounding
        uint256 remainder = total - distributed;
        if (remainder > 0) {
            token.safeTransfer(recipients[len - 1].account, remainder);
        }

        emit Distributed(total);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────────

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function pendingBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}

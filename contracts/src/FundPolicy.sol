// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFundPolicy} from "./IFundPolicy.sol";

/**
 * @title FundPolicy
 * @notice Immutable-ish policy parameters governing an autonomous fund.
 * @dev Ratios are in basis points (10_000 = 100%).
 */
contract FundPolicy is IFundPolicy {
    uint16 public immutable maxDisbursementRatioBps;
    uint16 public immutable reserveFloorRatioBps;

    mapping(bytes32 => bool) private _allowedCategories;

    address public guardian;
    bool public paused;

    event CategoryUpdated(bytes32 indexed category, bool allowed);
    event GuardianUpdated(address indexed guardian);
    event Paused(bool paused);

    error InvalidRatio();
    error NotGuardian();
    error ZeroAddress();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(
        uint16 maxDisbursementBps_,
        uint16 reserveFloorBps_,
        bytes32[] memory categories_,
        address guardian_
    ) {
        if (maxDisbursementBps_ == 0 || maxDisbursementBps_ > 10_000) revert InvalidRatio();
        if (reserveFloorBps_ > 10_000) revert InvalidRatio();
        if (maxDisbursementBps_ + reserveFloorBps_ > 10_000) revert InvalidRatio();
        if (guardian_ == address(0)) revert ZeroAddress();

        maxDisbursementRatioBps = maxDisbursementBps_;
        reserveFloorRatioBps = reserveFloorBps_;
        guardian = guardian_;

        for (uint256 i = 0; i < categories_.length; i++) {
            _allowedCategories[categories_[i]] = true;
            emit CategoryUpdated(categories_[i], true);
        }
    }

    function isCategoryAllowed(bytes32 category) public view returns (bool) {
        return _allowedCategories[category];
    }

    function setCategory(bytes32 category, bool allowed) external onlyGuardian {
        _allowedCategories[category] = allowed;
        emit CategoryUpdated(category, allowed);
    }

    function setPaused(bool paused_) external onlyGuardian {
        paused = paused_;
        emit Paused(paused_);
    }

    function transferGuardian(address newGuardian) external onlyGuardian {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    /**
     * @notice Validate a disbursement against programmable constraints.
     */
    function validateDisbursement(
        uint256 amount,
        bytes32 category,
        uint256 nav,
        uint256 availableCash
    ) external view returns (bool ok, string memory reason) {
        if (paused) return (false, "policy:paused");
        if (amount == 0) return (false, "policy:zero-amount");
        if (!_allowedCategories[category]) return (false, "policy:category");
        if (nav == 0) return (false, "policy:empty-nav");
        if (amount > availableCash) return (false, "policy:insufficient-cash");

        uint256 maxAmount = (nav * uint256(maxDisbursementRatioBps)) / 10_000;
        if (amount > maxAmount) return (false, "policy:max-disbursement");

        uint256 minNavAfter = (nav * uint256(reserveFloorRatioBps)) / 10_000;
        if (nav - amount < minNavAfter) return (false, "policy:reserve-floor");

        return (true, "policy:ok");
    }
}

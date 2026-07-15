// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IFundPolicy
 * @notice Interface for on-chain disbursement policy checks (programmable money rules).
 */
interface IFundPolicy {
    function maxDisbursementRatioBps() external view returns (uint16);

    function reserveFloorRatioBps() external view returns (uint16);

    function isCategoryAllowed(bytes32 category) external view returns (bool);

    function validateDisbursement(
        uint256 amount,
        bytes32 category,
        uint256 nav,
        uint256 availableCash
    ) external view returns (bool ok, string memory reason);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFundStrategy} from "./IFundStrategy.sol";

/// @title StreamingDistributionStrategy
/// @notice Autonomously streams a FundVault's idle assets to a fixed set of
/// beneficiaries proportional to a configured weight, at most once per
/// `minIntervalSeconds`. This is a payroll/grant-stream built purely out of
/// programmable-money primitives (ERC20 transfers) — once configured, no
/// human sign-off is required for any individual payout.
contract StreamingDistributionStrategy is IFundStrategy, Ownable {
    using SafeERC20 for IERC20;

    struct Beneficiary {
        address account;
        uint16 weightBps; // share of each distribution, out of BPS_DENOMINATOR
    }

    uint16 public constant BPS_DENOMINATOR = 10_000;

    Beneficiary[] private _beneficiaries;
    uint256 public immutable minIntervalSeconds;

    event BeneficiariesUpdated(uint256 count);
    event Distributed(address indexed to, uint256 amount);

    error EmptyBeneficiaries();
    error WeightsMustSumTo10000();
    error ZeroAddress();

    constructor(address owner_, uint256 minIntervalSeconds_, Beneficiary[] memory initialBeneficiaries)
        Ownable(owner_)
    {
        minIntervalSeconds = minIntervalSeconds_;
        _setBeneficiaries(initialBeneficiaries);
    }

    /// @notice Reconfigure who receives future distributions and in what
    /// proportion. Intended to be called through timelocked governance.
    function setBeneficiaries(Beneficiary[] calldata newBeneficiaries) external onlyOwner {
        _setBeneficiaries(newBeneficiaries);
    }

    function beneficiaries() external view returns (Beneficiary[] memory) {
        return _beneficiaries;
    }

    function beneficiaryCount() external view returns (uint256) {
        return _beneficiaries.length;
    }

    /// @inheritdoc IFundStrategy
    function shouldExecute(uint256 idleAssets, uint256 lastExecutedAt) external view returns (bool) {
        if (idleAssets == 0) return false;
        if (_beneficiaries.length == 0) return false;
        return block.timestamp >= lastExecutedAt + minIntervalSeconds;
    }

    /// @inheritdoc IFundStrategy
    function minInterval() external view returns (uint256) {
        return minIntervalSeconds;
    }

    /// @inheritdoc IFundStrategy
    /// @dev `msg.sender` is expected to be the FundVault, which has already
    /// approved this contract to pull up to `idleAssets` of `asset`.
    function execute(IERC20 asset, uint256 idleAssets) external returns (uint256 assetsConsumed) {
        uint256 len = _beneficiaries.length;
        if (len == 0) revert EmptyBeneficiaries();

        uint256 distributed;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary memory b = _beneficiaries[i];
            uint256 amount = (idleAssets * b.weightBps) / BPS_DENOMINATOR;
            if (amount == 0) continue;
            asset.safeTransferFrom(msg.sender, b.account, amount);
            distributed += amount;
            emit Distributed(b.account, amount);
        }
        return distributed;
    }

    function _setBeneficiaries(Beneficiary[] memory newBeneficiaries) private {
        uint256 len = newBeneficiaries.length;
        if (len == 0) revert EmptyBeneficiaries();

        uint256 totalWeight;
        for (uint256 i = 0; i < len; i++) {
            if (newBeneficiaries[i].account == address(0)) revert ZeroAddress();
            totalWeight += newBeneficiaries[i].weightBps;
        }
        if (totalWeight != BPS_DENOMINATOR) revert WeightsMustSumTo10000();

        delete _beneficiaries;
        for (uint256 i = 0; i < len; i++) {
            _beneficiaries.push(newBeneficiaries[i]);
        }
        emit BeneficiariesUpdated(len);
    }
}

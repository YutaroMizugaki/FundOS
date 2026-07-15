// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/FundVault.sol";
import "../src/FundManager.sol";
import "../src/FeeDistributor.sol";
import "../src/FundGovernance.sol";
import "../src/strategies/YieldStrategy.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice End-to-end FundOS deployment script.
///
///         Usage (local Anvil):
///           forge script script/Deploy.s.sol --broadcast --rpc-url http://localhost:8545
///
///         Required env vars:
///           DEPLOYER_KEY   – private key of deployer
///           ASSET          – address of the ERC-20 base asset (USDC, WETH, …)
///           TREASURY       – address that receives protocol fees
///
///         Optional env vars (defaults shown):
///           MGMT_FEE_BPS   – management fee in BPS (default: 100 = 1%)
///           PERF_FEE_BPS   – performance fee in BPS (default: 1000 = 10%)
///           YIELD_APY_BPS  – demo YieldStrategy APY in BPS (default: 500 = 5%)
///           STRAT_ALLOC    – demo strategy allocation in BPS (default: 8000 = 80%)
///           VOTE_PERIOD    – governance voting period in seconds (default: 3 days)
///           TIMELOCK       – governance timelock in seconds (default: 2 days)
///           QUORUM_BPS     – governance quorum in BPS (default: 1000 = 10%)
///           MAJORITY_BPS   – governance majority in BPS (default: 5100 = 51%)
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address asset = vm.envAddress("ASSET");
        address treasury = vm.envAddress("TREASURY");

        uint256 mgmtFeeBps  = vm.envOr("MGMT_FEE_BPS",  uint256(100));
        uint256 perfFeeBps  = vm.envOr("PERF_FEE_BPS",  uint256(1000));
        uint256 yieldApyBps = vm.envOr("YIELD_APY_BPS", uint256(500));
        uint256 stratAlloc  = vm.envOr("STRAT_ALLOC",   uint256(8000));
        uint256 votePeriod  = vm.envOr("VOTE_PERIOD",   uint256(3 days));
        uint256 timelock    = vm.envOr("TIMELOCK",       uint256(2 days));
        uint256 quorumBps   = vm.envOr("QUORUM_BPS",    uint256(1000));
        uint256 majorityBps = vm.envOr("MAJORITY_BPS",  uint256(5100));

        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        // 1. Deploy vault (FundManager address not known yet – set after)
        FundVault vault = new FundVault(
            IERC20(asset),
            "FundOS Share",
            "FUND",
            treasury,
            mgmtFeeBps,
            perfFeeBps
        );
        console2.log("FundVault  :", address(vault));

        // 2. Deploy manager
        FundManager manager = new FundManager(asset, address(vault));
        console2.log("FundManager:", address(manager));

        // 3. Wire vault → manager
        vault.setFundManager(address(manager));

        // 4. Deploy fee distributor (receives treasury shares)
        FeeDistributor feeDistributor = new FeeDistributor(address(vault));
        console2.log("FeeDistrib :", address(feeDistributor));

        // Configure fee distribution: 60% protocol treasury, 30% strategist, 10% stakers
        address[] memory accounts = new address[](3);
        uint16[]  memory weights  = new uint16[](3);
        string[]  memory labels   = new string[](3);
        accounts[0] = treasury;           weights[0] = 6000; labels[0] = "Protocol Treasury";
        accounts[1] = deployer;             weights[1] = 3000; labels[1] = "Strategist";
        accounts[2] = treasury;            weights[2] = 1000; labels[2] = "Stakers Reserve";
        feeDistributor.setRecipients(accounts, weights, labels);

        // Point vault treasury to fee distributor so fees accumulate there
        vault.setTreasury(address(feeDistributor));

        // 5. Deploy demo YieldStrategy
        YieldStrategy yieldStrategy = new YieldStrategy(asset, address(manager), yieldApyBps);
        console2.log("YieldStrat :", address(yieldStrategy));

        // 6. Register strategy in manager
        manager.addStrategy(address(yieldStrategy), uint16(stratAlloc));

        // 7. Deploy governance and transfer manager ownership to it
        FundGovernance governance = new FundGovernance(
            address(vault),
            address(manager),
            votePeriod,
            timelock,
            quorumBps,
            majorityBps
        );
        console2.log("Governance :", address(governance));

        manager.transferOwnership(address(governance));

        vm.stopBroadcast();

        _printSummary(vault, manager, yieldStrategy, governance, feeDistributor);
    }

    function _printSummary(
        FundVault vault,
        FundManager manager,
        YieldStrategy yieldStrategy,
        FundGovernance governance,
        FeeDistributor feeDistributor
    ) internal view {
        console2.log("");
        console2.log("=== FundOS Deployment Summary ===");
        console2.log("FundVault (FUND)  :", address(vault));
        console2.log("FundManager       :", address(manager));
        console2.log("YieldStrategy     :", address(yieldStrategy));
        console2.log("FundGovernance    :", address(governance));
        console2.log("FeeDistributor    :", address(feeDistributor));
        console2.log("Treasury (vault)  :", vault.treasury());
        console2.log("Manager owner     :", address(governance));
        console2.log("=================================");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AutonomousFundVault} from "../src/AutonomousFundVault.sol";
import {PolicyEngine} from "../src/PolicyEngine.sol";
import {FundFactory} from "../src/FundFactory.sol";
import {IPolicyEngine} from "../src/interfaces/IPolicyEngine.sol";
import {JPYC} from "../src/constants/JPYC.sol";

/// @title DeployJPYCFund
/// @notice Deploy a JPYC-denominated autonomous fund on Ethereum / Polygon / Avalanche.
/// @dev Set JPYC_TOKEN if forking a network where the canonical address differs.
contract DeployJPYCFund is Script {
    function run() external returns (AutonomousFundVault vault, PolicyEngine engine) {
        address jpycToken = vm.envOr("JPYC_TOKEN", JPYC.ETHEREUM);
        address admin = vm.envAddress("ADMIN");
        address executor = vm.envAddress("EXECUTOR");

        FundFactory factory = new FundFactory();

        address[] memory extra;
        FundFactory.FundConfig memory config = FundFactory.FundConfig({
            baseAsset: IERC20(jpycToken),
            vaultName: "FundOS JPYC Vault",
            vaultSymbol: "fJPYC",
            admin: admin,
            executor: executor,
            policy: IPolicyEngine.PolicyConfig({
                minCashReserveBps: 1000, // 10% を JPYC 現金で保持
                maxTransferBps: 2000, // 1 回 20% まで
                dailySpendCap: JPYC.yen(10_000_000), // 1 日 1,000 万円上限
                autonomousMode: true
            }),
            initialAssets: extra
        });

        vm.startBroadcast();
        (vault, engine) = factory.createFund(config);
        vm.stopBroadcast();
    }
}

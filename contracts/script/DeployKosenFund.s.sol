// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KosenSupportFund} from "../src/KosenSupportFund.sol";
import {JPYC} from "../src/constants/JPYC.sol";

/// @title DeployKosenFund
/// @notice Polygon 上に JPYC 高専支援基金をデプロイ。
contract DeployKosenFund is Script {
    function run() external returns (KosenSupportFund fund) {
        address jpyc = vm.envOr("JPYC_TOKEN", JPYC.POLYGON);
        address admin = vm.envAddress("ADMIN");
        address executor = vm.envAddress("EXECUTOR");
        address yieldSink = vm.envAddress("YIELD_SINK");

        vm.startBroadcast();
        fund = new KosenSupportFund(
            IERC20(jpyc),
            admin,
            executor,
            yieldSink,
            2000, // 20% 現金準備
            500, // 1 回 5% まで
            JPYC.yen(500_000) // 月 50 万円まで支援
        );
        vm.stopBroadcast();
    }
}

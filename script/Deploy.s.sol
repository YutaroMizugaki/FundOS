// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AutonomousFund} from "../src/AutonomousFund.sol";
import {FundGovernor} from "../src/FundGovernor.sol";

/// @notice AutonomousFund と FundGovernor をデプロイし、
///         基金の統治権をガバナンスコントラクトへ移譲する。
contract Deploy is Script {
    // --- 基金パラメータ ---
    uint64 constant EPOCH_LENGTH = 30 days; // 支出上限の集計単位
    uint16 constant EPOCH_CAP_BPS = 2_000; // 1 エポックあたり残高の 20% まで
    uint16 constant KEEPER_BOUNTY_BPS = 10; // 執行報酬 0.1%

    // --- ガバナンスパラメータ ---
    uint64 constant VOTING_DELAY = 1 days;
    uint64 constant VOTING_PERIOD = 5 days;
    uint64 constant TIMELOCK_DELAY = 2 days;
    uint16 constant QUORUM_BPS = 1_000; // 総投票力の 10%
    uint256 constant PROPOSAL_THRESHOLD = 0.1 ether; // 0.1 ETH 相当の寄付で提案可能

    function run() external {
        address guardian = vm.envOr("GUARDIAN", msg.sender);

        vm.startBroadcast();

        AutonomousFund fund =
            new AutonomousFund(msg.sender, guardian, EPOCH_LENGTH, EPOCH_CAP_BPS, KEEPER_BOUNTY_BPS);
        FundGovernor governor =
            new FundGovernor(fund, VOTING_DELAY, VOTING_PERIOD, TIMELOCK_DELAY, QUORUM_BPS, PROPOSAL_THRESHOLD);

        // 統治権をガバナンスへ移譲 (以後、基金の設定変更・助成作成は議決が必須)
        fund.setGovernor(address(governor));

        vm.stopBroadcast();

        console.log("AutonomousFund:", address(fund));
        console.log("FundGovernor:  ", address(governor));
        console.log("Guardian:      ", guardian);
    }
}

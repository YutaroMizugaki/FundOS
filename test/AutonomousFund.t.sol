// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AutonomousFund} from "../src/AutonomousFund.sol";

contract AutonomousFundTest is Test {
    AutonomousFund fund;

    // テストコントラクト自身が executeGrant を呼んだ際のキーパー報酬を受け取れるようにする
    receive() external payable {}

    address governor = makeAddr("governor");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address grantee = makeAddr("grantee");
    address keeper = makeAddr("keeper");

    uint64 constant EPOCH = 30 days;
    uint16 constant CAP_BPS = 2_000; // 20%
    uint16 constant BOUNTY_BPS = 10; // 0.1%

    function setUp() public {
        fund = new AutonomousFund(governor, guardian, EPOCH, CAP_BPS, BOUNTY_BPS);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    // -----------------------------------------------------------
    // 寄付と投票力
    // -----------------------------------------------------------

    function test_DonateGrantsPower() public {
        vm.prank(alice);
        fund.donate{value: 10 ether}();

        assertEq(fund.powerOf(alice), 10 ether);
        assertEq(fund.totalPower(), 10 ether);
        assertEq(fund.totalDonated(alice), 10 ether);
        assertEq(address(fund).balance, 10 ether);
    }

    function test_ReceiveFallbackDonates() public {
        vm.prank(alice);
        (bool ok,) = address(fund).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(fund.powerOf(alice), 3 ether);
    }

    function test_DonateFor() public {
        vm.prank(alice);
        fund.donateFor{value: 5 ether}(bob);
        assertEq(fund.powerOf(bob), 5 ether);
        assertEq(fund.powerOf(alice), 0);
    }

    function test_PowerSnapshots() public {
        vm.warp(1_000);
        vm.prank(alice);
        fund.donate{value: 1 ether}();

        vm.warp(2_000);
        vm.prank(alice);
        fund.donate{value: 2 ether}();

        assertEq(fund.getPowerAt(alice, 999), 0);
        assertEq(fund.getPowerAt(alice, 1_000), 1 ether);
        assertEq(fund.getPowerAt(alice, 1_999), 1 ether);
        assertEq(fund.getPowerAt(alice, 2_000), 3 ether);
        assertEq(fund.getTotalPowerAt(1_500), 1 ether);
    }

    function test_RevertZeroDonation() public {
        vm.prank(alice);
        vm.expectRevert(AutonomousFund.ZeroAmount.selector);
        fund.donate{value: 0}();
    }

    // -----------------------------------------------------------
    // 助成プログラムの自動執行
    // -----------------------------------------------------------

    function _fundTreasury(uint256 amount) internal {
        vm.prank(alice);
        fund.donate{value: amount}();
    }

    function test_GrantLifecycle() public {
        _fundTreasury(100 ether);

        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 1 ether, 7 days, 4, uint64(block.timestamp + 7 days));

        // 期日前は執行不可
        assertFalse(fund.grantDue(id));
        vm.prank(keeper);
        vm.expectRevert(AutonomousFund.NothingDue.selector);
        fund.executeGrant(id);

        // 期日到来: 誰でも執行でき、キーパー報酬が支払われる
        vm.warp(block.timestamp + 7 days);
        assertTrue(fund.grantDue(id));
        vm.prank(keeper);
        uint256 paid = fund.executeGrant(id);

        assertEq(paid, 1 ether);
        assertEq(grantee.balance, 1 ether);
        assertEq(keeper.balance, (1 ether * BOUNTY_BPS) / 10_000);
        assertEq(fund.getGrant(id).periodsLeft, 3);
    }

    function test_GrantCatchUpMissedPeriods() public {
        _fundTreasury(100 ether);

        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 1 ether, 7 days, 4, uint64(block.timestamp));

        // 3 期分放置しても、1 回の実行でまとめて精算される
        vm.warp(block.timestamp + 15 days);
        vm.prank(keeper);
        uint256 paid = fund.executeGrant(id);

        assertEq(paid, 3 ether);
        assertEq(fund.getGrant(id).periodsLeft, 1);
    }

    function test_GrantDeactivatesAfterLastPeriod() public {
        _fundTreasury(100 ether);

        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 1 ether, 7 days, 2, uint64(block.timestamp));

        vm.warp(block.timestamp + 100 days);
        vm.prank(keeper);
        uint256 paid = fund.executeGrant(id);

        assertEq(paid, 2 ether); // 残回数を超えては支給されない
        assertFalse(fund.getGrant(id).active);

        vm.expectRevert(AutonomousFund.GrantNotActive.selector);
        fund.executeGrant(id);
    }

    function test_OnlyGovernorCreatesGrants() public {
        vm.prank(alice);
        vm.expectRevert(AutonomousFund.NotGovernor.selector);
        fund.createGrant(grantee, 1 ether, 7 days, 4, 0);
    }

    function test_GuardianCanCancelGrant() public {
        _fundTreasury(10 ether);
        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 1 ether, 7 days, 4, 0);

        vm.prank(guardian);
        fund.cancelGrant(id);
        assertFalse(fund.getGrant(id).active);
    }

    // -----------------------------------------------------------
    // エポック支出上限
    // -----------------------------------------------------------

    function test_EpochCapEnforced() public {
        _fundTreasury(100 ether); // 上限 = 20 ether / エポック

        vm.prank(governor);
        fund.transferOut(grantee, 20 ether); // ちょうど上限まで OK

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(AutonomousFund.EpochCapExceeded.selector, 1 ether, 0));
        fund.transferOut(grantee, 1 ether);

        // 次エポックで予算がリセットされる (残高 80 ether の 20% = 16 ether)
        vm.warp(block.timestamp + EPOCH);
        vm.prank(governor);
        fund.transferOut(grantee, 16 ether);
        assertEq(grantee.balance, 36 ether);
    }

    function test_EpochRemainingView() public {
        _fundTreasury(100 ether);
        assertEq(fund.epochRemaining(), 20 ether);

        vm.prank(governor);
        fund.transferOut(grantee, 5 ether);
        assertEq(fund.epochRemaining(), 15 ether);
    }

    function test_GrantExecutionCountsTowardCap() public {
        _fundTreasury(100 ether);

        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 25 ether, 7 days, 1, uint64(block.timestamp));

        // 25 ether > 上限 20 ether → 執行できない
        vm.expectRevert(abi.encodeWithSelector(AutonomousFund.EpochCapExceeded.selector, 25 ether, 20 ether));
        fund.executeGrant(id);
    }

    // -----------------------------------------------------------
    // 緊急停止
    // -----------------------------------------------------------

    function test_PauseBlocksSpending() public {
        _fundTreasury(100 ether);
        vm.prank(governor);
        uint256 id = fund.createGrant(grantee, 1 ether, 7 days, 4, uint64(block.timestamp));

        vm.prank(guardian);
        fund.pause();

        vm.expectRevert(AutonomousFund.IsPaused.selector);
        fund.executeGrant(id);

        // 解除はガバナンスのみ
        vm.prank(guardian);
        vm.expectRevert(AutonomousFund.NotGovernor.selector);
        fund.unpause();

        vm.prank(governor);
        fund.unpause();
        fund.executeGrant(id);
        assertEq(grantee.balance, 1 ether);
    }
}

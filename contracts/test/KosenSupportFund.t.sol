// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KosenSupportFund} from "../src/KosenSupportFund.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {JPYC} from "../src/constants/JPYC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract KosenSupportFundTest is Test {
    MockJPYC jpyc;
    KosenSupportFund fund;

    address admin = makeAddr("admin");
    address executor = makeAddr("executor");
    address yieldSink = makeAddr("yieldSink");
    address student = makeAddr("student");
    address donor = makeAddr("donor");

    uint256 constant FUND = 10_000_000e18; // 1,000 万円

    function setUp() public {
        jpyc = new MockJPYC();
        fund = new KosenSupportFund(
            IERC20(address(jpyc)),
            admin,
            executor,
            yieldSink,
            2000,
            500,
            JPYC.yen(500_000)
        );

        vm.prank(admin);
        fund.setGrantee(student, true);

        jpyc.mint(donor, FUND);
        vm.startPrank(donor);
        jpyc.approve(address(fund), type(uint256).max);
        fund.deposit(FUND, donor);
        vm.stopPrank();
    }

    function test_deposit() public view {
        assertEq(fund.totalAssets(), FUND);
    }

    function test_deployYield_within_reserve() public {
        uint256 amount = JPYC.yen(5_000_000); // 500 万円 → 残り 50% > 20% reserve

        vm.prank(executor);
        fund.deployYield(amount);

        assertEq(jpyc.balanceOf(yieldSink), amount);
    }

    function test_deployYield_blocked_below_reserve() public {
        vm.prank(executor);
        vm.expectRevert("KosenFund: reserve breach");
        fund.deployYield(JPYC.yen(8_500_000));
    }

    function test_supportStudent() public {
        uint256 grant = JPYC.yen(100_000);
        bytes32 ref = keccak256("maker-faire-2026");

        vm.prank(executor);
        fund.supportStudent(student, grant, ref);

        assertEq(jpyc.balanceOf(student), grant);
        assertEq(fund.monthlyGrantSpend(), grant);
    }

    function test_supportStudent_not_grantee() public {
        address unknown = makeAddr("unknown");
        vm.prank(executor);
        vm.expectRevert("KosenFund: not grantee");
        fund.supportStudent(unknown, JPYC.yen(10_000), bytes32(0));
    }

    function test_supportStudent_exceeds_monthly_cap() public {
        vm.startPrank(executor);
        fund.supportStudent(student, JPYC.yen(400_000), keccak256("a"));
        vm.expectRevert("KosenFund: monthly cap");
        fund.supportStudent(student, JPYC.yen(200_000), keccak256("b"));
        vm.stopPrank();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/strategies/YieldStrategy.sol";
import "../src/mocks/MockERC20.sol";

contract YieldStrategyTest is Test {
    MockERC20 internal usdc;
    YieldStrategy internal strategy;

    address internal manager = makeAddr("manager");

    uint256 constant PRINCIPAL = 50_000e6;
    uint256 constant APY_BPS = 500; // 5%

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        strategy = new YieldStrategy(address(usdc), manager, APY_BPS);

        // Fund manager with USDC, approve strategy
        usdc.mint(manager, PRINCIPAL);
        vm.prank(manager);
        usdc.approve(address(strategy), type(uint256).max);
    }

    function test_deposit_updatesPrincipal() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);
        assertEq(strategy.principal(), PRINCIPAL);
        assertEq(strategy.totalAssets(), PRINCIPAL);
    }

    function test_withdraw_reducesPrincipal() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);

        vm.prank(manager);
        strategy.withdraw(20_000e6);

        assertEq(strategy.principal(), 30_000e6);
    }

    function test_harvest_collectsYield() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);

        // Warp 1 year
        vm.warp(block.timestamp + 365 days);

        // Expected yield: 50000 * 5% = 2500 USDC
        uint256 expectedYield = (PRINCIPAL * APY_BPS) / 10_000;
        usdc.mint(address(strategy), expectedYield);

        uint256 managerBefore = usdc.balanceOf(manager);

        vm.prank(manager);
        uint256 profit = strategy.harvest();

        assertApproxEqAbs(profit, expectedYield, 100, "should harvest ~5% APY");
        assertGt(usdc.balanceOf(manager), managerBefore);
    }

    function test_pendingYield_growsOverTime() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);

        vm.warp(block.timestamp + 180 days);
        uint256 halfYear = strategy.pendingYield();

        vm.warp(block.timestamp + 185 days); // total 365 days
        uint256 fullYear = strategy.pendingYield();

        assertGt(fullYear, halfYear, "yield grows with time");
    }

    function test_emergencyExit_returnsAll() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);

        vm.prank(manager);
        strategy.emergencyExit();

        assertEq(strategy.totalAssets(), 0);
        assertEq(usdc.balanceOf(manager), PRINCIPAL);
        assertTrue(strategy.emergencyExited());
    }

    function test_deposit_afterEmergencyExit_reverts() public {
        vm.prank(manager);
        strategy.deposit(PRINCIPAL);

        vm.prank(manager);
        strategy.emergencyExit();

        usdc.mint(manager, 1000e6);
        vm.prank(manager);
        usdc.approve(address(strategy), 1000e6);

        vm.prank(manager);
        vm.expectRevert("Strategy: emergency exited");
        strategy.deposit(1000e6);
    }

    function test_onlyManager_reverts() public {
        vm.expectRevert("Strategy: caller is not manager");
        strategy.deposit(PRINCIPAL);
    }
}

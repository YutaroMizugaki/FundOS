// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/FundManager.sol";
import "../src/strategies/YieldStrategy.sol";
import "../src/mocks/MockERC20.sol";

contract FundManagerTest is Test {
    MockERC20 internal usdc;
    FundManager internal manager;
    YieldStrategy internal stratA;
    YieldStrategy internal stratB;

    address internal vault = makeAddr("vault");
    address internal owner;

    uint256 constant AMOUNT = 100_000e6;

    function setUp() public {
        owner = address(this);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        manager = new FundManager(address(usdc), vault);

        stratA = new YieldStrategy(address(usdc), address(manager), 500); // 5% APY
        stratB = new YieldStrategy(address(usdc), address(manager), 300); // 3% APY
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Strategy management
    // ──────────────────────────────────────────────────────────────────────────

    function test_addStrategy() public {
        manager.addStrategy(address(stratA), 6000); // 60%
        assertEq(manager.strategyCount(), 1);

        IFundManager.StrategyInfo memory info = manager.getStrategy(0);
        assertEq(info.strategy, address(stratA));
        assertEq(info.targetBps, 6000);
        assertTrue(info.active);
    }

    function test_addStrategy_duplicateReverts() public {
        manager.addStrategy(address(stratA), 3000);
        vm.expectRevert("FundManager: already added");
        manager.addStrategy(address(stratA), 2000);
    }

    function test_addStrategy_exceedsAllocationReverts() public {
        manager.addStrategy(address(stratA), 6000);
        vm.expectRevert("FundManager: allocation exceeds 100%");
        manager.addStrategy(address(stratB), 5000); // 60+50 = 110%
    }

    function test_updateAllocation() public {
        manager.addStrategy(address(stratA), 5000);
        manager.updateAllocation(address(stratA), 3000);
        IFundManager.StrategyInfo memory info = manager.getStrategy(0);
        assertEq(info.targetBps, 3000);
    }

    function test_removeStrategy_liquidatesPosition() public {
        manager.addStrategy(address(stratA), 5000);

        // Deploy capital
        usdc.mint(vault, AMOUNT);
        vm.startPrank(vault);
        usdc.transfer(address(manager), AMOUNT);
        manager.deployCapital(AMOUNT);
        vm.stopPrank();

        uint256 stratABalance = stratA.totalAssets();
        assertGt(stratABalance, 0, "strategy should have assets");

        manager.removeStrategy(address(stratA));

        // Assets should be back in manager (idle)
        assertEq(stratA.totalAssets(), 0);
        assertGt(usdc.balanceOf(address(manager)), 0);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Capital flow
    // ──────────────────────────────────────────────────────────────────────────

    function test_deployCapital_splitsAcrossStrategies() public {
        manager.addStrategy(address(stratA), 6000); // 60%
        manager.addStrategy(address(stratB), 3000); // 30%
        // 10% stays idle

        usdc.mint(vault, AMOUNT);
        vm.startPrank(vault);
        usdc.transfer(address(manager), AMOUNT);
        manager.deployCapital(AMOUNT);
        vm.stopPrank();

        uint256 aBalance = stratA.totalAssets();
        uint256 bBalance = stratB.totalAssets();
        uint256 idle = usdc.balanceOf(address(manager));

        assertApproxEqAbs(aBalance, (AMOUNT * 6000) / 10000, 2);
        assertApproxEqAbs(bBalance, (AMOUNT * 3000) / 10000, 2);
        assertApproxEqAbs(idle, (AMOUNT * 1000) / 10000, 2);
    }

    function test_withdrawCapital_returnsToVault() public {
        manager.addStrategy(address(stratA), 8000);

        usdc.mint(vault, AMOUNT);
        vm.startPrank(vault);
        usdc.transfer(address(manager), AMOUNT);
        manager.deployCapital(AMOUNT);
        vm.stopPrank();

        uint256 withdrawAmount = 40_000e6;
        vm.prank(vault);
        manager.withdrawCapital(withdrawAmount);

        assertApproxEqAbs(usdc.balanceOf(vault), withdrawAmount, 2);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Rebalancing
    // ──────────────────────────────────────────────────────────────────────────

    function test_rebalance_correctsDeviation() public {
        manager.addStrategy(address(stratA), 5000);
        manager.addStrategy(address(stratB), 5000);

        usdc.mint(vault, AMOUNT);
        vm.startPrank(vault);
        usdc.transfer(address(manager), AMOUNT);
        manager.deployCapital(AMOUNT);
        vm.stopPrank();

        // First reduce stratB to 30%, then raise stratA to 70% (order matters for sum check)
        manager.updateAllocation(address(stratB), 3000);
        manager.updateAllocation(address(stratA), 7000);

        // Add more idle funds for rebalancing
        usdc.mint(address(manager), 1000e6);

        manager.rebalance();

        // After rebalancing stratA should have more than stratB
        assertGt(stratA.totalAssets(), stratB.totalAssets());
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Harvest
    // ──────────────────────────────────────────────────────────────────────────

    function test_harvestAll_collectsYield() public {
        manager.addStrategy(address(stratA), 5000);

        usdc.mint(vault, AMOUNT);
        vm.startPrank(vault);
        usdc.transfer(address(manager), AMOUNT);
        manager.deployCapital(AMOUNT);
        vm.stopPrank();

        // Warp 1 year to accrue yield
        vm.warp(block.timestamp + 365 days);

        // Fund strategy contract with "yield" tokens to simulate external protocol payouts
        uint256 expectedYield = (AMOUNT * 5000 / 10000) * 500 / 10000;
        usdc.mint(address(stratA), expectedYield);

        uint256 managerBefore = usdc.balanceOf(address(manager));
        uint256 profit = manager.harvestAll();

        assertGt(profit, 0, "should harvest positive profit");
        assertGt(usdc.balanceOf(address(manager)), managerBefore);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Access control
    // ──────────────────────────────────────────────────────────────────────────

    function test_deployCapital_onlyVault() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert("FundManager: caller is not vault");
        manager.deployCapital(1000);
    }

    function test_addStrategy_onlyOwner() public {
        vm.prank(makeAddr("random"));
        vm.expectRevert();
        manager.addStrategy(address(stratA), 1000);
    }
}

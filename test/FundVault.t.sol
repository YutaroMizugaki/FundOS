// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/FundVault.sol";
import "../src/FundManager.sol";
import "../src/strategies/YieldStrategy.sol";
import "../src/mocks/MockERC20.sol";

contract FundVaultTest is Test {
    MockERC20 internal usdc;
    FundVault internal vault;
    FundManager internal manager;
    YieldStrategy internal strategy;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");

    uint256 constant INITIAL = 10_000e6; // 10 000 USDC

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy vault without a manager first
        vault = new FundVault(
            IERC20(address(usdc)),
            "FundOS Share",
            "FUND",
            treasury,
            100,  // 1% management fee
            1000  // 10% performance fee
        );

        // Deploy manager pointing at vault
        manager = new FundManager(address(usdc), address(vault));

        // Wire vault → manager
        vault.setFundManager(address(manager));

        // Allow vault to call manager (it already is the vault registered)
        // Deploy a 5% APY strategy
        strategy = new YieldStrategy(address(usdc), address(manager), 500);

        // Fund users
        usdc.mint(alice, INITIAL);
        usdc.mint(bob, INITIAL);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Deposit / redeem
    // ──────────────────────────────────────────────────────────────────────────

    function test_deposit_mintsShares() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        uint256 shares = vault.deposit(INITIAL, alice);
        vm.stopPrank();

        assertEq(shares, INITIAL, "1:1 initial share ratio");
        assertEq(vault.balanceOf(alice), INITIAL);
    }

    function test_redeem_returnsAssets() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vault.deposit(INITIAL, alice);

        // Redeem all shares
        uint256 shares = vault.balanceOf(alice);
        vault.approve(address(vault), shares);
        uint256 assets = vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertApproxEqAbs(assets, INITIAL, 2, "should get back ~initial deposit");
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_depositCap_reverts() public {
        vault.setDepositCap(5_000e6);

        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vm.expectRevert("FundVault: cap exceeded");
        vault.deposit(INITIAL, alice);
        vm.stopPrank();
    }

    function test_pause_blocksDeposit() public {
        vault.pause();

        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vm.expectRevert();
        vault.deposit(INITIAL, alice);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Two depositors – share dilution / fair splits
    // ──────────────────────────────────────────────────────────────────────────

    function test_twoDepositors_fairShare() public {
        // Alice deposits
        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vault.deposit(INITIAL, alice);
        vm.stopPrank();

        // Bob deposits same amount → should get same shares
        vm.startPrank(bob);
        usdc.approve(address(vault), INITIAL);
        uint256 bobShares = vault.deposit(INITIAL, bob);
        vm.stopPrank();

        assertApproxEqAbs(vault.balanceOf(alice), bobShares, 2);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Management fee
    // ──────────────────────────────────────────────────────────────────────────

    function test_managementFee_mintsToTreasury() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vault.deposit(INITIAL, alice);
        vm.stopPrank();

        // Warp 1 year
        vm.warp(block.timestamp + 365 days);

        // Trigger fee collection via a new deposit
        vm.startPrank(bob);
        usdc.approve(address(vault), 1e6);
        vault.deposit(1e6, bob);
        vm.stopPrank();

        uint256 treasuryBal = vault.balanceOf(treasury);
        assertGt(treasuryBal, 0, "treasury should have received mgmt fee shares");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Fees validation
    // ──────────────────────────────────────────────────────────────────────────

    function test_setFees_tooHigh_reverts() public {
        vm.expectRevert("FundVault: mgmt fee too high");
        vault.setFees(300, 1000); // 3% mgmt > MAX_MANAGEMENT_FEE_BPS
    }

    function test_totalAssets_equalsFundManagerTotal() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), INITIAL);
        vault.deposit(INITIAL, alice);
        vm.stopPrank();

        assertEq(vault.totalAssets(), manager.totalAssets());
    }
}

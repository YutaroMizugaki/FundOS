// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AutonomousFundVault} from "../src/AutonomousFundVault.sol";
import {PolicyEngine} from "../src/PolicyEngine.sol";
import {FundFactory} from "../src/FundFactory.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IPolicyEngine} from "../src/interfaces/IPolicyEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AutonomousFundTest is Test {
    MockERC20 usdc;
    AutonomousFundVault vault;
    PolicyEngine engine;
    FundFactory factory;

    address admin = makeAddr("admin");
    address executor = makeAddr("executor");
    address lp = makeAddr("lp");
    address recipient = makeAddr("recipient");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        factory = new FundFactory();

        address[] memory extra;
        FundFactory.FundConfig memory config = FundFactory.FundConfig({
            baseAsset: IERC20(address(usdc)),
            vaultName: "FundOS Autonomous Vault",
            vaultSymbol: "fAUV",
            admin: admin,
            executor: executor,
            policy: IPolicyEngine.PolicyConfig({
                minCashReserveBps: 1000, // 10%
                maxTransferBps: 2000, // 20%
                dailySpendCap: 500_000e6,
                autonomousMode: true
            }),
            initialAssets: extra
        });

        (vault, engine) = factory.createFund(config);

        usdc.mint(lp, 1_000_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6, lp);
        vm.stopPrank();
    }

    function test_deposit_mints_shares() public view {
        assertEq(vault.balanceOf(lp), 1_000_000e6);
        assertEq(vault.totalAssets(), 1_000_000e6);
    }

    function test_executor_can_transfer_within_policy() public {
        uint256 amount = 100_000e6;
        bytes32 reason = keccak256("rebalance-to-yield");

        vm.prank(executor);
        vault.executeManagedTransfer(address(usdc), recipient, amount, reason);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(engine.dailySpendToday(), amount);
    }

    function test_non_executor_cannot_transfer() public {
        vm.prank(lp);
        vm.expectRevert("FundVault: not executor");
        vault.executeManagedTransfer(address(usdc), recipient, 1e6, bytes32(0));
    }

    function test_transfer_blocked_when_exceeds_reserve() public {
        uint256 amount = 950_000e6; // would leave < 10% reserve

        vm.prank(executor);
        vm.expectRevert("FundVault: policy rejected");
        vault.executeManagedTransfer(address(usdc), recipient, amount, bytes32(0));
    }

    function test_pause_blocks_deposits() public {
        vm.prank(admin);
        vault.pause();

        usdc.mint(lp, 100e6);
        vm.startPrank(lp);
        vm.expectRevert();
        vault.deposit(100e6, lp);
        vm.stopPrank();
    }

    function test_autonomous_mode_off_blocks_execution() public {
        vm.prank(admin);
        engine.setAutonomousMode(false);

        vm.prank(executor);
        vm.expectRevert("FundVault: policy rejected");
        vault.executeManagedTransfer(address(usdc), recipient, 1_000e6, bytes32(0));
    }
}

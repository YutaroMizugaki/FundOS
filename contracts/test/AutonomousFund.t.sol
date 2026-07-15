// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AutonomousFundVault} from "../src/AutonomousFundVault.sol";
import {PolicyEngine} from "../src/PolicyEngine.sol";
import {FundFactory} from "../src/FundFactory.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {JPYC} from "../src/constants/JPYC.sol";
import {IPolicyEngine} from "../src/interfaces/IPolicyEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AutonomousFundTest is Test {
    MockJPYC jpyc;
    AutonomousFundVault vault;
    PolicyEngine engine;
    FundFactory factory;

    address admin = makeAddr("admin");
    address executor = makeAddr("executor");
    address lp = makeAddr("lp");
    address recipient = makeAddr("recipient");

    uint256 constant FUND_SIZE = 100_000_000e18; // 1 億円
    uint256 constant DAILY_CAP = 10_000_000e18; // 1,000 万円/日

    function setUp() public {
        jpyc = new MockJPYC();
        factory = new FundFactory();

        address[] memory extra;
        FundFactory.FundConfig memory config = FundFactory.FundConfig({
            baseAsset: IERC20(address(jpyc)),
            vaultName: "FundOS JPYC Vault",
            vaultSymbol: "fJPYC",
            admin: admin,
            executor: executor,
            policy: IPolicyEngine.PolicyConfig({
                minCashReserveBps: 1000, // 10%
                maxTransferBps: 2000, // 20%
                dailySpendCap: DAILY_CAP,
                autonomousMode: true
            }),
            initialAssets: extra
        });

        (vault, engine) = factory.createFund(config);

        jpyc.mint(lp, FUND_SIZE);
        vm.startPrank(lp);
        jpyc.approve(address(vault), type(uint256).max);
        vault.deposit(FUND_SIZE, lp);
        vm.stopPrank();
    }

    function test_deposit_mints_shares() public view {
        assertEq(vault.balanceOf(lp), FUND_SIZE);
        assertEq(vault.totalAssets(), FUND_SIZE);
    }

    function test_executor_can_transfer_within_policy() public {
        uint256 amount = JPYC.yen(10_000_000); // 1,000 万円
        bytes32 reason = keccak256("rebalance-to-yield");

        vm.prank(executor);
        vault.executeManagedTransfer(address(jpyc), recipient, amount, reason);

        assertEq(jpyc.balanceOf(recipient), amount);
        assertEq(engine.dailySpendToday(), amount);
    }

    function test_non_executor_cannot_transfer() public {
        vm.prank(lp);
        vm.expectRevert("FundVault: not executor");
        vault.executeManagedTransfer(address(jpyc), recipient, JPYC.yen(1), bytes32(0));
    }

    function test_transfer_blocked_when_exceeds_reserve() public {
        uint256 amount = JPYC.yen(95_000_000); // 10% リザーブを下回る

        vm.prank(executor);
        vm.expectRevert("FundVault: policy rejected");
        vault.executeManagedTransfer(address(jpyc), recipient, amount, bytes32(0));
    }

    function test_pause_blocks_deposits() public {
        vm.prank(admin);
        vault.pause();

        jpyc.mint(lp, JPYC.yen(100));
        vm.startPrank(lp);
        vm.expectRevert();
        vault.deposit(JPYC.yen(100), lp);
        vm.stopPrank();
    }

    function test_autonomous_mode_off_blocks_execution() public {
        vm.prank(admin);
        engine.setAutonomousMode(false);

        vm.prank(executor);
        vm.expectRevert("FundVault: policy rejected");
        vault.executeManagedTransfer(address(jpyc), recipient, JPYC.yen(1_000_000), bytes32(0));
    }

    function test_jpyc_constants_match_canonical_address() public pure {
        assertEq(JPYC.ETHEREUM, 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29);
        assertEq(JPYC.DECIMALS, 18);
        assertEq(JPYC.yen(1), 1e18);
    }
}

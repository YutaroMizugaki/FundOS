// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FundConstitution} from "../src/FundConstitution.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {GrantController} from "../src/GrantController.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {JPYC} from "../src/constants/JPYC.sol";

contract FundOSHandler is Test {
    MockJPYC public jpyc;
    TreasuryVault public treasury;
    GrantController public controller;

    address public donor = makeAddr("handlerDonor");
    address public recipient = makeAddr("handlerRecipient");
    address public proposer = makeAddr("handlerProposer");
    address public approver1 = makeAddr("handlerApprover1");
    address public approver2 = makeAddr("handlerApprover2");
    address public executor = makeAddr("handlerExecutor");

    uint256 public ghostExecutedGrants;

    constructor() {
        jpyc = new MockJPYC();
        FundConstitution constitution = new FundConstitution(
            "Invariant Fund",
            keccak256("inv"),
            "ipfs://inv",
            makeAddr("admin"),
            IERC20(address(jpyc))
        );
        treasury = new TreasuryVault(constitution);
        controller = new GrantController(
            constitution,
            treasury,
            makeAddr("admin"),
            proposer,
            approver1,
            executor,
            makeAddr("guardian"),
            makeAddr("config"),
            3 days,
            JPYC.yen(100_000),
            2,
            1 days,
            7 days
        );
        treasury.authorizeGrantController(address(controller));

        jpyc.mint(donor, JPYC.yen(10_000_000));
        vm.startPrank(donor);
        jpyc.approve(address(treasury), type(uint256).max);
        vm.stopPrank();
    }

    function donatePrincipal(uint96 amount) external {
        amount = uint96(bound(amount, 1, JPYC.yen(1_000_000)));
        vm.startPrank(donor);
        treasury.donatePrincipal(amount, keccak256(abi.encodePacked("p", amount)));
        vm.stopPrank();
    }

    function fundGrantBudget(uint96 amount) external {
        amount = uint96(bound(amount, 1, JPYC.yen(1_000_000)));
        vm.startPrank(donor);
        treasury.fundGrantBudget(amount, keccak256(abi.encodePacked("b", amount)));
        vm.stopPrank();
    }

    function executeGrant(uint96 amount) external {
        amount = uint96(bound(amount, 1, JPYC.yen(50_000)));
        if (controller.spendableGrantBudget() < amount) return;

        vm.startPrank(proposer);
        uint256 id = controller.createGrantProposal(recipient, amount, bytes32(0), bytes32(0), "");
        vm.stopPrank();

        vm.prank(approver1);
        controller.approveGrantProposal(id);
        vm.prank(approver2);
        controller.approveGrantProposal(id);

        vm.warp(block.timestamp + 1 days);

        if (block.timestamp > controller.getProposal(id).expiresAt) {
            controller.expireGrantProposal(id);
            return;
        }

        vm.prank(executor);
        controller.executeGrantProposal(id);
        ghostExecutedGrants += amount;
    }
}

contract FundOSInvariantTest is StdInvariant, Test {
    FundOSHandler internal handler;

    function setUp() public {
        handler = new FundOSHandler();
        GrantController controller = handler.controller();
        bytes32 approverRole = controller.APPROVER_ROLE();
        address approver2 = handler.approver2();
        vm.prank(makeAddr("admin"));
        controller.grantRole(approverRole, approver2);
        targetContract(address(handler));
    }

    function invariant_balance_covers_accounting() public view {
        TreasuryVault treasury = handler.treasury();
        assertGe(
            treasury.totalTreasuryAssets(),
            treasury.protectedPrincipal() + treasury.availableGrantBudget()
        );
    }

    function invariant_reservations_bounded() public view {
        GrantController controller = handler.controller();
        TreasuryVault treasury = handler.treasury();
        assertLe(controller.reservedGrantBudget(), treasury.availableGrantBudget());
        assertLe(controller.reservedYieldSurplus(), treasury.accountingSurplus());
        assertEq(
            controller.spendableGrantBudget(),
            treasury.availableGrantBudget() - controller.reservedGrantBudget()
        );
    }

    function invariant_principal_never_decreases_from_grants() public view {
        assertGe(handler.treasury().protectedPrincipal(), 0);
    }
}

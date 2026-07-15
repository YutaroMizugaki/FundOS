// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FundConstitution} from "../src/FundConstitution.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {GrantController} from "../src/GrantController.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {JPYC} from "../src/constants/JPYC.sol";

contract MaliciousJPYC is MockJPYC {
    TreasuryVault public target;
    bool public attackEnabled;
    bool private _entered;

    function configureAttack(TreasuryVault target_, bool enabled) external {
        target = target_;
        attackEnabled = enabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackEnabled && !_entered) {
            _entered = true;
            target.donatePrincipal(1, bytes32(0));
        }
        return super.transfer(to, amount);
    }
}

contract FundOSTest is Test {
    MockJPYC jpyc;
    FundConstitution constitution;
    TreasuryVault treasury;
    GrantController controller;

    address admin = makeAddr("admin");
    address proposer = makeAddr("proposer");
    address approver1 = makeAddr("approver1");
    address approver2 = makeAddr("approver2");
    address executor = makeAddr("executor");
    address guardian = makeAddr("guardian");
    address config = makeAddr("config");
    address donor = makeAddr("donor");
    address recipient = makeAddr("recipient");

    uint256 constant PRINCIPAL = 5_000_000e18;
    uint256 constant BUDGET = 1_000_000e18;
    uint256 constant MAX_GRANT = 2_000_000e18;

    function setUp() public {
        jpyc = new MockJPYC();
        constitution = new FundConstitution(
            "FundOS Test Fund",
            keccak256("test-purpose"),
            "ipfs://test",
            admin,
            IERC20(address(jpyc))
        );
        treasury = new TreasuryVault(constitution);
        controller = new GrantController(
            constitution,
            treasury,
            admin,
            proposer,
            approver1,
            executor,
            guardian,
            config,
            3 days,
            MAX_GRANT,
            2,
            2 days,
            14 days
        );
        treasury.authorizeGrantController(address(controller));

        bytes32 approverRole = keccak256("APPROVER_ROLE");
        vm.prank(admin);
        controller.grantRole(approverRole, approver2);

        jpyc.mint(donor, PRINCIPAL + BUDGET);
        vm.startPrank(donor);
        jpyc.approve(address(treasury), type(uint256).max);
        treasury.donatePrincipal(PRINCIPAL, keccak256("donor-a"));
        treasury.fundGrantBudget(BUDGET, keccak256("budget-a"));
        vm.stopPrank();
    }

    function test_donatePrincipal_increases_balance_and_principal() public {
        address newDonor = makeAddr("newDonor");
        uint256 amount = JPYC.yen(100_000);
        jpyc.mint(newDonor, amount);

        vm.startPrank(newDonor);
        jpyc.approve(address(treasury), amount);
        treasury.donatePrincipal(amount, keccak256("donor-b"));
        vm.stopPrank();

        assertEq(treasury.protectedPrincipal(), PRINCIPAL + amount);
        assertEq(treasury.totalTreasuryAssets(), PRINCIPAL + BUDGET + amount);
    }

    function test_fundGrantBudget_increases_available_budget() public {
        address funder = makeAddr("funder");
        uint256 amount = JPYC.yen(50_000);
        jpyc.mint(funder, amount);

        vm.startPrank(funder);
        jpyc.approve(address(treasury), amount);
        treasury.fundGrantBudget(amount, keccak256("source-b"));
        vm.stopPrank();

        assertEq(treasury.availableGrantBudget(), BUDGET + amount);
    }

    function test_no_withdraw_or_share_token() public view {
        assertEq(jpyc.balanceOf(donor), 0);
    }

    function test_donatePrincipal_zero_reverts() public {
        vm.expectRevert(TreasuryVault.ZeroAmount.selector);
        treasury.donatePrincipal(0, bytes32(0));
    }

    function test_donatePrincipal_insufficient_allowance_reverts() public {
        address poor = makeAddr("poor");
        jpyc.mint(poor, JPYC.yen(1));
        vm.startPrank(poor);
        vm.expectRevert(TreasuryVault.InsufficientAllowance.selector);
        treasury.donatePrincipal(JPYC.yen(1), bytes32(0));
        vm.stopPrank();
    }

    function _createProposal(uint256 amount) internal returns (uint256 id) {
        vm.prank(proposer);
        return controller.createGrantProposal(
            recipient, amount, keccak256("purpose"), keccak256("evidence"), "ipfs://meta"
        );
    }

    function _approveTwice(uint256 id) internal {
        vm.prank(approver1);
        controller.approveGrantProposal(id);
        vm.prank(approver2);
        controller.approveGrantProposal(id);
    }

    function test_only_proposer_creates_proposal() public {
        vm.prank(executor);
        vm.expectRevert();
        controller.createGrantProposal(recipient, JPYC.yen(10_000), bytes32(0), bytes32(0), "");
    }

    function test_zero_recipient_reverts() public {
        vm.prank(proposer);
        vm.expectRevert(GrantController.InvalidRecipient.selector);
        controller.createGrantProposal(address(0), JPYC.yen(10_000), bytes32(0), bytes32(0), "");
    }

    function test_zero_grant_reverts() public {
        vm.prank(proposer);
        vm.expectRevert(GrantController.ZeroAmount.selector);
        controller.createGrantProposal(recipient, 0, bytes32(0), bytes32(0), "");
    }

    function test_max_grant_exceeded_reverts() public {
        vm.prank(proposer);
        vm.expectRevert(GrantController.ExceedsMaxGrantAmount.selector);
        controller.createGrantProposal(recipient, MAX_GRANT + 1, bytes32(0), bytes32(0), "");
    }

    function test_only_approver_approves() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        vm.prank(executor);
        vm.expectRevert();
        controller.approveGrantProposal(id);
    }

    function test_self_approval_reverts() public {
        bytes32 approverRole = keccak256("APPROVER_ROLE");
        vm.prank(admin);
        controller.grantRole(approverRole, proposer);

        uint256 id = _createProposal(JPYC.yen(50_000));
        vm.prank(proposer);
        vm.expectRevert(GrantController.SelfApprovalForbidden.selector);
        controller.approveGrantProposal(id);
    }

    function test_double_approval_reverts() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        vm.startPrank(approver1);
        controller.approveGrantProposal(id);
        vm.expectRevert(GrantController.AlreadyApproved.selector);
        controller.approveGrantProposal(id);
        vm.stopPrank();
    }

    function test_insufficient_approvals_blocks_execution() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        vm.prank(approver1);
        controller.approveGrantProposal(id);

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeGrantProposal(id);
    }

    function test_timelock_blocks_execution() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);

        vm.prank(executor);
        vm.expectRevert(GrantController.TimelockNotElapsed.selector);
        controller.executeGrantProposal(id);
    }

    function test_expired_proposal_cannot_execute() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);
        vm.warp(block.timestamp + 15 days);

        vm.prank(executor);
        vm.expectRevert(GrantController.ProposalExpired.selector);
        controller.executeGrantProposal(id);
    }

    function test_only_executor_executes() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);

        vm.prank(approver1);
        vm.expectRevert();
        controller.executeGrantProposal(id);
    }

    function test_execute_transfers_exact_amount_and_reduces_budget() public {
        uint256 grant = JPYC.yen(80_000);
        uint256 id = _createProposal(grant);
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);

        uint256 principalBefore = treasury.protectedPrincipal();
        uint256 budgetBefore = treasury.availableGrantBudget();

        vm.prank(executor);
        controller.executeGrantProposal(id);

        assertEq(jpyc.balanceOf(recipient), grant);
        assertEq(treasury.availableGrantBudget(), budgetBefore - grant);
        assertEq(treasury.protectedPrincipal(), principalBefore);
        assertEq(
            uint8(controller.getProposal(id).status), uint8(GrantController.GrantStatus.Executed)
        );
    }

    function test_executed_proposal_cannot_reexecute() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);
        vm.prank(executor);
        controller.executeGrantProposal(id);

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeGrantProposal(id);
    }

    function test_cancelled_proposal_cannot_execute() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        vm.prank(proposer);
        controller.cancelGrantProposal(id);

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeGrantProposal(id);
    }

    function test_insufficient_budget_on_execute_reverts() public {
        // With reservation, a second overlapping approval is blocked before execution.
        uint256 id = _createProposal(BUDGET);
        _approveTwice(id);
        assertEq(controller.reservedGrantBudget(), BUDGET);
        assertEq(controller.spendableGrantBudget(), 0);

        uint256 id2 = _createProposal(JPYC.yen(1));
        vm.prank(approver1);
        vm.expectRevert(GrantController.InsufficientGrantBudget.selector);
        controller.approveGrantProposal(id2);
    }

    function test_grant_reservation_released_on_cancel() public {
        uint256 grant = JPYC.yen(80_000);
        uint256 id = _createProposal(grant);
        _approveTwice(id);
        assertEq(controller.reservedGrantBudget(), grant);

        vm.prank(proposer);
        controller.cancelGrantProposal(id);

        assertEq(controller.reservedGrantBudget(), 0);
        assertEq(controller.spendableGrantBudget(), BUDGET);
    }

    function test_grant_reservation_released_on_expire() public {
        uint256 grant = JPYC.yen(80_000);
        uint256 id = _createProposal(grant);
        _approveTwice(id);
        vm.warp(block.timestamp + 15 days);

        controller.expireGrantProposal(id);

        assertEq(controller.reservedGrantBudget(), 0);
        assertEq(controller.spendableGrantBudget(), BUDGET);
        assertEq(
            uint8(controller.getProposal(id).status), uint8(GrantController.GrantStatus.Expired)
        );
    }

    function test_execute_clears_reservation() public {
        uint256 grant = JPYC.yen(80_000);
        uint256 id = _createProposal(grant);
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);

        vm.prank(executor);
        controller.executeGrantProposal(id);

        assertEq(controller.reservedGrantBudget(), 0);
        assertEq(controller.spendableGrantBudget(), BUDGET - grant);
    }

    function test_insufficient_budget_on_approval_reverts() public {
        uint256 id = _createProposal(BUDGET + 1);
        vm.prank(approver1);
        vm.expectRevert(GrantController.InsufficientGrantBudget.selector);
        controller.approveGrantProposal(id);
    }

    function test_admin_cannot_transfer_jpyc_directly() public {
        vm.prank(admin);
        vm.expectRevert(TreasuryVault.OnlyGrantController.selector);
        treasury.executeGrantTransfer(makeAddr("thief"), JPYC.yen(1));
    }

    function test_executor_cannot_change_recipient_or_amount() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);
        vm.prank(executor);
        controller.executeGrantProposal(id);

        assertEq(jpyc.balanceOf(recipient), JPYC.yen(50_000));
        assertEq(jpyc.balanceOf(makeAddr("other")), 0);
    }

    function test_guardian_pauses() public {
        vm.prank(guardian);
        controller.pause();
        assertTrue(controller.paused());
        assertTrue(treasury.paused());
    }

    function test_guardian_cannot_unpause() public {
        vm.prank(guardian);
        controller.pause();

        vm.prank(guardian);
        vm.expectRevert(GrantController.GuardianCannotUnpause.selector);
        controller.unpause();
    }

    function test_admin_unpauses() public {
        vm.prank(guardian);
        controller.pause();

        vm.prank(admin);
        controller.unpause();
        assertFalse(controller.paused());
    }

    function test_pause_blocks_config_propose() public {
        vm.prank(guardian);
        controller.pause();

        vm.prank(config);
        vm.expectRevert();
        controller.proposeConfiguration(MAX_GRANT, 2, 2 days, 14 days);
    }

    function test_configuration_requires_timelock() public {
        vm.prank(config);
        controller.proposeConfiguration(MAX_GRANT / 2, 2, 2 days, 14 days);

        vm.prank(config);
        vm.expectRevert(GrantController.ConfigurationTimelockNotElapsed.selector);
        controller.executeConfiguration();

        vm.warp(block.timestamp + 2 days);
        vm.prank(config);
        controller.executeConfiguration();

        assertEq(controller.maxGrantAmount(), MAX_GRANT / 2);
        assertFalse(controller.getPendingConfiguration().pending);
    }

    function test_configuration_cannot_set_approvals_below_minimum() public {
        vm.prank(config);
        vm.expectRevert(GrantController.InvalidConfiguration.selector);
        controller.proposeConfiguration(MAX_GRANT, 1, 2 days, 14 days);
    }

    function test_configuration_cancel_clears_pending() public {
        vm.prank(config);
        controller.proposeConfiguration(MAX_GRANT / 2, 2, 2 days, 14 days);

        vm.prank(guardian);
        controller.cancelPendingConfiguration();

        assertFalse(controller.getPendingConfiguration().pending);

        vm.warp(block.timestamp + 2 days);
        vm.prank(config);
        vm.expectRevert(GrantController.NoPendingConfiguration.selector);
        controller.executeConfiguration();
    }

    function _applyConfiguration(uint8 approvals) internal {
        vm.prank(config);
        controller.proposeConfiguration(MAX_GRANT, approvals, 2 days, 14 days);
        vm.warp(block.timestamp + 2 days);
        vm.prank(config);
        controller.executeConfiguration();
    }

    function test_lowering_required_approvals_does_not_affect_existing_proposal() public {
        _applyConfiguration(3);
        uint256 id = _createProposal(JPYC.yen(50_000));
        assertEq(controller.getProposal(id).approvalThreshold, 3);

        _applyConfiguration(2);

        // Two approvals must not satisfy the snapshotted threshold of 3.
        _approveTwice(id);
        assertEq(
            uint8(controller.getProposal(id).status), uint8(GrantController.GrantStatus.Pending)
        );

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeGrantProposal(id);

        address approver3 = makeAddr("approver3");
        vm.prank(admin);
        controller.grantRole(keccak256("APPROVER_ROLE"), approver3);
        vm.prank(approver3);
        controller.approveGrantProposal(id);
        assertEq(
            uint8(controller.getProposal(id).status), uint8(GrantController.GrantStatus.Approved)
        );
    }

    function test_raising_required_approvals_does_not_affect_existing_proposal() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        assertEq(controller.getProposal(id).approvalThreshold, 2);

        _applyConfiguration(3);

        _approveTwice(id);
        assertEq(
            uint8(controller.getProposal(id).status), uint8(GrantController.GrantStatus.Approved)
        );
    }

    function test_config_weakening_waits_current_timelock() public {
        // Raise timelock to 7 days, then a later proposal to weaken it must wait 7 days.
        vm.prank(config);
        controller.proposeConfiguration(MAX_GRANT, 2, 7 days, 14 days);
        vm.warp(block.timestamp + 2 days);
        vm.prank(config);
        controller.executeConfiguration();
        assertEq(controller.timelockDuration(), 7 days);

        vm.prank(config);
        controller.proposeConfiguration(MAX_GRANT, 2, 1 days, 14 days);

        vm.warp(block.timestamp + 2 days);
        vm.prank(config);
        vm.expectRevert(GrantController.ConfigurationTimelockNotElapsed.selector);
        controller.executeConfiguration();

        vm.warp(block.timestamp + 5 days);
        vm.prank(config);
        controller.executeConfiguration();
        assertEq(controller.timelockDuration(), 1 days);
    }

    function test_pause_blocks_grant_execution() public {
        uint256 id = _createProposal(JPYC.yen(50_000));
        _approveTwice(id);
        vm.warp(block.timestamp + 2 days);

        vm.prank(guardian);
        controller.pause();

        vm.prank(executor);
        vm.expectRevert();
        controller.executeGrantProposal(id);
    }

    function test_roleless_cannot_manage_roles() public {
        bytes32 proposerRole = keccak256("PROPOSER_ROLE");
        vm.prank(donor);
        vm.expectRevert();
        controller.grantRole(proposerRole, donor);
    }

    function test_initial_roles_assigned() public view {
        assertTrue(controller.hasRole(controller.PROPOSER_ROLE(), proposer));
        assertTrue(controller.hasRole(controller.APPROVER_ROLE(), approver1));
        assertTrue(controller.hasRole(controller.APPROVER_ROLE(), approver2));
        assertTrue(controller.hasRole(controller.EXECUTOR_ROLE(), executor));
        assertTrue(controller.hasRole(controller.GUARDIAN_ROLE(), guardian));
        assertTrue(controller.hasRole(controller.CONFIG_ROLE(), config));
        assertTrue(controller.hasRole(controller.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_jpyc_rescue_reverts() public {
        vm.prank(address(controller));
        vm.expectRevert(TreasuryVault.JPYCRescueForbidden.selector);
        treasury.rescueToken(IERC20(address(jpyc)), admin, 1);
    }

    function test_admin_rescues_stray_token_via_controller() public {
        MockJPYC stray = new MockJPYC();
        stray.mint(address(treasury), JPYC.yen(1_000));

        vm.prank(admin);
        controller.rescueToken(IERC20(address(stray)), admin, JPYC.yen(1_000));

        assertEq(stray.balanceOf(admin), JPYC.yen(1_000));
        assertEq(stray.balanceOf(address(treasury)), 0);
    }

    function test_rescue_works_while_paused() public {
        MockJPYC stray = new MockJPYC();
        stray.mint(address(treasury), 1);

        vm.prank(guardian);
        controller.pause();

        vm.prank(admin);
        controller.rescueToken(IERC20(address(stray)), admin, 1);
        assertEq(stray.balanceOf(admin), 1);
    }

    function test_non_admin_cannot_rescue_via_controller() public {
        MockJPYC stray = new MockJPYC();
        stray.mint(address(treasury), 1);

        vm.prank(config);
        vm.expectRevert();
        controller.rescueToken(IERC20(address(stray)), config, 1);
    }

    function test_jpyc_rescue_via_controller_reverts() public {
        vm.prank(admin);
        vm.expectRevert(TreasuryVault.JPYCRescueForbidden.selector);
        controller.rescueToken(IERC20(address(jpyc)), admin, 1);
    }

    function test_accounting_invariant_holds() public view {
        uint256 balance = treasury.totalTreasuryAssets();
        uint256 accounted = treasury.protectedPrincipal() + treasury.availableGrantBudget();
        assertGe(balance, accounted);
        assertEq(treasury.accountingSurplus(), balance - accounted);
    }

    function test_direct_jpyc_transfer_creates_surplus_without_outflow_path() public {
        jpyc.mint(address(treasury), JPYC.yen(10_000));
        assertEq(treasury.accountingSurplus(), JPYC.yen(10_000));

        vm.prank(admin);
        vm.expectRevert(TreasuryVault.OnlyGrantController.selector);
        treasury.executeGrantTransfer(admin, 1);
    }

    function _createAndApproveYield(uint256 amount) internal returns (uint256 allocationId) {
        jpyc.mint(address(treasury), amount);
        vm.prank(config);
        allocationId =
            controller.createYieldAllocation(amount, keccak256("yield-statement"), "ipfs://yield");
        vm.prank(approver1);
        controller.approveYieldAllocation(allocationId);
        vm.prank(approver2);
        controller.approveYieldAllocation(allocationId);
    }

    function test_yield_allocation_only_reclassifies_verified_surplus() public {
        uint256 amount = JPYC.yen(25_000);
        uint256 allocationId = _createAndApproveYield(amount);
        vm.warp(block.timestamp + 2 days);

        uint256 balanceBefore = treasury.totalTreasuryAssets();
        uint256 principalBefore = treasury.protectedPrincipal();
        uint256 budgetBefore = treasury.availableGrantBudget();

        vm.prank(executor);
        controller.executeYieldAllocation(allocationId);

        assertEq(treasury.totalTreasuryAssets(), balanceBefore);
        assertEq(treasury.protectedPrincipal(), principalBefore);
        assertEq(treasury.availableGrantBudget(), budgetBefore + amount);
        assertEq(treasury.accountingSurplus(), 0);
    }

    function test_yield_allocation_cannot_exceed_surplus() public {
        vm.prank(config);
        vm.expectRevert(GrantController.InsufficientAccountingSurplus.selector);
        controller.createYieldAllocation(JPYC.yen(1), bytes32(0), "");
    }

    function test_only_config_can_create_yield_allocation() public {
        jpyc.mint(address(treasury), JPYC.yen(1));
        vm.prank(admin);
        vm.expectRevert();
        controller.createYieldAllocation(JPYC.yen(1), bytes32(0), "");
    }

    function test_admin_cannot_recognize_yield_directly() public {
        jpyc.mint(address(treasury), JPYC.yen(1));
        vm.prank(admin);
        vm.expectRevert(TreasuryVault.OnlyGrantController.selector);
        treasury.recognizeYield(JPYC.yen(1), bytes32(0));
    }

    function test_yield_allocation_requires_approvals_and_timelock() public {
        uint256 amount = JPYC.yen(10_000);
        jpyc.mint(address(treasury), amount);
        vm.prank(config);
        uint256 allocationId = controller.createYieldAllocation(amount, bytes32(0), "");

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeYieldAllocation(allocationId);

        vm.prank(approver1);
        controller.approveYieldAllocation(allocationId);
        vm.prank(approver2);
        controller.approveYieldAllocation(allocationId);

        assertEq(controller.reservedYieldSurplus(), amount);
        assertEq(controller.spendableSurplus(), 0);

        vm.prank(executor);
        vm.expectRevert(GrantController.TimelockNotElapsed.selector);
        controller.executeYieldAllocation(allocationId);
    }

    function test_yield_reservation_blocks_overlapping_approval() public {
        uint256 amount = JPYC.yen(10_000);
        jpyc.mint(address(treasury), amount);

        // Both can be created while Pending; reservation happens only on Approved.
        vm.prank(config);
        uint256 first =
            controller.createYieldAllocation(amount, keccak256("yield-a"), "ipfs://yield-a");
        vm.prank(config);
        uint256 second =
            controller.createYieldAllocation(amount, keccak256("yield-b"), "ipfs://yield-b");

        vm.prank(approver1);
        controller.approveYieldAllocation(first);
        vm.prank(approver2);
        controller.approveYieldAllocation(first);

        assertEq(controller.reservedYieldSurplus(), amount);
        assertEq(controller.spendableSurplus(), 0);

        vm.prank(approver1);
        vm.expectRevert(GrantController.InsufficientAccountingSurplus.selector);
        controller.approveYieldAllocation(second);
    }

    function _initiateAndApproveDissolution() internal {
        vm.prank(guardian);
        controller.pause();
        vm.prank(config);
        controller.initiateDissolution(keccak256("legal-resolution"), "ipfs://resolution");
        vm.prank(approver1);
        controller.approveDissolution();
        vm.prank(approver2);
        controller.approveDissolution();
    }

    function test_dissolution_requires_paused_fund() public {
        vm.prank(config);
        vm.expectRevert(GrantController.FundNotPaused.selector);
        controller.initiateDissolution(keccak256("resolution"), "ipfs://resolution");
    }

    function test_dissolution_requires_long_timelock() public {
        _initiateAndApproveDissolution();

        vm.prank(executor);
        vm.expectRevert(GrantController.TimelockNotElapsed.selector);
        controller.executeDissolution();
    }

    function test_dissolution_pending_blocks_new_funds() public {
        vm.prank(guardian);
        controller.pause();
        vm.prank(config);
        controller.initiateDissolution(keccak256("resolution"), "ipfs://resolution");

        vm.startPrank(donor);
        vm.expectRevert(TreasuryVault.FundNotActive.selector);
        treasury.fundGrantBudget(1, bytes32(0));
        vm.stopPrank();
    }

    function test_dissolution_transfers_all_assets_to_fixed_recipient_and_is_terminal() public {
        jpyc.mint(address(treasury), JPYC.yen(5_000));
        uint256 treasuryBalance = treasury.totalTreasuryAssets();
        _initiateAndApproveDissolution();
        vm.warp(block.timestamp + 30 days);

        vm.prank(executor);
        controller.executeDissolution();

        assertEq(jpyc.balanceOf(constitution.dissolutionRecipient()), treasuryBalance);
        assertEq(treasury.totalTreasuryAssets(), 0);
        assertEq(treasury.protectedPrincipal(), 0);
        assertEq(treasury.availableGrantBudget(), 0);
        assertEq(uint8(treasury.lifecycle()), uint8(TreasuryVault.FundLifecycle.Dissolved));

        vm.expectRevert(TreasuryVault.FundNotActive.selector);
        treasury.donatePrincipal(1, bytes32(0));

        vm.prank(admin);
        vm.expectRevert(GrantController.FundNotActive.selector);
        controller.unpause();
    }

    function test_dissolution_cannot_be_executed_by_non_executor() public {
        _initiateAndApproveDissolution();
        vm.warp(block.timestamp + 30 days);

        vm.prank(admin);
        vm.expectRevert();
        controller.executeDissolution();
    }

    function test_guardian_can_cancel_dissolution() public {
        vm.prank(guardian);
        controller.pause();
        vm.prank(config);
        controller.initiateDissolution(keccak256("resolution"), "ipfs://resolution");

        vm.prank(guardian);
        controller.cancelDissolution();

        vm.prank(executor);
        vm.expectRevert(GrantController.InvalidProposalStatus.selector);
        controller.executeDissolution();

        vm.prank(admin);
        controller.unpause();
        jpyc.mint(donor, 1);
        vm.prank(donor);
        treasury.fundGrantBudget(1, bytes32(0));
    }

    function test_reentrancy_blocked_on_grant_execution() public {
        MaliciousJPYC malicious = new MaliciousJPYC();
        address localDonor = makeAddr("localDonor");
        FundConstitution localConstitution = new FundConstitution(
            "Malicious", keccak256("m"), "ipfs://m", admin, IERC20(address(malicious))
        );
        TreasuryVault localTreasury = new TreasuryVault(localConstitution);
        GrantController localController = new GrantController(
            localConstitution,
            localTreasury,
            admin,
            proposer,
            approver1,
            executor,
            guardian,
            config,
            3 days,
            MAX_GRANT,
            2,
            2 days,
            14 days
        );
        localTreasury.authorizeGrantController(address(localController));

        bytes32 approverRole = keccak256("APPROVER_ROLE");
        vm.prank(admin);
        localController.grantRole(approverRole, approver2);

        malicious.configureAttack(localTreasury, true);
        malicious.mint(localDonor, JPYC.yen(200_000));
        vm.startPrank(localDonor);
        malicious.approve(address(localTreasury), type(uint256).max);
        localTreasury.fundGrantBudget(JPYC.yen(100_000), bytes32(0));
        vm.stopPrank();

        vm.prank(proposer);
        uint256 id = localController.createGrantProposal(
            recipient, JPYC.yen(10_000), bytes32(0), bytes32(0), ""
        );
        vm.prank(approver1);
        localController.approveGrantProposal(id);
        vm.prank(approver2);
        localController.approveGrantProposal(id);
        vm.warp(block.timestamp + 2 days);

        vm.prank(executor);
        vm.expectRevert();
        localController.executeGrantProposal(id);
    }

    function testFuzz_donations_maintain_invariant(uint96 principalAmount, uint96 budgetAmount)
        public
    {
        principalAmount = uint96(bound(principalAmount, 1, JPYC.yen(1_000_000)));
        budgetAmount = uint96(bound(budgetAmount, 1, JPYC.yen(1_000_000)));

        address fuzzDonor = makeAddr("fuzzDonor");
        jpyc.mint(fuzzDonor, uint256(principalAmount) + uint256(budgetAmount));

        vm.startPrank(fuzzDonor);
        jpyc.approve(address(treasury), type(uint256).max);
        treasury.donatePrincipal(principalAmount, bytes32(uint256(1)));
        treasury.fundGrantBudget(budgetAmount, bytes32(uint256(2)));
        vm.stopPrank();

        assertGe(
            treasury.totalTreasuryAssets(),
            treasury.protectedPrincipal() + treasury.availableGrantBudget()
        );
    }
}

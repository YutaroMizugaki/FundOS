// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/FundGovernance.sol";
import "../src/FundManager.sol";
import "../src/strategies/YieldStrategy.sol";
import "../src/mocks/MockERC20.sol";
import "../src/FundVault.sol";

contract FundGovernanceTest is Test {
    MockERC20 internal usdc;
    FundVault internal vault;
    FundManager internal manager;
    FundGovernance internal governance;
    YieldStrategy internal strategy;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");

    uint256 constant VOTE_PERIOD = 2 days;
    uint256 constant TIMELOCK = 1 days;
    uint256 constant QUORUM_BPS = 1000;    // 10%
    uint256 constant MAJORITY_BPS = 5100;  // 51%

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vault = new FundVault(
            IERC20(address(usdc)),
            "FundOS Share",
            "FUND",
            treasury,
            100,
            1000
        );
        manager = new FundManager(address(usdc), address(vault));
        vault.setFundManager(address(manager));

        // Transfer manager ownership to governance (after deploy)
        governance = new FundGovernance(
            address(vault),
            address(manager),
            VOTE_PERIOD,
            TIMELOCK,
            QUORUM_BPS,
            MAJORITY_BPS
        );
        manager.transferOwnership(address(governance));

        strategy = new YieldStrategy(address(usdc), address(manager), 500);

        // Give alice and bob voting power (FUND shares)
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob, 10_000e6);

        vm.startPrank(alice);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, alice);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, bob);
        vm.stopPrank();
    }

    function test_proposeAndExecute_addStrategy() public {
        bytes memory params = abi.encode(address(strategy), uint16(5000));

        vm.prank(alice);
        uint256 pid = governance.propose(
            FundGovernance.ProposalType.ADD_STRATEGY,
            params,
            "Add 5% APY yield strategy at 50% allocation"
        );

        // Both alice and bob vote for
        vm.prank(alice);
        governance.castVote(pid, true);
        vm.prank(bob);
        governance.castVote(pid, true);

        // Advance past voting period
        vm.warp(block.timestamp + VOTE_PERIOD + 1);

        governance.queue(pid);

        // Advance past timelock
        vm.warp(block.timestamp + TIMELOCK + 1);

        governance.execute(pid);

        IFundManager.StrategyInfo memory info = manager.getStrategyByAddress(address(strategy));
        assertTrue(info.active);
        assertEq(info.targetBps, 5000);
    }

    function test_proposal_defeatedIfNoQuorum() public {
        bytes memory params = abi.encode(address(strategy), uint16(5000));

        vm.prank(alice);
        uint256 pid = governance.propose(
            FundGovernance.ProposalType.ADD_STRATEGY,
            params,
            "Should fail"
        );
        // No votes cast

        vm.warp(block.timestamp + VOTE_PERIOD + 1);
        governance.queue(pid);

        assertEq(uint256(governance.state(pid)), uint256(FundGovernance.ProposalState.Defeated));
    }

    function test_doubleVote_reverts() public {
        bytes memory params = abi.encode(address(strategy), uint16(5000));
        vm.prank(alice);
        uint256 pid = governance.propose(
            FundGovernance.ProposalType.ADD_STRATEGY,
            params,
            "test"
        );

        vm.startPrank(alice);
        governance.castVote(pid, true);
        vm.expectRevert("Gov: already voted");
        governance.castVote(pid, true);
        vm.stopPrank();
    }

    function test_execute_beforeTimelock_reverts() public {
        bytes memory params = abi.encode(address(strategy), uint16(5000));

        vm.prank(alice);
        uint256 pid = governance.propose(
            FundGovernance.ProposalType.ADD_STRATEGY,
            params,
            "test"
        );

        vm.prank(alice);
        governance.castVote(pid, true);
        vm.prank(bob);
        governance.castVote(pid, true);

        vm.warp(block.timestamp + VOTE_PERIOD + 1);
        governance.queue(pid);

        // Try to execute immediately (before timelock)
        vm.expectRevert("Gov: timelock not elapsed");
        governance.execute(pid);
    }

    function test_cancel_byProposer() public {
        bytes memory params = abi.encode(address(strategy), uint16(5000));

        vm.prank(alice);
        uint256 pid = governance.propose(
            FundGovernance.ProposalType.ADD_STRATEGY,
            params,
            "test"
        );

        vm.prank(alice);
        governance.cancel(pid);

        assertEq(uint256(governance.state(pid)), uint256(FundGovernance.ProposalState.Cancelled));
    }
}

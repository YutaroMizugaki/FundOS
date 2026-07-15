// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AutonomousFund} from "../src/AutonomousFund.sol";
import {FundGovernor} from "../src/FundGovernor.sol";

contract FundGovernorTest is Test {
    AutonomousFund fund;
    FundGovernor gov;

    // テストコントラクト自身が executeGrant を呼んだ際のキーパー報酬を受け取れるようにする
    receive() external payable {}

    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice"); // 大口寄付者
    address bob = makeAddr("bob"); // 小口寄付者
    address carol = makeAddr("carol"); // 未寄付
    address grantee = makeAddr("grantee");

    uint64 constant VOTING_DELAY = 1 days;
    uint64 constant VOTING_PERIOD = 5 days;
    uint64 constant TIMELOCK_DELAY = 2 days;
    uint16 constant QUORUM_BPS = 1_000; // 10%
    uint256 constant THRESHOLD = 0.1 ether;

    function setUp() public {
        fund = new AutonomousFund(address(this), guardian, 30 days, 2_000, 10);
        gov = new FundGovernor(fund, VOTING_DELAY, VOTING_PERIOD, TIMELOCK_DELAY, QUORUM_BPS, THRESHOLD);
        fund.setGovernor(address(gov));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);

        vm.prank(alice);
        fund.donate{value: 60 ether}();
        vm.prank(bob);
        fund.donate{value: 40 ether}();

        // 寄付とスナップショットの時刻を分離
        vm.warp(block.timestamp + 1);
    }

    function _proposeGrant() internal returns (uint256 id) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = address(fund);
        calldatas[0] = abi.encodeCall(
            AutonomousFund.createGrant, (grantee, 1 ether, 7 days, 4, uint64(block.timestamp))
        );
        vm.prank(alice);
        id = gov.propose(targets, values, calldatas, unicode"grantee へ週次 1 ETH x 4 回の助成");
    }

    // -----------------------------------------------------------
    // フルライフサイクル
    // -----------------------------------------------------------

    function test_FullGovernanceFlow() public {
        uint256 id = _proposeGrant();
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Pending));

        // 投票開始
        vm.warp(block.timestamp + VOTING_DELAY);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Active));

        vm.prank(alice);
        gov.castVote(id, FundGovernor.VoteType.For);
        vm.prank(bob);
        gov.castVote(id, FundGovernor.VoteType.Against);

        // 投票終了 → 可決 (60 > 40, 定足数 10% 達成)
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Succeeded));

        // キュー → タイムロック経過 → 執行
        gov.queue(id);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Queued));

        vm.expectRevert(FundGovernor.TimelockNotElapsed.selector);
        gov.execute(id);

        vm.warp(block.timestamp + TIMELOCK_DELAY);
        gov.execute(id);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Executed));

        // 議決どおり助成プログラムが作成され、誰でも執行できる
        assertEq(fund.grantCount(), 1);
        fund.executeGrant(0);
        assertEq(grantee.balance, 1 ether);
    }

    // -----------------------------------------------------------
    // 否決・定足数
    // -----------------------------------------------------------

    function test_DefeatedWhenAgainstWins() public {
        uint256 id = _proposeGrant();
        vm.warp(block.timestamp + VOTING_DELAY);

        vm.prank(alice);
        gov.castVote(id, FundGovernor.VoteType.Against);
        vm.prank(bob);
        gov.castVote(id, FundGovernor.VoteType.For);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Defeated));

        vm.expectRevert();
        gov.queue(id);
    }

    function test_DefeatedWithoutQuorum() public {
        uint256 id = _proposeGrant();
        vm.warp(block.timestamp + VOTING_DELAY);

        // 総投票力 100 ether、定足数 10 ether — 誰も投票しない
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Defeated));
    }

    // -----------------------------------------------------------
    // スナップショットによる駆け込み買収の防止
    // -----------------------------------------------------------

    function test_SnapshotBlocksLateDonors() public {
        uint256 id = _proposeGrant();
        vm.warp(block.timestamp + VOTING_DELAY + 1);

        // 投票開始後に大金を寄付しても、この提案では投票力ゼロ
        vm.prank(carol);
        fund.donate{value: 500 ether}();

        vm.prank(carol);
        vm.expectRevert(FundGovernor.NoVotingPower.selector);
        gov.castVote(id, FundGovernor.VoteType.For);
    }

    function test_ProposalThreshold() public {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = address(fund);
        calldatas[0] = abi.encodeCall(AutonomousFund.setEpochCapBps, (uint16(100)));

        vm.prank(carol); // 寄付ゼロ → 提案不可
        vm.expectRevert(FundGovernor.BelowProposalThreshold.selector);
        gov.propose(targets, values, calldatas, "x");
    }

    // -----------------------------------------------------------
    // 二重投票・取り下げ・期限切れ
    // -----------------------------------------------------------

    function test_CannotVoteTwice() public {
        uint256 id = _proposeGrant();
        vm.warp(block.timestamp + VOTING_DELAY);

        vm.startPrank(alice);
        gov.castVote(id, FundGovernor.VoteType.For);
        vm.expectRevert(FundGovernor.AlreadyVoted.selector);
        gov.castVote(id, FundGovernor.VoteType.For);
        vm.stopPrank();
    }

    function test_ProposerCanCancel() public {
        uint256 id = _proposeGrant();
        vm.prank(alice);
        gov.cancel(id);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Cancelled));
    }

    function test_QueuedProposalExpires() public {
        uint256 id = _proposeGrant();
        vm.warp(block.timestamp + VOTING_DELAY);
        vm.prank(alice);
        gov.castVote(id, FundGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        gov.queue(id);

        vm.warp(block.timestamp + TIMELOCK_DELAY + gov.GRACE_PERIOD() + 1);
        assertEq(uint8(gov.state(id)), uint8(FundGovernor.ProposalState.Expired));

        vm.expectRevert();
        gov.execute(id);
    }

    // -----------------------------------------------------------
    // ガバナンス経由のパラメータ変更
    // -----------------------------------------------------------

    function test_GovernanceChangesParams() public {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        targets[0] = address(fund);
        calldatas[0] = abi.encodeCall(AutonomousFund.setEpochCapBps, (uint16(500)));

        vm.prank(alice);
        uint256 id = gov.propose(targets, values, calldatas, unicode"支出上限を 5% に引き下げ");

        vm.warp(block.timestamp + VOTING_DELAY);
        vm.prank(alice);
        gov.castVote(id, FundGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        gov.queue(id);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        gov.execute(id);

        assertEq(fund.epochCapBps(), 500);
    }
}

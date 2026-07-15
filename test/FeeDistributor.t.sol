// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/FeeDistributor.sol";
import "../src/mocks/MockERC20.sol";

contract FeeDistributorTest is Test {
    MockERC20 internal token;
    FeeDistributor internal distributor;

    address internal protocolTreasury = makeAddr("protocol");
    address internal strategist = makeAddr("strategist");
    address internal stakers = makeAddr("stakers");

    function setUp() public {
        token = new MockERC20("FundOS Share", "FUND", 18);
        distributor = new FeeDistributor(address(token));

        address[] memory accounts = new address[](3);
        uint16[] memory weights = new uint16[](3);
        string[] memory labels = new string[](3);

        accounts[0] = protocolTreasury; weights[0] = 5000; labels[0] = "Protocol Treasury";
        accounts[1] = strategist;       weights[1] = 3000; labels[1] = "Strategist";
        accounts[2] = stakers;          weights[2] = 2000; labels[2] = "Stakers Pool";

        distributor.setRecipients(accounts, weights, labels);
    }

    function test_distribute_splitsCorrectly() public {
        uint256 total = 10_000e18;
        token.mint(address(distributor), total);

        distributor.distribute();

        assertEq(token.balanceOf(protocolTreasury), 5_000e18);
        assertEq(token.balanceOf(strategist), 3_000e18);
        assertEq(token.balanceOf(stakers), 2_000e18);
    }

    function test_distribute_noDust() public {
        // Use an amount that doesn't divide evenly
        uint256 total = 9999;
        token.mint(address(distributor), total);

        distributor.distribute();

        uint256 sum = token.balanceOf(protocolTreasury)
            + token.balanceOf(strategist)
            + token.balanceOf(stakers);
        assertEq(sum, total, "no tokens should be lost");
    }

    function test_distribute_emptyBalance_reverts() public {
        vm.expectRevert("FeeDistributor: nothing to distribute");
        distributor.distribute();
    }

    function test_setRecipients_badWeights_reverts() public {
        address[] memory accounts = new address[](2);
        uint16[] memory weights = new uint16[](2);
        string[] memory labels = new string[](2);
        accounts[0] = makeAddr("a"); weights[0] = 3000; labels[0] = "A";
        accounts[1] = makeAddr("b"); weights[1] = 3000; labels[1] = "B";

        vm.expectRevert("FeeDistributor: weights must sum to 10000");
        distributor.setRecipients(accounts, weights, labels);
    }

    function test_pendingBalance() public {
        token.mint(address(distributor), 500e18);
        assertEq(distributor.pendingBalance(), 500e18);
    }
}

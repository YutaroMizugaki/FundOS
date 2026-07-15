// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FundConstitution} from "../src/FundConstitution.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {GrantController} from "../src/GrantController.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {JPYC} from "../src/constants/JPYC.sol";

/// @title DeployFundOS
/// @notice Deploys FundOS with grant, yield-recognition, and dissolution governance.
contract DeployFundOS is Script {
    struct Deployment {
        MockJPYC mockJpyc;
        FundConstitution constitution;
        TreasuryVault treasury;
        GrantController controller;
    }

    function run() external returns (Deployment memory deployment) {
        bool useMock = vm.envOr("USE_MOCK_JPYC", true);
        address jpycAddress = useMock ? address(0) : vm.envAddress("JPYC_TOKEN");

        address admin = vm.envAddress("ADMIN");
        address proposer = vm.envAddress("PROPOSER");
        address approver = vm.envAddress("APPROVER");
        address executor = vm.envAddress("EXECUTOR");
        address guardian = vm.envAddress("GUARDIAN");
        address config = vm.envOr("CONFIG", admin);

        string memory fundName = vm.envOr("FUND_NAME", string("FundOS Kosen Support Fund"));
        bytes32 purposeHash = vm.envOr("PURPOSE_HASH", keccak256("kosen-student-activity-support"));
        string memory purposeURI = vm.envOr("PURPOSE_URI", string("ipfs://fundos-purpose-v1"));
        address dissolutionRecipient = vm.envOr("DISSOLUTION_RECIPIENT", admin);

        uint48 adminTransferDelay = uint48(vm.envOr("ADMIN_TRANSFER_DELAY", uint256(3 days)));
        uint256 maxGrantAmount = vm.envOr("MAX_GRANT_AMOUNT", JPYC.yen(500_000));
        uint8 requiredApprovals = uint8(vm.envOr("REQUIRED_APPROVALS", uint256(2)));
        uint64 timelockDuration = uint64(vm.envOr("TIMELOCK_DURATION", uint256(2 days)));
        uint64 proposalValidityPeriod = uint64(vm.envOr("PROPOSAL_VALIDITY_PERIOD", uint256(14 days)));

        vm.startBroadcast();

        if (useMock) {
            deployment.mockJpyc = new MockJPYC();
            jpycAddress = address(deployment.mockJpyc);
        }

        deployment.constitution =
            new FundConstitution(fundName, purposeHash, purposeURI, dissolutionRecipient, IERC20(jpycAddress));

        deployment.treasury = new TreasuryVault(deployment.constitution);

        deployment.controller = new GrantController(
            deployment.constitution,
            deployment.treasury,
            admin,
            proposer,
            approver,
            executor,
            guardian,
            config,
            adminTransferDelay,
            maxGrantAmount,
            requiredApprovals,
            timelockDuration,
            proposalValidityPeriod
        );
        deployment.treasury.authorizeGrantController(address(deployment.controller));

        vm.stopBroadcast();

        console2.log("JPYC", jpycAddress);
        console2.log("Constitution", address(deployment.constitution));
        console2.log("Treasury", address(deployment.treasury));
        console2.log("GrantController", address(deployment.controller));
    }
}

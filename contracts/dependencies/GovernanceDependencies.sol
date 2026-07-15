// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Re-exported so Hardhat compiles an artifact for TimelockController even
// though no FundOS contract imports it directly. FundOS uses a
// TimelockController as the recommended `owner` of FundVault / strategy
// contracts so governance changes are delayed and publicly visible
// (see scripts/deploy.ts and test/Governance.test.ts).
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

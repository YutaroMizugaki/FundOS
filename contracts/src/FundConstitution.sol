// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FundConstitution
/// @notice Immutable charter metadata for a purpose-restricted FundOS fund.
contract FundConstitution {
    error ZeroAddress();

    string public name;
    bytes32 public immutable purposeHash;
    string public purposeURI;
    address public immutable dissolutionRecipient;
    IERC20 public immutable jpyc;
    uint64 public immutable createdAt;

    event ConstitutionCreated(
        string name,
        bytes32 indexed purposeHash,
        string purposeURI,
        address indexed dissolutionRecipient,
        address indexed jpyc,
        uint64 createdAt
    );

    constructor(
        string memory name_,
        bytes32 purposeHash_,
        string memory purposeURI_,
        address dissolutionRecipient_,
        IERC20 jpyc_
    ) {
        if (dissolutionRecipient_ == address(0)) revert ZeroAddress();
        if (address(jpyc_) == address(0)) revert ZeroAddress();

        name = name_;
        purposeHash = purposeHash_;
        purposeURI = purposeURI_;
        dissolutionRecipient = dissolutionRecipient_;
        jpyc = jpyc_;
        createdAt = uint64(block.timestamp);

        emit ConstitutionCreated(
            name_, purposeHash_, purposeURI_, dissolutionRecipient_, address(jpyc_), createdAt
        );
    }
}

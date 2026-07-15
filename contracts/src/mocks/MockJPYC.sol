// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {JPYC} from "../constants/JPYC.sol";

/// @title MockJPYC
/// @notice Test double for JPYC (18 decimals, 1 token = 1 yen).
contract MockJPYC is ERC20 {
    constructor() ERC20("JPY Coin", "JPYC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return JPYC.DECIMALS;
    }
}

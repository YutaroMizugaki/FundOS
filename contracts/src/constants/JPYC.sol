// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title JPYC
/// @notice Canonical JPYC (日本円ステーブルコイン) metadata for FundOS deployments.
/// @dev 1 JPYC = 1 円。ERC-20 decimals は 18。
library JPYC {
    uint8 public constant DECIMALS = 18;

    /// @dev JPYC v2 proxy — same address on Ethereum / Polygon / Avalanche.
    address internal constant ETHEREUM = 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29;
    address internal constant POLYGON = 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29;
    address internal constant AVALANCHE = 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29;

    /// @notice Convert whole-yen amounts to token units (18 decimals).
    function yen(uint256 wholeYen) internal pure returns (uint256) {
        return wholeYen * 10 ** DECIMALS;
    }
}

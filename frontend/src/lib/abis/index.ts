import { parseAbi } from "viem";

export const VAULT_ABI = parseAbi([
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount, address recipient) external",
  "function getMarginBalance(address trader) view returns (uint256)",
  "function getInsuranceFund() view returns (uint256)",
]);

export const PERP_ENGINE_ABI = parseAbi([
  "function openPosition(bytes32 pair, bool isLong, uint256 margin, uint256 leverageBps, bytes[] calldata priceUpdateData) external returns (bytes32 positionId)",
  "function closePosition(bytes32 positionId, bytes[] calldata priceUpdateData) external returns (int256 pnl)",
  "function getPosition(bytes32 positionId) view returns (address trader, bytes32 pair, uint128 notional, uint128 margin, uint128 entryPrice, uint64 openedAtBlock, bool isLong)",
  "function getPairConfig(bytes32 pair) view returns (bool active, uint16 maxLeverageBps, uint16 takerFeeBps, uint16 makerFeeBps, uint16 maintenanceMarginBps)",
  "event PositionOpened(bytes32 indexed positionId, address indexed trader, bytes32 indexed pair, uint256 notional, uint256 margin, uint256 entryPrice, bool isLong)",
  "event PositionClosed(bytes32 indexed positionId, address indexed trader, int256 pnl)",
]);

export const LIQ_ENGINE_ABI = parseAbi([
  "function liquidate(bytes32 positionId, bytes[] calldata priceUpdateData) external",
  "function isLiquidatable(bytes32 positionId, uint256 currentPrice) view returns (bool liquidatable, uint256 healthFactor)",
]);

export const FEE_COLLECTOR_ABI = parseAbi([
  "function getCumulativeFees(bytes32 pair) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

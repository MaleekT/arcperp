import type { StoredOrder } from "./store.js";

/**
 * Pure predicate — returns true when the given order's trigger condition
 * is satisfied at the current market price.
 */
export function conditionMet(order: StoredOrder, currentPrice: number): boolean {
  switch (order.type) {
    case "limit":
      return order.isLong ? currentPrice <= order.triggerPrice : currentPrice >= order.triggerPrice;

    case "tp":
      return order.isLong ? currentPrice >= order.triggerPrice : currentPrice <= order.triggerPrice;

    case "sl":
      return order.isLong ? currentPrice <= order.triggerPrice : currentPrice >= order.triggerPrice;

    case "stop_market":
    case "stop_limit":
      return order.isLong ? currentPrice >= order.triggerPrice : currentPrice <= order.triggerPrice;

    case "trailing_stop": {
      if (!order.peakPrice || !order.trailPercent) return false;
      const trail = order.peakPrice * (order.trailPercent / 100);
      return order.isLong
        ? currentPrice <= order.peakPrice - trail
        : currentPrice >= order.peakPrice + trail;
    }

    case "twap":
      return !!order.nextExecutionAt && Date.now() >= order.nextExecutionAt;
  }
}

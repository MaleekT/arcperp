import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi } from "lightweight-charts";
import type { PriceData } from "../hooks/usePrices.js";

interface Props {
  pair: { label: string; symbol: string };
  prices: Record<string, PriceData>;
}

const HERMES_URL = "https://hermes.pyth.network";
const HISTORY_SECONDS = 6 * 60 * 60; // 6 hours of history

const PYTH_FEEDS: Record<string, string> = {
  "BTC-USDC": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "76fa85158bf14ede77087fe3ae472f66213f6ea2ceb0e6d71d3424ef6fb5bbfb",
};

function toDecimal(priceStr: string, expo: number): number {
  const p = BigInt(priceStr);
  if (expo >= 0) return Number(p * 10n ** BigInt(expo));
  const absExpo = -expo;
  const div = 10n ** BigInt(absExpo);
  const whole = Number(p / div);
  const frac = Number(p % div) / Math.pow(10, absExpo);
  return whole + frac;
}

// Fetches historical price data from Hermes, trying the range endpoint first then
// falling back to per-minute sampling over the last 6 hours.
async function loadHistorySimple(feedId: string): Promise<Array<{ time: number; value: number }>> {
  const points: Array<{ time: number; value: number }> = [];
  const now = Math.floor(Date.now() / 1000);
  const from = now - HISTORY_SECONDS;

  // Pyth Hermes v2 benchmarks endpoint for historical data
  try {
    const res = await fetch(
      `${HERMES_URL}/v2/updates/price/${from}/${now}?ids[]=${feedId}&parsed=true`
    );
    if (res.ok) {
      const data = await res.json() as {
        parsed?: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
      };
      for (const feed of data.parsed ?? []) {
        const value = toDecimal(feed.price.price, feed.price.expo);
        if (value > 0) points.push({ time: feed.price.publish_time, value });
      }
      if (points.length > 0) {
        return points.sort((a, b) => a.time - b.time);
      }
    }
  } catch { /* fall through to sample-based approach */ }

  // Fallback: sample every 2 minutes over the last 6 hours
  const STEP = 120;
  const steps = Math.floor(HISTORY_SECONDS / STEP);
  for (let i = steps; i >= 0; i--) {
    const t = now - i * STEP;
    try {
      const res = await fetch(
        `${HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true&publish_time=${t}`
      );
      if (!res.ok) continue;
      const data = await res.json() as {
        parsed?: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
      };
      for (const feed of data.parsed ?? []) {
        const value = toDecimal(feed.price.price, feed.price.expo);
        if (value > 0) points.push({ time: feed.price.publish_time, value });
      }
    } catch { /* skip */ }
    // small delay to avoid hammering the API
    await new Promise((r) => setTimeout(r, 50));
  }

  const seen = new Set<number>();
  return points
    .filter((p) => { if (seen.has(p.time)) return false; seen.add(p.time); return true; })
    .sort((a, b) => a.time - b.time);
}

export function TradingChart({ pair, prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Initialize chart on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748B",
        fontFamily: "'Space Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        vertLine: { color: "rgba(0,212,200,0.4)", width: 1, style: 1 },
        horzLine: { color: "rgba(0,212,200,0.4)", width: 1, style: 1 },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.06)",
        textColor: "#64748B",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addLineSeries({
      color: "#00D4C8",
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: "rgba(0,212,200,0.3)",
      priceLineWidth: 1,
      priceLineStyle: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lastTimeRef.current = 0;
    };
  }, []);

  // Load historical bars when pair changes
  useEffect(() => {
    const feedId = PYTH_FEEDS[pair.label];
    if (!feedId || !seriesRef.current) return;

    lastTimeRef.current = 0;
    seriesRef.current.setData([]);

    let cancelled = false;

    void (async () => {
      const history = await loadHistorySimple(feedId);
      if (cancelled || !seriesRef.current) return;
      if (history.length > 0) {
        // UTCTimestamp is a branded number in lightweight-charts; cast via unknown
        type Time = Parameters<typeof seriesRef.current.update>[0]["time"];
        seriesRef.current.setData(
          history.map((p) => ({ time: p.time as unknown as Time, value: p.value }))
        );
        lastTimeRef.current = history[history.length - 1].time;
        chartRef.current?.timeScale().fitContent();
      }
    })();

    return () => { cancelled = true; };
  }, [pair.label]);

  // Feed live price ticks into the chart
  useEffect(() => {
    const price = prices[pair.label];
    if (!price || !seriesRef.current) return;

    const numericPrice = parseFloat(price.price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

    const t = Math.floor(price.timestamp);
    if (t <= 0) return;

    try {
      if (t >= lastTimeRef.current) {
        seriesRef.current.update({
          time: t as Parameters<typeof seriesRef.current.update>[0]["time"],
          value: numericPrice,
        });
        lastTimeRef.current = t;
      }
    } catch { /* lightweight-charts may reject non-ascending timestamps */ }
  }, [prices, pair.label]);

  const currentPrice = prices[pair.label];
  const displayPrice = currentPrice
    ? parseFloat(currentPrice.price).toLocaleString("en-US", { minimumFractionDigits: 2 })
    : "—";

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <div>
          <span className="heading">{pair.label}</span>
          <span
            className={`price price-${currentPrice?.direction ?? "flat"}`}
            style={styles.price}
          >
            ${displayPrice}
          </span>
        </div>
        <span className="label">Live · Pyth</span>
      </div>
      <div ref={containerRef} style={styles.chart} />
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    overflow: "hidden",
    background: "var(--bg-base)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  price: { marginLeft: 12, fontSize: 20, fontWeight: 700, color: "var(--text-price)" },
  chart: { flex: 1, minHeight: 0 },
} satisfies Record<string, React.CSSProperties>;

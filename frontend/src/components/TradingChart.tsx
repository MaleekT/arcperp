import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi } from "lightweight-charts";
import type { PriceData } from "../hooks/usePrices.js";

interface Props {
  pair: { label: string; symbol: string };
  prices: Record<string, PriceData>;
}

export function TradingChart({ pair, prices }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ReturnType<IChartApi["addLineSeries"]> | null>(null);

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
    };
  }, []);

  // Feed live price ticks into the chart
  useEffect(() => {
    const price = prices[pair.label];
    if (!price || !seriesRef.current) return;

    const numericPrice = parseFloat(price.price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

    seriesRef.current.update({
      time: Math.floor(price.timestamp) as unknown as Parameters<typeof seriesRef.current.update>[0]["time"],
      value: numericPrice,
    });
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

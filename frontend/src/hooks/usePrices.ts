import { useEffect, useRef, useState } from "react";

export interface PriceData {
  pair: string;
  price: string;
  priceRaw: string;
  timestamp: number;
  direction: "up" | "down" | "flat";
}

type PriceMap = Record<string, PriceData>;

const WS_URL = (import.meta.env.VITE_PRICE_SERVER_URL as string | undefined) ?? "wss://arcperp-price-server.onrender.com";
const HERMES_URL = "https://hermes.pyth.network";
const RECONNECT_DELAY_MS = 3_000;
const FALLBACK_POLL_MS = 2_000;
// If WS is open but no price arrives within this window, restart the Hermes fallback.
const STALE_PRICE_TIMEOUT_MS = 5_000;

// Bare hex feed IDs (no 0x) for Hermes query params
const PYTH_FEEDS: Record<string, string> = {
  "BTC-USDC": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-USDC": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "EURC-USDC": "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
};

const ID_TO_PAIR: Record<string, string> = Object.fromEntries(
  Object.entries(PYTH_FEEDS).map(([pair, id]) => [id, pair]),
);

function toDecimal(priceStr: string, expo: number): string {
  const p = BigInt(priceStr);
  if (expo >= 0) return `${p * 10n ** BigInt(expo)}.00000000`;
  const absExpo = -expo;
  const div = 10n ** BigInt(absExpo);
  const whole = p / div;
  const frac = p % div;
  return `${whole}.${frac.toString().padStart(absExpo, "0")}`;
}

function toRaw(priceStr: string, expo: number): string {
  const p = BigInt(priceStr);
  if (expo >= -8) return (p * 10n ** BigInt(8 + expo)).toString();
  return (p / 10n ** BigInt(-expo - 8)).toString();
}

export const PRICE_WS_URL = WS_URL;

export interface UsePricesResult {
  prices: PriceMap;
  connected: boolean;
}

export function usePrices(): UsePricesResult {
  const [prices, setPrices] = useState<PriceMap>({});
  const [connected, setConnected] = useState(false);
  const prevRef = useRef<Record<string, string>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const wsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedRef = useRef(false);
  // Tracks the last time any price message arrived over the WS
  const lastWsMsgRef = useRef<number>(0);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyUpdate(pair: string, price: string, priceRaw: string, timestamp: number) {
    const prev = prevRef.current[pair];
    const direction: PriceData["direction"] =
      prev === undefined ? "flat" : price > prev ? "up" : price < prev ? "down" : "flat";
    prevRef.current[pair] = price;
    setPrices((p) => ({ ...p, [pair]: { pair, price, priceRaw, timestamp, direction } }));
  }

  async function pollHermes() {
    if (connectedRef.current && fallbackTimerRef.current === null) return;
    try {
      const ids = Object.values(PYTH_FEEDS).map((id) => `ids[]=${id}`).join("&");
      const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${ids}&parsed=true`);
      if (res.ok) {
        const data = await res.json() as {
          parsed: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
        };
        for (const feed of data.parsed ?? []) {
          const pair = ID_TO_PAIR[feed.id.toLowerCase()];
          if (!pair) continue;
          applyUpdate(pair, toDecimal(feed.price.price, feed.price.expo), toRaw(feed.price.price, feed.price.expo), feed.price.publish_time);
        }
        return;
      }
      // Batch failed (e.g. one feed ID is invalid) — fall back to per-pair requests
      for (const [pair, feedId] of Object.entries(PYTH_FEEDS)) {
        try {
          const r = await fetch(`${HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
          if (!r.ok) continue;
          const d = await r.json() as {
            parsed: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
          };
          for (const feed of d.parsed ?? []) {
            applyUpdate(pair, toDecimal(feed.price.price, feed.price.expo), toRaw(feed.price.price, feed.price.expo), feed.price.publish_time);
          }
        } catch { /* skip this pair */ }
      }
    } catch { /* network error — ignore */ }
  }

  function startFallback() {
    if (fallbackTimerRef.current) return;
    void pollHermes();
    fallbackTimerRef.current = setInterval(() => { void pollHermes(); }, FALLBACK_POLL_MS);
  }

  function stopFallback() {
    if (fallbackTimerRef.current) {
      clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }

  function clearStaleTimer() {
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }

  // Arms the stale-price watchdog. If the WS doesn't deliver a message within
  // STALE_PRICE_TIMEOUT_MS, we restart the Hermes fallback even though the WS
  // connection is still open (handles the "connected but silent" Render failure mode).
  function armStaleTimer() {
    clearStaleTimer();
    staleTimerRef.current = setTimeout(() => {
      if (connectedRef.current) {
        startFallback();
        armStaleTimer(); // keep re-arming until messages resume
      }
    }, STALE_PRICE_TIMEOUT_MS);
  }

  useEffect(() => {
    let unmounted = false;

    // Show prices immediately from Hermes REST while WS is connecting
    startFallback();

    function connect() {
      if (unmounted) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        connectedRef.current = true;
        setConnected(true);
        lastWsMsgRef.current = Date.now();
        stopFallback();
        armStaleTimer(); // start watching for silence
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        lastWsMsgRef.current = Date.now();
        // If Hermes fallback was running due to stale timer, stop it now
        stopFallback();
        clearStaleTimer();
        armStaleTimer(); // re-arm after each received message
        try {
          const msg = JSON.parse(event.data) as { pair: string; price: string; priceRaw: string; timestamp: number };
          applyUpdate(msg.pair, msg.price, msg.priceRaw, msg.timestamp);
        } catch { /* malformed message */ }
      };

      ws.onclose = () => {
        connectedRef.current = false;
        setConnected(false);
        clearStaleTimer();
        if (!unmounted) {
          startFallback();
          wsTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      unmounted = true;
      if (wsTimerRef.current) clearTimeout(wsTimerRef.current);
      clearStaleTimer();
      stopFallback();
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { prices, connected };
}

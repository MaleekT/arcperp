import { useEffect, useRef, useState } from "react";

export interface PriceData {
  pair: string;
  price: string;
  priceRaw: string;
  timestamp: number;
  direction: "up" | "down" | "flat";
}

type PriceMap = Record<string, PriceData>;

const WS_URL = import.meta.env.VITE_PRICE_SERVER_URL ?? "wss://arcperp-price-server.onrender.com";
const RECONNECT_DELAY_MS = 3_000;

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unmounted = false;

    function connect() {
      if (unmounted) return;

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as { pair: string; price: string; priceRaw: string; timestamp: number };
          const prev = prevRef.current[msg.pair];
          const direction: PriceData["direction"] =
            prev === undefined ? "flat"
            : msg.price > prev ? "up"
            : msg.price < prev ? "down"
            : "flat";

          prevRef.current[msg.pair] = msg.price;
          setPrices((p) => ({ ...p, [msg.pair]: { ...msg, direction } }));
        } catch {
          // malformed message — ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!unmounted) {
          timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      unmounted = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { prices, connected };
}

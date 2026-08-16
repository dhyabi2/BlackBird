"use client";

import { useEffect, useRef } from "react";

const WS_URL = "wss://ws.nano.to";

export type NanoConfirmation = {
  topic: "confirmation";
  message: {
    hash: string;
    account: string;
    amount: string;
    block: {
      type: "state";
      account: string;
      previous: string;
      representative: string;
      balance: string;
      link: string;
      link_as_account?: string;
      signature: string;
      work: string;
      subtype?: string;
    };
  };
};

export function useNanoWebsocket(
  account: string | null,
  publicKey: string | null,
  onIncoming: (amountRaw: string, sendHash: string) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number>(0);
  const onIncomingRef = useRef(onIncoming);

  useEffect(() => {
    onIncomingRef.current = onIncoming;
  }, [onIncoming]);

  useEffect(() => {
    if (!account || !publicKey) return;

    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (!active) return;
      try {
        ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectRef.current = 0;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                action: "subscribe",
                topic: "confirmation",
                options: {
                  accounts: [account],
                },
              })
            );
          }
        };

        ws.onmessage = async (event) => {
          try {
            const raw =
              event.data instanceof Blob ? await event.data.text() : event.data;
            const data = JSON.parse(raw) as NanoConfirmation;
            if (data.topic !== "confirmation") return;

            const link = data.message.block.link.toLowerCase();
            const amount = data.message.amount;
            const pk = publicKey?.toLowerCase();
            if (!pk) return;

            // Match incoming sends: destination public key is the link field.
            if (link === pk && BigInt(amount) > 0) {
              onIncomingRef.current(amount, data.message.hash);
            }
          } catch {
            // ignore malformed messages
          }
        };

        ws.onerror = () => {
          // let onclose handle reconnect
        };

        ws.onclose = () => {
          if (!active) return;
          reconnectRef.current = Math.min(reconnectRef.current + 1, 6);
          const delay = Math.min(1000 * 2 ** reconnectRef.current, 30000);
          reconnectTimer = setTimeout(connect, delay);
        };
      } catch {
        // WebSocket constructor failed; retry later
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [account, publicKey]);
}

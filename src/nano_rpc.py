"""
Shared Nano RPC client.

Learns from the user's other projects (AiSwarmResearch, fishing, XNO_GAME_Template,
ordinal, xchat-alpha):
- Default endpoint: https://rpc.nano.to
- API key env var: NANO_RPC_KEY (falls back to NANO_RPC_API_KEY)
- Auth header: Authorization: <key> (no Bearer prefix)
- Public fallbacks when a public RPC is configured
- Keep-alive sessions, timeout, retries
- Distinguish transport errors from genuine Nano errors
- Remember last good endpoint
"""
import os
from typing import List, Optional

import requests
from requests.adapters import HTTPAdapter


DEFAULT_RPC_URLS = ["https://rpc.nano.to"]
PUBLIC_FALLBACKS = [
    "https://rpc.nano.to",
    "https://node.somenano.com/proxy",
    "https://proxy.nanos.cc/proxy",
    "https://rainstorm.city/api",
    "https://nanoslo.0x.no/proxy",
]

# Nano errors that are valid ledger answers, not endpoint failures.
_NANO_ERRORS = (
    "account not found",
    "block not found",
    "bad account",
    "old block",
    "fork",
    "gap",
    "unreceivable",
    "insufficient balance",
    "unopened",
)


def _load_endpoints() -> List[str]:
    """Build endpoint list from NANO_RPC_URL env var plus public fallbacks."""
    raw = os.environ.get("NANO_RPC_URL", "").strip()
    if raw:
        endpoints = [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]
    else:
        endpoints = list(DEFAULT_RPC_URLS)

    # Only add public fallbacks if the operator is already using public RPCs.
    if any(("127.0.0.1" not in u and "localhost" not in u) for u in endpoints):
        for f in PUBLIC_FALLBACKS:
            if f not in endpoints:
                endpoints.append(f)
    return endpoints


def _load_key() -> Optional[str]:
    """Read NANO_RPC_KEY, falling back to NANO_RPC_API_KEY."""
    for name in ("NANO_RPC_KEY", "NANO_RPC_API_KEY"):
        key = os.environ.get(name, "").strip()
        if key:
            return key
    return None


class NanoRPC:
    def __init__(
        self,
        endpoints: Optional[List[str]] = None,
        api_key: Optional[str] = None,
        timeout: float = 20.0,
        retries: int = 3,
    ):
        self.endpoints = list(endpoints) if endpoints else _load_endpoints()
        self.api_key = api_key if api_key is not None else _load_key()
        self.timeout = timeout
        self.retries = retries
        self._last_good_index = 0

        self.session = requests.Session()
        self.session.headers["User-Agent"] = "vela-v2/0.1"
        adapter = HTTPAdapter(pool_connections=8, pool_maxsize=32, max_retries=0)
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

    def _transport_error(self, data) -> bool:
        """Return True if the response indicates an endpoint/transport problem."""
        if not isinstance(data, dict):
            return True
        err = str(data.get("error", "")).lower()
        if not err:
            return False
        return not any(k in err for k in _NANO_ERRORS)

    def call(self, action: str, params: dict) -> dict:
        """Call a Nano RPC action, trying endpoints and retries."""
        payload = {"action": action, **params}
        # rpc.nano.to accepts the key in the body or as an Authorization header.
        if self.api_key:
            payload["key"] = self.api_key

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = self.api_key

        last_err = None

        for attempt in range(1, self.retries + 1):
            # Start from the last known-good endpoint.
            order = [self._last_good_index] + [
                i for i in range(len(self.endpoints)) if i != self._last_good_index
            ]
            for idx in order:
                endpoint = self.endpoints[idx]
                try:
                    resp = self.session.post(
                        endpoint,
                        json=payload,
                        headers=headers,
                        timeout=self.timeout,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    if self._transport_error(data):
                        last_err = RuntimeError(f"{endpoint} unusable: {data}")
                        continue
                    self._last_good_index = idx
                    return data
                except Exception as e:
                    last_err = e
                    continue

        raise RuntimeError(f"All Nano RPC endpoints failed: {last_err}")

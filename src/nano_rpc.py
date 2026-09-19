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


# rpc.nano.to is the ONE and ONLY endpoint (owner policy, AGENTS.md). There is
# no fallback node: rpc.nano-gpt.com was removed 2026-09-11 (its TLS certificate
# had expired, so it answered nothing while still masking the real error from
# nano.to). When rpc.nano.to is unreachable the correct behaviour is to say so
# loudly — the web app shows a maintenance screen — not to silently reroute
# traffic, and never to send the API key to a third-party node.
PRIMARY_RPC_URL = "https://rpc.nano.to"
DEFAULT_RPC_URLS = [PRIMARY_RPC_URL]

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

# rpc.nano.to answers a rejected key with HTTP 200 and {"error": "Invalid API
# Key."}. That is neither a ledger answer nor a transport fault: the endpoint is
# healthy, our credential is not. Reads (blocks_info, account_info, process) all
# work on nano.to's keyless tier, so the client drops the bad key and re-tries
# the SAME endpoint keyless instead of failing the call.
_AUTH_ERRORS = (
    "invalid api key",
    "api key",
    "unauthorized",
    "invalid key",
)


def _is_auth_error(data) -> bool:
    if not isinstance(data, dict):
        return False
    return any(k in str(data.get("error", "")).lower() for k in _AUTH_ERRORS)


def _load_endpoints() -> List[str]:
    """Build endpoint list from NANO_RPC_URL env var.

    Only https://rpc.nano.to is used. Fallback endpoints are intentionally
    absent so the RPC key never reaches a third-party node and an outage is
    never hidden behind a silent reroute.
    """
    raw = os.environ.get("NANO_RPC_URL", "").strip()
    if raw:
        endpoints = [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]
    else:
        endpoints = list(DEFAULT_RPC_URLS)
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
        # Flipped to True the first time rpc.nano.to rejects the key, so every
        # later call goes out keyless instead of burning a round-trip on it.
        self.key_rejected = False
        self.last_error: Optional[str] = None

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
        last_err = None

        for attempt in range(1, self.retries + 1):
            # Start from the last known-good endpoint.
            order = [self._last_good_index] + [
                i for i in range(len(self.endpoints)) if i != self._last_good_index
            ]
            for idx in order:
                endpoint = self.endpoints[idx]
                # The API key belongs to rpc.nano.to ONLY — never sent to the
                # fallback (rpc.nano.to accepts it in body or header). Once the
                # key has been rejected we stop attaching it entirely.
                use_key = (
                    bool(self.api_key)
                    and endpoint == PRIMARY_RPC_URL
                    and not self.key_rejected
                )
                try:
                    data = self._post(endpoint, action, params, use_key)
                    if use_key and _is_auth_error(data):
                        # The endpoint is alive and told us the credential is
                        # bad. Retry it immediately keyless rather than falling
                        # through to a different node.
                        self.key_rejected = True
                        print(
                            f"nano_rpc: {endpoint} rejected NANO_RPC_KEY "
                            f"({data.get('error')!r}); continuing keyless. "
                            "Renew the key to restore the paid tier."
                        )
                        data = self._post(endpoint, action, params, use_key=False)
                    if self._transport_error(data):
                        last_err = RuntimeError(f"{endpoint} unusable: {data}")
                        continue
                    self._last_good_index = idx
                    return data
                except Exception as e:
                    # Keep the primary's failure distinguishable from the
                    # fallback's: a masked primary error is what made the
                    # "invalid deposit/commit pair" stall impossible to read.
                    last_err = RuntimeError(f"{endpoint}: {e}")
                    continue

        self.last_error = str(last_err)
        raise RuntimeError(f"All Nano RPC endpoints failed: {last_err}")

    def _post(self, endpoint: str, action: str, params: dict, use_key: bool) -> dict:
        payload = {"action": action, **params}
        headers = {"Content-Type": "application/json"}
        if use_key:
            payload["key"] = self.api_key
            headers["Authorization"] = self.api_key
        resp = self.session.post(
            endpoint, json=payload, headers=headers, timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()

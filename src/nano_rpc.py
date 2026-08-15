"""
Shared Nano RPC client.

Defaults to https://rpc.nano.to. The API key is read from the
NANO_RPC_API_KEY environment variable and sent as an Authorization Bearer
token (or in the JSON body as a fallback) for higher rate limits.
"""
import os
from typing import List, Optional

import requests


DEFAULT_NANO_RPC_ENDPOINTS = ["https://rpc.nano.to"]


class NanoRPC:
    def __init__(
        self,
        endpoints: List[str] = None,
        api_key: Optional[str] = None,
    ):
        if endpoints is None:
            endpoints = list(DEFAULT_NANO_RPC_ENDPOINTS)
        self.endpoints = endpoints
        self.api_key = api_key or os.environ.get("NANO_RPC_API_KEY")
        self.session = requests.Session()
        if self.api_key:
            self.session.headers["Authorization"] = f"Bearer {self.api_key}"

    def call(self, action: str, params: dict) -> dict:
        last_err = None
        for endpoint in self.endpoints:
            try:
                payload = {"action": action, **params}
                # Some Nano RPC providers accept the key in the body;
                # include it only when no Authorization header was set.
                if self.api_key and "Authorization" not in self.session.headers:
                    payload["key"] = self.api_key
                resp = self.session.post(endpoint, json=payload, timeout=15)
                resp.raise_for_status()
                return resp.json()
            except Exception as e:
                last_err = e
                continue
        raise RuntimeError(f"All Nano RPC endpoints failed: {last_err}")

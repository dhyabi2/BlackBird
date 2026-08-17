"""
Server-side proof-of-work queue and cache.

Work is tied to a specific root (frontier or public key), so it cannot be
stockpiled generically — instead this service keeps a cache keyed by
(root, difficulty) and a background queue that computes work with the
compiled C generator (bin/workgen). Roots whose future need is known
(pool frontiers, the hash of any block just broadcast) are warmed ahead
of time so clients get instant cache hits.
"""
import os
import queue
import subprocess
import threading
import time
from collections import OrderedDict
from typing import Optional

_BIN = os.environ.get(
    "WORKGEN_BIN",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "workgen"),
)

SEND_DIFFICULTY = "fffffff800000000"
RECEIVE_DIFFICULTY = "fffffe0000000000"

MAX_CACHE = 5000
MAX_QUEUE = 1000


class WorkService:
    def __init__(self):
        self.cache: "OrderedDict[tuple, str]" = OrderedDict()
        self.pending: set = set()
        # Separate lanes: send-difficulty jobs run ~95s on this CPU and would
        # otherwise block quick (~seconds) receive-difficulty jobs behind them.
        self.q: "queue.Queue[tuple]" = queue.Queue(maxsize=MAX_QUEUE)
        self.q_fast: "queue.Queue[tuple]" = queue.Queue(maxsize=MAX_QUEUE)
        self.lock = threading.Lock()
        self.available = os.path.isfile(_BIN) and os.access(_BIN, os.X_OK)
        if self.available:
            threading.Thread(target=self._worker_loop, args=(self.q,), daemon=True).start()
            threading.Thread(target=self._worker_loop, args=(self.q_fast,), daemon=True).start()
        else:
            print(f"work service: generator binary not found at {_BIN}; service disabled")

    def _worker_loop(self, q: "queue.Queue[tuple]"):
        while True:
            key = q.get()
            root, difficulty = key
            with self.lock:
                if key in self.cache:
                    self.pending.discard(key)
                    continue
            try:
                started = time.time()
                out = subprocess.run(
                    [_BIN, root, difficulty],
                    capture_output=True,
                    text=True,
                    timeout=1800,
                )
                work = (out.stdout or "").strip()
                if len(work) == 16:
                    with self.lock:
                        self.cache[key] = work
                        while len(self.cache) > MAX_CACHE:
                            self.cache.popitem(last=False)
                    print(f"work service: {root[:12]}... @{difficulty} done in {time.time() - started:.1f}s")
            except Exception as e:
                print("work service: compute error:", e)
            finally:
                with self.lock:
                    self.pending.discard(key)

    def warm(self, root: str, difficulty: str) -> bool:
        """Queue background computation for a root. Returns False if rejected."""
        if not self.available:
            return False
        key = (root.lower(), difficulty.lower())
        with self.lock:
            if key in self.cache or key in self.pending:
                return True
            self.pending.add(key)
        target = self.q_fast if difficulty.lower() == RECEIVE_DIFFICULTY else self.q
        try:
            target.put_nowait(key)
            return True
        except queue.Full:
            with self.lock:
                self.pending.discard(key)
            return False

    def get(self, root: str, difficulty: str) -> Optional[str]:
        """Non-blocking cache lookup. Send-difficulty work also satisfies receive."""
        with self.lock:
            work = self.cache.get((root.lower(), difficulty.lower()))
            if work is None and difficulty.lower() == RECEIVE_DIFFICULTY:
                work = self.cache.get((root.lower(), SEND_DIFFICULTY))
            return work

    def get_or_wait(self, root: str, difficulty: str, wait_seconds: float) -> Optional[str]:
        """Warm the root and poll the cache for up to wait_seconds."""
        found = self.get(root, difficulty)
        if found:
            return found
        self.warm(root, difficulty)
        deadline = time.time() + max(0.0, wait_seconds)
        while time.time() < deadline:
            time.sleep(0.25)
            found = self.get(root, difficulty)
            if found:
                return found
        return None

    def stats(self) -> dict:
        with self.lock:
            return {
                "available": self.available,
                "cached": len(self.cache),
                "pending": len(self.pending),
            }

# BlackBird Agent Rules

## Nano dependencies
- Use `nanocurrency-web` for wallet derivation, block signing, and address conversion.
- Do **not** import or depend on `nanocurrency`. The reference implementation lives at
  `/Users/mac/XNO_GAME_TEMPLATE/lib/nano.js`.

## Nano RPC
- All Nano RPC calls must go through `https://rpc.nano.to` only.
- The endpoint is hard-coded in `web/src/lib/nano-rpc.ts`; it is not configurable via
  environment variables.

## Block processing
- When submitting a state block to the Nano network via `process`, always pass `subtype`
  as a top-level RPC parameter (`send`, `receive`, `change`, `epoch`), matching the
  `XNO_GAME_TEMPLATE` pattern.

## Proof of work
- PoW is generated server-side through the `/api/work` route, which calls `work_generate`
  on `rpc.nano.to` with the appropriate difficulty (`fffffff800000000` for send,
  `fffffe0000000000` for receive/open).

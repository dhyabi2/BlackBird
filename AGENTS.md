# BlackBird Agent Rules

## Nano dependencies
- Use `nanocurrency-web` for wallet derivation, block signing, and address conversion.
- Do **not** import or depend on `nanocurrency`. The reference implementation lives at
  `/Users/mac/XNO_GAME_TEMPLATE/lib/nano.js`.

## Nano RPC (strict)
- **All** Nano RPC calls must go through `https://rpc.nano.to` only.
- The endpoint is hard-coded in `web/src/lib/nano-rpc.ts`; it is not configurable via
  environment variables.
- Do **not** add fallback RPC endpoints, local node options, or off-rpc.nano.to work
  generators. PoW comes exclusively from `rpc.nano.to` `work_generate`.

## Block processing
- When submitting a state block to the Nano network via `process`, always pass `subtype`
  as a top-level RPC parameter (`send`, `receive`, `change`, `epoch`), matching the
  `XNO_GAME_TEMPLATE` pattern.

## Proof of work (strict)
- PoW is generated server-side through the `/api/work` route, which calls `work_generate`
  on `rpc.nano.to` with the appropriate difficulty (`fffffff800000000` for send,
  `fffffe0000000000` for receive/open).
- `/api/work` must **not** use local CPU, GPU, WASM, or any other non-rpc.nano.to work
  generation. If `rpc.nano.to` returns invalid work or rate-limits the request, the fix
  is to use a valid API key/account tier on `rpc.nano.to`, not to bypass it.
- Work returned by `rpc.nano.to` may be validated locally before broadcasting, but the
  source of work remains `rpc.nano.to`.

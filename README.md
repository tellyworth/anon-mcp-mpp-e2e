# anon-mcp-mpp-e2e

End-to-end tester for an anonymous paid MCP route that uses
[MPP](https://mpp.dev/) credentials settled with USDC on Base Sepolia.

The script drives the full flow against a live MCP server:

1. `initialize` an MCP session.
2. Call a paid tool (`quick_upload`) **without** a credential → expects
   JSON-RPC error `-32042 Payment Required` with a challenge.
3. Send a USDC `transfer` on Base Sepolia for the challenge amount to the
   challenge's `recipient_address`.
4. Re-call the tool with `_meta["org.paymentauth/credential"]` containing the
   settlement tx hash → expects success and an `org.paymentauth/receipt` in
   the result `_meta`.

## Prerequisites

- Node 18+.
- A Base Sepolia wallet with:
  - testnet ETH (for gas) — any Base Sepolia faucet (Coinbase Developer
    Platform, Alchemy, QuickNode).
  - testnet USDC at the contract the server's challenge advertises
    (currently `0x036CbD53842c5426634e7929541eC2318f3dCF7e`).

## Install

```sh
npm install
```

## Run

```sh
WALLET_PRIVATE_KEY=0x... npm test
```

### Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WALLET_PRIVATE_KEY` | yes | — | 0x-prefixed hex private key. |
| `MCP_URL` | no | `https://api.stage-cloudup.com/mcp/public` | Target MCP endpoint. |
| `RPC_URL` | no | `https://sepolia.base.org` | Base Sepolia JSON-RPC. |
| `HTTPS_PROXY` | no | auto-detect | e.g. `socks5h://127.0.0.1:8080`. If unset, the script probes `127.0.0.1:8080` and uses it when a SOCKS5 proxy is listening. |
| `IMAGE_FILE` | no | `./sample.jpg` | Path to image to upload. Supports `.jpg`/`.jpeg`/`.png`/`.gif`/`.webp`. |

## Example output

```
wallet         0xc5F0...
mcp            https://api.stage-cloudup.com/mcp/public
rpc            https://sepolia.base.org
proxy          socks5h://127.0.0.1:8080 (auto-detected)
image          .../sample.jpg (image/jpeg, 5012 bytes)

[1] initialize MCP session
    session    07f8ef8b-6ac5-465c-9a80-b8f7e2f83438

[2] quick_upload (no credential) -> expect -32042
    challenge  5d54617c2369ca1fb5a1f7cc5b08985f
    sku        hotlink-90d  amount 0.05 USDC
    network    base-sepolia
    contract   0x036CbD53842c5426634e7929541eC2318f3dCF7e
    recipient  0xc5F0...

[3] send USDC transfer on Base Sepolia
    tx         0x0a7f...
    confirmed  block 41348902

[4] quick_upload with credential
    upload
        item_id    ia2pjtFqCW2
        share_url  https://stage-cloudup.com/s/.../ia2pjtFqCW2
        direct_url https://cldup.stage-cloudup.com/anon/.../sample.jpg

    receipt
        sku        hotlink-90d
        amount     0.05 (settlement 0x0a7f...)
        issued     2026-05-11T07:01:32.000Z
        mac        65668e371f0cf483...

OK
```

## Notes

- The default `MCP_URL` points at a non-public staging instance. Override
  it to test a different deployment.
- The current MVP server-side verifier validates the settlement tx hash
  format and (if configured) that the tx receipt status is `0x1`. It does
  not yet verify on-chain that the tx actually transferred USDC of the
  expected amount to the configured recipient. The script sends a real
  USDC transfer regardless.

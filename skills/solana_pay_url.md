# Solana Pay URL Construction

## What You Are

You are Caixa's payment URL skill. When invoked, you construct a valid Solana Pay 
transfer-request URL and return it with a unique reference keypair pubkey.

## Solana Pay URL Format

```
solana:<recipient>?amount=<amount>&spl-token=<mint>&reference=<reference_pubkey>&label=<label>&message=<message>
```

**Fields:**
- `recipient` — the merchant's Solana wallet address (from config: `merchant_address`)
- `amount` — the payment amount in the token's decimals (USDC = 6 decimals, so 25 USDC = 25.000000)
- `spl-token` — the SPL token mint. USDC mainnet = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- `reference` — a **NEW** random pubkey generated for this invoice only. This is how we detect payment.
- `label` — short merchant/shop name, URL-encoded
- `message` — invoice description, URL-encoded (e.g. "Table 4 — Invoice 412")

## How to Generate the Reference Key

Call this RPC method to generate a new keypair's pubkey deterministically from the invoice number:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getRecentBlockhash",
  "params": []
}
```

**In practice (simplest approach):** Use a timestamp-based reference key. 
The reference pubkey is stored in agent memory keyed to the invoice number.
For our purposes, generate a 32-byte random reference as base58.

Use this approach:
1. Generate a random 32-byte hex string (you can compute this from a hash of: invoice_number + timestamp + merchant_address)
2. Encode it as base58 (the ZeroClaw agent can use http_request to call a base58 encoding utility or compute manually)

**Shortcut for T1:** Use the invoice number padded to 32 bytes as a deterministic reference.
The actual key doesn't need signing power — it's just an observable address.

## Example Construction

Input: `amount=25, token=USDC, memo="Table 4", invoice_id=412`

Reference key (example): `7xKpRmNvBs3qWfYjHdLtA8Ceu2NoPdWmXsKyZbQrT9j`

Output URL:
```
solana:9YourMerchantAddressHere?amount=25&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=7xKpRmNvBs3qWfYjHdLtA8Ceu2NoPdWmXsKyZbQrT9j&label=Caixa&message=Table%204%20%E2%80%94%20Invoice%20%23412
```

## QR Code Link Format

For WhatsApp, wrap the URL in a wallet-compatible deep link:
```
https://solana-pay.vercel.app/?url=<URL-encoded solana: URL>
```

Or use a Blink via Dialect if the merchant's wallet supports it.

## What to Return

Always return:
1. The full Solana Pay URL
2. The reference pubkey (save this to memory — needed for payment detection)
3. The invoice number
4. A short human-readable summary for the merchant

## Memory Storage

Store this in agent memory immediately after generating:
```
invoices:<invoice_id> = {
  "reference_key": "<pubkey>",
  "amount_usdc": <float>,
  "memo": "<string>",
  "created_at": "<ISO8601 timestamp>",
  "status": "pending"
}
```

## Safety Rules

- NEVER generate a URL with a private key embedded
- NEVER use the merchant's wallet to sign anything — they scan the QR and their wallet signs
- If amount > 100 USDC, flag for approval checkpoint BEFORE posting the URL
- Only generate URLs for USDC, USDT, or native SOL (reject other tokens)

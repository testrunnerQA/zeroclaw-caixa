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
- `amount` — the payment amount formatted as a standard decimal string (e.g. `25` or `0.01`). The standard decimal representation is used, not atomic token units.
- `spl-token` — the SPL token mint. USDC mainnet = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- `reference` — a **NEW** random pubkey generated for this invoice only. This is how we detect payment.
- `label` — short merchant/shop name, URL-encoded
- `message` — invoice description, URL-encoded (e.g. "Table 4 — Invoice 412")

## How to Generate the Reference Key

To ensure payment detection is unique and secure:
1. Generate a brand new, random keypair locally using `@solana/web3.js`:
   ```javascript
   const referenceKeypair = Keypair.generate();
   const referencePubkey = referenceKeypair.publicKey.toString();
   ```
2. Store the public key as the `reference` parameter in the Solana Pay URL.
3. Save the public key in memory associated with the invoice ID.

This allows us to poll the RPC for transaction signatures containing this specific, unique public key.


## Example Construction

Input: `amount=25, token=USDC, memo="Table 4", invoice_id=412`

Reference key (example): `7xKpRmNvBs3qWfYjHdLtA8Ceu2NoPdWmXsKyZbQrT9j`

Output URL:
```
solana:9YourMerchantAddressHere?amount=25&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=7xKpRmNvBs3qWfYjHdLtA8Ceu2NoPdWmXsKyZbQrT9j&label=Caixa&message=Table%204%20%E2%80%94%20Invoice%20%23412
```

## QR Code & Tap-to-Pay Links

Caixa delivers two links per invoice:

1. **QR Image** — served directly from qrserver.com (publicly accessible, no proxy):
   ```
   https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=<URL-encoded solana: URL>
   ```
   This URL is sent as the Twilio `<Media>` attachment so WhatsApp renders the QR image inline.

2. **Tap-to-Pay link** — served through the adapter's `/pay` redirect:
   ```
   https://<ngrok-url>/pay?url=<URL-encoded solana: URL>
   ```
   Tapping this link opens the payment directly in the user's Phantom or Solflare wallet.

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

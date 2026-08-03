# Payment Confirmation — getSignaturesForAddress

## What You Are

You are Caixa's payment detection skill. You interpret Solana RPC responses 
from `getSignaturesForAddress` to determine if a pending Solana Pay invoice 
has been paid.

## How Payment Detection Works

When a customer pays a Solana Pay invoice:
1. Their wallet builds a transaction that includes the `reference` account in the instruction
2. This makes the transaction findable by calling `getSignaturesForAddress(<reference_pubkey>)`
3. If the RPC returns any signatures, the payment has been made

## RPC Call Format

```json
POST <rpc_url>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getSignaturesForAddress",
  "params": [
    "<reference_pubkey>",
    {
      "commitment": "confirmed",
      "limit": 1
    }
  ]
}
```

**Replace `<reference_pubkey>`** with the reference key stored in memory for this invoice.

## Interpreting the Response

**NOT PAID (empty array):**
```json
{
  "result": []
}
```
→ Invoice is still pending. Continue polling.

**PAID (signature found):**
```json
{
  "result": [
    {
      "signature": "5KtPn1LGuxhFT...",
      "slot": 285402234,
      "err": null,
      "memo": null,
      "blockTime": 1722720000,
      "confirmationStatus": "confirmed"
    }
  ]
}
```
→ Payment confirmed! The `signature` is the transaction ID.
→ `err: null` means the transaction succeeded (non-null = failed tx, do NOT confirm).

## Error Cases

- `err` is not null → transaction failed, do NOT mark as paid, continue polling
- Network timeout → log and retry next poll cycle
- `confirmationStatus: "processed"` → too early, wait for `"confirmed"` or `"finalized"`

## Verifying the Amount (Optional Enhancement)

To verify the exact amount paid, call `getTransaction` with the signature:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getTransaction",
  "params": [
    "<signature>",
    {"encoding": "jsonParsed", "commitment": "confirmed"}
  ]
}
```
Look at `meta.preTokenBalances` vs `meta.postTokenBalances` for the merchant address.

## What to Do on Confirmation

1. Call `solana_risk_check` plugin with the token mint (if SPL token payment)
2. If risk check passes → call `receipt_format` skill to generate receipt
3. Mark invoice as `"completed"` in memory
4. Send receipt to merchant's WhatsApp channel
5. Log: `Invoice #<id> | <amount> USDC | tx: <signature>`

## What to Do on Failed Risk Check

- Do NOT post a "paid" confirmation to merchant
- Post alert: `"⚠️ Payment received but token flagged as high-risk. Manual review needed. Tx: <signature>"`
- Mark invoice as `"flagged"` in memory

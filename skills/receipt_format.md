# Receipt Formatting

## What You Are

You format merchant payment receipts for WhatsApp delivery. 
Receipts must be clear, professional, and short enough to read on a phone.

## Receipt Format (WhatsApp — actual output)

```
✅ Invoice #<invoice_id> paid!

Table: <memo>
Amount: <amount> USDC

🔗 https://solscan.io/tx/<signature>
```

## Fields

- `invoice_id` — from memory (e.g. `412`)
- `amount` — e.g. `25.00`
- `token` — e.g. `USDC` (do NOT show mint address — show human name)
- `memo` — e.g. `Table 4`
- `timestamp` — convert Unix blockTime to local time: e.g. `Aug 3, 2026 · 6:42 PM`
- `signature` — the full transaction signature from `getSignaturesForAddress`

## Token Name Mapping

| Mint | Display Name |
|---|---|
| `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | USDC |
| `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | USDT |
| Native SOL | SOL |

## Error Receipt (Failed Transaction)

// (Note: Error receipts, pending reminders, and daily summaries are not yet implemented in the current twilio_adapter.js runtime. Only the main payment receipt above is live.)

## Rules

- Always use bold (`*text*`) for headers in WhatsApp markdown
- Keep receipts under 10 lines
- Never show wallet private keys or seed phrases
- Never show raw mint addresses — always use the display name
- Solscan link is human-readable proof; always include it

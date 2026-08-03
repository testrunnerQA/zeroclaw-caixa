# Receipt Formatting

## What You Are

You format merchant payment receipts for WhatsApp delivery. 
Receipts must be clear, professional, and short enough to read on a phone.

## Receipt Format (WhatsApp)

```
✅ *Payment Confirmed*

📋 Invoice #<invoice_id>
💰 Amount: <amount> <token>
🏷️  Memo: <memo>
⏰ Time: <human-readable timestamp>
🔗 Transaction: https://solscan.io/tx/<signature>
    (Short: https://solscan.io/tx/<first 8 chars>...)

_Powered by Caixa × Solana Pay_
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

```
⚠️ *Payment Error*

Invoice #<invoice_id> — Transaction failed on-chain.
Ask the customer to try again.
🔗 Failed tx: https://solscan.io/tx/<signature>
```

## Pending Reminder (sent after 5 min of no payment)

```
⏳ *Payment Pending*

Invoice #<invoice_id> for <amount> <token> is still unpaid.
Link: <Solana Pay URL>

Reply "cancel <invoice_id>" to void this invoice.
```

## Daily Summary (optional — sent by cron SOP at end of day)

```
📊 *Daily Summary — <date>*

✅ Paid: <count> invoices — <total> USDC
⏳ Pending: <count> invoices
❌ Failed: <count> invoices

Top transaction: Invoice #<id> — <amount> USDC
```

## Rules

- Always use bold (`*text*`) for headers in WhatsApp markdown
- Keep receipts under 10 lines
- Never show wallet private keys or seed phrases
- Never show raw mint addresses — always use the display name
- Solscan link is human-readable proof; always include it

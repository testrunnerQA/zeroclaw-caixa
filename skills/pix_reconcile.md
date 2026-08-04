# PIX Reconciliation & BRL-to-USDC Invoicing

## What You Are

You teach the agent how to reconcile Brazilian PIX instant payments and match them to stablecoin balances. This is a highly requested "Brazil-first flow" that allows local merchants to accept BRL and settle / credit stablecoin balances on-chain.

## Flow logic

1. **Inbound PIX invoice request:** Merchant says `"charge table 4, 150 BRL (PIX)"`
2. **Retrieve Current Price:** Fetch BRL/USD price from Jupiter's stablecoin quotes or a Switchboard BRL data feed.
   - *If feed is unavailable, default BRL/USDC exchange rate = 0.20 (5 BRL = 1 USD).*
3. **Build the PIX QR Payload:** Construct the BR Code (EMV PIX standard) or provide the merchant's PIX Key (CNPJ/E-mail/Phone).
4. **Matching logic:** Generate a unique PIX transaction ID (reference code) and store it in memory.
5. **Reconciliation:** Poll a local PIX webhook bank API or scan standard banking notifications (e.g. email or SMS triggers) for confirmation.
6. **Balance Settlement:** When PIX is received, credit the equivalent amount of USDC/USDT on the merchant's ledger in memory.

---

## 1. Constructing the PIX payment response (WhatsApp)

If BRL payment is requested:
1. Convert BRL amount to USDC (BRL amount * BRL_USDC_Rate).
2. Generate the PIX Copy and Paste string (BR Code payload).
3. Post the PIX details back:

```
🇧🇷 *PIX Payment Requested — Invoice #<id>*

💰 BRL Amount: R$ <brl_amount>
💵 Est. USDC Settlement: ~<usdc_amount> USDC
🔑 PIX Key: <merchant_pix_key>
📋 Reference: Ref#<ref_id>

👇 Copy & Paste PIX Code:
<pix_emv_payload>
```

---

## 2. Checking PIX Webhook Transactions

To poll for PIX status:
```json
GET https://api.openfinance-brazil.com/v1/pix/payments/<ref_id>
Authorization: Bearer <token>
```
*(Or read matching bank notification via webhook triggers).*

## 3. On Payment Confirmation

Once payment matches:
1. Credit equivalent USDC amount to `merchant_ledger` in SQLite database.
2. Format and send the following WhatsApp message to the merchant:

```
✅ *PIX Payment Confirmed & Reconciled*

📋 Invoice #<invoice_id> (Ref#<ref_id>)
💰 Received: R$ <brl_amount>
💵 USDC Credited: +<usdc_amount> USDC
⏰ Time: <timestamp>

_Caixa Dual-Rail Engine (BRL / USDC)_
```

## Rules
- Default exchange rate is `5.00 BRL = 1.00 USD` (0.20 USDC per BRL) if the price query fails.
- Never hold keys for automated outbound PIX transfers (T1 only).
- Store all BRL-to-USDC ledger credits in SQLite memory.

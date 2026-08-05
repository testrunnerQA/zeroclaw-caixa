#!/usr/bin/env node
/**
 * Caixa Adapter — Twilio WhatsApp → Groq LLM → Solana Pay URL
 *
 * Receives Twilio form-encoded webhooks, calls Groq directly with a
 * minimal prompt, builds a Solana Pay URL, and replies via Twilio API.
 * Also forwards to ZeroClaw on port 42617 as a secondary path.
 */

const http = require("http");
const https = require("https");
const querystring = require("querystring");

// Load .env file if present (npm install dotenv, or use node --env-file=.env)
try { require("dotenv").config(); } catch (_) {}

// ── Config ────────────────────────────────────────────────────────────────
const ADAPTER_PORT    = 8080;
const GROQ_API_KEY    = process.env.GROQ_API_KEY    || "";
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const MERCHANT_WALLET = "Fs1Ltk21cNwfrptCFxgPDgN4JfzfAZBs8BfL9QZTh9FA";
const USDC_MINT       = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Twilio credentials
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM        = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// ── Solana Pay URL builder ─────────────────────────────────────────────────
function buildSolanaPayUrl(amount, tableNum) {
  const label   = encodeURIComponent(`Caixa — Table ${tableNum}`);
  const message = encodeURIComponent(`Payment for Table ${tableNum}: ${amount} USDC`);
  return `solana:${MERCHANT_WALLET}?amount=${amount}&spl-token=${USDC_MINT}&label=${label}&message=${message}`;
}

// ── Parse charge command ──────────────────────────────────────────────────
function parseCharge(text) {
  // Matches: "charge table 4, 25 USDC" or "charge table 4 25 usdc"
  const m = text.match(/charge\s+table\s+(\d+)[,\s]+(\d+(?:\.\d+)?)\s*usdc/i);
  if (m) return { table: m[1], amount: m[2] };
  return null;
}

// ── Call Groq API ─────────────────────────────────────────────────────────
function callGroq(userMessage) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are Caixa, a Solana Pay payment terminal for a small merchant.
Merchant wallet: ${MERCHANT_WALLET}
USDC mint: ${USDC_MINT}

When given a charge request like "charge table 4, 25 USDC":
1. Build the Solana Pay URL: solana:${MERCHANT_WALLET}?amount=25&spl-token=${USDC_MINT}&label=Caixa+Table+4&message=Payment+Table+4
2. Reply with the URL and a short friendly message.
Keep responses under 100 words. NEVER ask for keys or move funds.`;

    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system",  content: systemPrompt },
        { role: "user",    content: userMessage  }
      ],
      max_tokens: 200,
      temperature: 0.1
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content);
          } else {
            reject(new Error(`Groq error: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Send WhatsApp reply via Twilio ─────────────────────────────────────────
function sendWhatsApp(to, body) {
  return new Promise((resolve, reject) => {
    const formData = querystring.stringify({ From: TWILIO_FROM, To: to, Body: body });
    const auth     = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const options = {
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${auth}`,
        "Content-Length": Buffer.byteLength(formData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const json = JSON.parse(data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[adapter] ✅ WhatsApp sent to ${to} (sid=${json.sid})`);
          resolve(json);
        } else {
          console.error(`[adapter] ❌ Twilio error ${res.statusCode}: ${data}`);
          reject(new Error(data));
        }
      });
    });
    req.on("error", reject);
    req.write(formData);
    req.end();
  });
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook/whatsapp") {
    let rawBody = "";
    req.on("data", (c) => (rawBody += c));
    req.on("end", async () => {
      const params  = querystring.parse(rawBody);
      const message = (params.Body || "").trim();
      const from    = params.From || "unknown";

      console.log(`\n[adapter] 📨 From ${from}: "${message}"`);

      let reply = "";

      try {
        // Check for direct charge command — build URL without LLM
        const charge = parseCharge(message);

        if (charge) {
          console.log(`[adapter] 💳 Charge: Table ${charge.table}, ${charge.amount} USDC`);
          const payUrl = buildSolanaPayUrl(charge.amount, charge.table);
          reply = `🧾 Caixa Payment Request\n\n` +
                  `Table: ${charge.table}\n` +
                  `Amount: ${charge.amount} USDC\n\n` +
                  `Solana Pay Link:\n${payUrl}\n\n` +
                  `Scan with a Solana Pay wallet to complete payment.`;
          console.log(`[adapter] 🔗 URL: ${payUrl}`);
        } else {
          // General message → call Groq
          console.log(`[adapter] 🤖 Calling Groq...`);
          reply = await callGroq(message);
          console.log(`[adapter] ✅ Groq: ${reply.substring(0, 80)}...`);
        }
      } catch (err) {
        console.error(`[adapter] ❌ Error: ${err.message}`);
        reply = "Sorry, I encountered an error. Please try again.";
      }

      // Reply inside TwiML response (no ContentSid needed, works in 24h session)
      const escapedReply = reply
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapedReply}</Message></Response>`);
      console.log(`[adapter] ✅ TwiML reply sent`);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(ADAPTER_PORT, () => {
  console.log(`\n🦀 Caixa Adapter ready on port ${ADAPTER_PORT}`);
  console.log(`📱 Twilio webhook: https://<ngrok>/webhook/whatsapp`);
  console.log(`💳 Merchant: ${MERCHANT_WALLET.slice(0, 8)}...`);
  console.log(`\nWaiting for WhatsApp messages...\n`);
});

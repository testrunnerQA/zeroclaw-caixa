#!/usr/bin/env node
/**
 * Caixa — Complete Solana Pay Payment Terminal
 *
 * Full flow:
 *   1. Merchant texts "charge table 4, 25 USDC" on WhatsApp
 *   2. Agent replies with QR code + unique Solana Pay URL (with reference key)
 *   3. Customer scans QR → Phantom/Solflare pays
 *   4. Agent polls getSignaturesForAddress every 10s
 *   5. On payment detected → sends "Invoice #N paid ✓" to merchant
 *
 * Custody tier: T1 (no keys held — Solana Pay URL only, human signs)
 */

const http      = require("http");
const https     = require("https");
const crypto    = require("crypto");
const querystring = require("querystring");

// Load .env automatically — no npm package needed
(function loadEnv() {
  try {
    const fs = require("fs"), path = require("path");
    const lines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (_) {}
})();


// ── Config ────────────────────────────────────────────────────────────────
const ADAPTER_PORT    = 8080;
const GROQ_API_KEY    = process.env.GROQ_API_KEY    || "";
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const HELIUS_API_KEY  = process.env.HELIUS_API_KEY  || "";
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || "2fAnsV5TMp5nF2VH2kd5Ebjqv6LjDPyKn3cUA8GaVbE2";
const CLUSTER         = "mainnet-beta";
const USDC_MINT       = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Mainnet USDC
const POLL_INTERVAL   = 10000; // 10 seconds
const INVOICE_TTL     = 30 * 60 * 1000; // 30 minutes

// Twilio
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM        = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// ── Invoice store ─────────────────────────────────────────────────────────
let invoiceCounter = 1;
// Map<referenceKey (base58) → { invoiceId, table, amount, from, createdAt }>
const pendingInvoices = new Map();
// Array of completed invoices kept for dashboard history
const paidInvoices = [];

// ── Pending WhatsApp notifications (delivered on next inbound message) ─────
// Map<whatsapp_number → string[]>
const pendingNotifications = new Map();

function queueNotification(to, msg) {
  const q = pendingNotifications.get(to) || [];
  q.push(msg);
  pendingNotifications.set(to, q);
}

function flushNotifications(from) {
  const q = pendingNotifications.get(from);
  if (!q || q.length === 0) return "";
  pendingNotifications.delete(from);
  return q.join("\n\n---\n\n") + "\n\n";
}

// ── Base58 encoder (for reference keys — no npm needed) ───────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf) {
  let n = BigInt("0x" + buf.toString("hex"));
  let s = "";
  const base = 58n;
  while (n > 0n) { s = B58[Number(n % base)] + s; n /= base; }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) s = "1" + s;
  return s;
}

function generateReferenceKey() {
  return base58Encode(crypto.randomBytes(32));
}

// ── Public URL: env var (production) or ngrok auto-detect (local dev) ─────
let BASE_URL = process.env.PUBLIC_URL || "";

function fetchNgrokUrl() {
  if (BASE_URL) return Promise.resolve(BASE_URL); // already set via env
  return new Promise((resolve) => {
    const req = http.get("http://localhost:4040/api/tunnels", (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).tunnels?.find(x => x.proto === "https")?.public_url || ""); }
        catch (_) { resolve(""); }
      });
    });
    req.on("error", () => resolve(""));
    req.setTimeout(2000, () => { req.destroy(); resolve(""); });
  });
}

// ── URL builders ──────────────────────────────────────────────────────────
function buildSolanaPayUrl(amount, tableNum, referenceKey) {
  // Bare minimum Solana Pay URL — spaces as %20 (not +) for wallet QR scanner compatibility
  const url = `solana:${MERCHANT_WALLET}?amount=${amount}&spl-token=${USDC_MINT}&reference=${referenceKey}&label=Caixa%20Table%20${tableNum}`;
  console.log(`[pay-url] ${url}`);
  return url;
}

function buildQrProxyUrl(payUrl) {
  return BASE_URL ? `${BASE_URL}/qr?d=${encodeURIComponent(payUrl)}` : null;
}

function buildPayLink(payUrl) {
  return BASE_URL ? `${BASE_URL}/pay?url=${encodeURIComponent(payUrl)}` : payUrl;
}

// ── Parse charge command ──────────────────────────────────────────────────
function parseCharge(text) {
  // Match: "charge <description>, <amount> usdc"  (comma optional)
  // Examples: "charge table 4, 0.01 usdc"
  //           "charge table 4 seat 2, 4 USDC"
  //           "charge VIP lounge, 50 USDC"
  const m = text.match(/charge\s+(.+?)[\s,]+([\d.]+)\s*usdc/i);
  if (m) {
    const label  = m[1].trim().replace(/,\s*$/, ""); // strip trailing comma
    const amount = m[2];
    if (parseFloat(amount) > 0 && label.length > 0) return { table: label, amount };
  }
  return null;
}

// ── Solana RPC (public mainnet primary, Helius fallback) ──────────────────
const RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null,
].filter(Boolean);
let rpcIndex = 0;

function rpcRequest(method, params) {
  return new Promise((resolve, reject) => {
    const rpcUrl = RPC_URLS[rpcIndex % RPC_URLS.length];
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const u = new URL(rpcUrl);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", (e) => {
      // Rotate to next RPC on error
      if (RPC_URLS.length > 1) {
        rpcIndex++;
        console.log(`[rpc] ↩️  Rotating to: ${RPC_URLS[rpcIndex % RPC_URLS.length].slice(0, 45)}...`);
      }
      reject(e);
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("RPC timeout")); });
    req.write(body); req.end();
  });
}

async function getSignaturesForAddress(address) {
  const resp = await rpcRequest("getSignaturesForAddress", [address, { limit: 1 }]);
  return resp.result || [];
}

// ── Payment poller ─────────────────────────────────────────────────────────
async function checkPendingPayments() {
  if (pendingInvoices.size === 0) return;
  for (const [refKey, invoice] of pendingInvoices) {
    // Expire old invoices
    if (Date.now() - invoice.createdAt > INVOICE_TTL) {
      console.log(`[poll] ⏰ Invoice #${invoice.invoiceId} expired`);
      pendingInvoices.delete(refKey);
      continue;
    }
    try {
      const sigs = await getSignaturesForAddress(refKey);
      if (sigs.length > 0) {
        const sig = sigs[0].signature;
        console.log(`\n[poll] 💸 PAYMENT DETECTED — Invoice #${invoice.invoiceId}`);
        console.log(`[poll] 📍 Table: ${invoice.table}`);
        console.log(`[poll] 💰 Amount: ${invoice.amount} USDC`);
        console.log(`[poll] 🔗 Tx: https://solscan.io/tx/${sig}`);
        pendingInvoices.delete(refKey);
        // Save to paid history for dashboard
        paidInvoices.unshift({ ...invoice, signature: sig, paidAt: Date.now(), status: "paid" });
        if (paidInvoices.length > 100) paidInvoices.pop(); // keep last 100
        // Notify merchant
        await sendPaymentConfirmation(invoice, sig);
      }
    } catch (e) {
      console.error(`[poll] ❌ Error checking invoice #${invoice.invoiceId}: ${e.message}`);
    }
  }
}

setInterval(checkPendingPayments, POLL_INTERVAL);

// ── Twilio Content template (created once, cached) ────────────────────────
let CONTENT_SID = process.env.TWILIO_CONTENT_SID || "";

async function ensureContentTemplate() {
  if (CONTENT_SID) return CONTENT_SID;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return "";
  // Create a free-form twilio/text template
  const payload = JSON.stringify({
    friendly_name: "caixa_payment_confirm",
    language: "en",
    types: { "twilio/text": { body: "{{1}}" } }
  });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "content.twilio.com",
      path: "/v1/Content",
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${auth}`, "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(d);
          if (json.sid) { CONTENT_SID = json.sid; console.log(`[twilio] 📄 Content template: ${CONTENT_SID}`); resolve(CONTENT_SID); }
          else { console.log(`[twilio] ⚠️  Template creation failed: ${d.slice(0,120)}`); resolve(""); }
        } catch { resolve(""); }
      });
    });
    req.on("error", () => resolve(""));
    req.write(payload); req.end();
  });
}

// ── Send outbound WhatsApp via Twilio API ──────────────────────────────────
async function sendWhatsApp(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error("Twilio creds not set");
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const sid = await ensureContentTemplate();
  let form;
  if (sid) {
    // Use ContentSid template (required by Twilio WhatsApp 2025)
    form = querystring.stringify({
      From: TWILIO_FROM, To: to,
      ContentSid: sid,
      ContentVariables: JSON.stringify({ "1": body })
    });
  } else {
    // Fallback: plain Body (may fail on WhatsApp sandbox)
    form = querystring.stringify({ From: TWILIO_FROM, To: to, Body: body });
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${auth}`, "Content-Length": Buffer.byteLength(form) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        const json = JSON.parse(d);
        if (res.statusCode >= 200 && res.statusCode < 300) { console.log(`[twilio] ✅ Sent (sid=${json.sid})`); resolve(json); }
        else { reject(new Error(`Twilio ${res.statusCode}: ${d}`)); }
      });
    });
    req.on("error", reject); req.write(form); req.end();
  });
}


async function sendPaymentConfirmation(invoice, signature) {
  const explorerUrl = `https://solscan.io/tx/${signature}`;
  const msg = `✅ Invoice #${invoice.invoiceId} paid!\n\nTable: ${invoice.table}\nAmount: ${invoice.amount} USDC\n\n🔗 ${explorerUrl}`;

  // Queue confirmation — delivered via TwiML on merchant's next WhatsApp message
  // (Twilio sandbox blocks proactive REST API messages regardless of ContentSid)
  if (invoice.from && invoice.from.startsWith("whatsapp:")) {
    queueNotification(invoice.from, msg);
    console.log(`[poll] 📬 Confirmation queued → will arrive on next WhatsApp message`);
  }
  console.log(`[poll] 📋 Confirmation:\n${msg}`);
}

// ── Groq LLM call ─────────────────────────────────────────────────────────
function callGroq(userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: "You are Caixa, a Solana Pay payment terminal for a merchant. Your ONLY function is to inform users to send a charge command in the format: 'charge <table>, <amount> USDC'. You CANNOT process refunds, transfers, send funds, or interact with any wallet address. If asked to refund, transfer, send, or pay anything, reply ONLY: 'I cannot process refunds or transfers. This terminal only creates payment requests. Contact the merchant directly.' Never confirm any financial action. Keep replies under 60 words." },
        { role: "user",   content: userMessage }
      ],
      max_tokens: 150, temperature: 0.1
    });
    const req = https.request({
      hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d).choices?.[0]?.message?.content || "Sorry."); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ── Proxy: fetch QR image and pipe through our server ─────────────────────
function proxyQrImage(payUrl, res) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&ecc=M&data=${encodeURIComponent(payUrl)}`;
  https.get(qrUrl, (img) => {
    if (img.statusCode !== 200) { res.writeHead(502); res.end("QR fetch failed"); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=60" });
    img.pipe(res);
  }).on("error", (e) => { res.writeHead(502); res.end("QR error"); });
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${ADAPTER_PORT}`);

  // GET /qr?d=<solana-pay-url> — QR image proxy (for Twilio <Media>)
  if (req.method === "GET" && parsed.pathname === "/qr") {
    proxyQrImage(parsed.searchParams.get("d") || "", res); return;
  }

  // ── Localhost-only guard for /dashboard and /api/* ──────────────────────
  const host = req.headers.host || "";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (!isLocal && (parsed.pathname === "/dashboard" || parsed.pathname.startsWith("/api/"))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden — Dashboard is only accessible from localhost");
    return;
  }

  // GET /dashboard — serve dashboard.html
  if (req.method === "GET" && parsed.pathname === "/dashboard") {
    const fs = require("fs"), path = require("path");
    try {
      const html = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (_) { res.writeHead(404); res.end("dashboard.html not found"); }
    return;
  }

  // GET /api/config — return merchant config for the dashboard
  if (req.method === "GET" && parsed.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      merchantWallet: MERCHANT_WALLET,
      cluster: CLUSTER,
      usdcMint: USDC_MINT,
      pendingInvoices: pendingInvoices.size
    }));
    return;
  }

  // GET /api/invoices — return pending + paid invoices for dashboard history
  if (req.method === "GET" && parsed.pathname === "/api/invoices") {
    const list = [];
    for (const [refKey, inv] of pendingInvoices) {
      const qrUrl = inv.payUrl
        ? `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&ecc=M&data=${encodeURIComponent(inv.payUrl)}`
        : null;
      const tapLink = inv.payUrl ? buildPayLink(inv.payUrl) : null;
      list.push({ ...inv, refKey: refKey.slice(0, 8) + "...", qrUrl, tapLink, status: "pending" });
    }
    // Append paid invoices (most recent first)
    for (const inv of paidInvoices) {
      const solscanUrl = `https://solscan.io/tx/${inv.signature}`;
      list.push({ ...inv, refKey: "paid", qrUrl: null, tapLink: solscanUrl });
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/invoice — create invoice from dashboard form
  if (req.method === "POST" && parsed.pathname === "/api/invoice") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { amount, memo } = JSON.parse(body);
        const tableNum = memo || "Dashboard";
        const invoiceId = invoiceCounter++;
        const refKey   = generateReferenceKey();
        const payUrl   = buildSolanaPayUrl(amount, tableNum, refKey);
        const qrUrl    = buildQrProxyUrl(payUrl);   // ngrok URL — for Twilio <Media>
        const tapLink  = buildPayLink(payUrl);
        // Direct qrserver URL — works in browser without proxy
        const qrUrlBrowser = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=20&ecc=M&data=${encodeURIComponent(payUrl)}`;

        pendingInvoices.set(refKey, {
          invoiceId, table: tableNum, amount, payUrl, from: "dashboard", createdAt: Date.now()
        });
        console.log(`\n[dashboard] 💳 Invoice #${invoiceId} — ${tableNum} → ${amount} USDC`);

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ invoiceId, payUrl, qrUrl: qrUrlBrowser, tapLink, refKey: refKey.slice(0, 8) + "..." }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /pay?url=<solana-pay-url> — wallet deep link redirect page
  if (req.method === "GET" && parsed.pathname === "/pay") {
    const solanaUrl = parsed.searchParams.get("url") || "";
    const esc = solanaUrl.replace(/"/g, "&quot;");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Caixa Pay</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#0f0f1a;color:#fff}
a.btn{display:inline-block;padding:16px 32px;background:#9945FF;color:#fff;border-radius:12px;text-decoration:none;font-size:20px;font-weight:bold;margin-top:20px}</style>
<script>window.location.href="${esc}";</script></head>
<body><h2>💜 Caixa Payment</h2><p>Opening your Solana wallet...</p><a class="btn" href="${esc}">Open Wallet</a></body></html>`);
    return;
  }

  // POST /webhook/whatsapp — Twilio inbound
  if (req.method === "POST" && parsed.pathname === "/webhook/whatsapp") {
    let rawBody = "";
    req.on("data", c => rawBody += c);
    req.on("end", async () => {
      const params  = querystring.parse(rawBody);
      const message = (params.Body || "").trim();
      const from    = params.From || "unknown";
      console.log(`\n[adapter] 📨 From ${from}: "${message}"`);

      try {
        const charge = parseCharge(message);

        if (charge) {
          const invoiceId  = invoiceCounter++;
          const refKey     = generateReferenceKey();
          // Normalize table label: "4" → "Table 4", "Table 4" stays as-is
          const tableLabel = String(charge.table).toLowerCase().startsWith("table")
            ? charge.table : `Table ${charge.table}`;
          const payUrl     = buildSolanaPayUrl(charge.amount, tableLabel, refKey);
          const qrUrl      = buildQrProxyUrl(payUrl);
          const tapLink    = buildPayLink(payUrl);

          // Register invoice for polling
          pendingInvoices.set(refKey, {
            invoiceId, table: tableLabel, amount: charge.amount,
            payUrl, from, createdAt: Date.now()
          });

          console.log(`[adapter] 💳 Invoice #${invoiceId} — ${tableLabel} → ${charge.amount} USDC`);
          console.log(`[adapter] 🔑 Reference: ${refKey.slice(0, 12)}...`);
          console.log(`[adapter] 🔗 ${payUrl.slice(0, 80)}...`);
          console.log(`[adapter] ⏳ Polling for payment every ${POLL_INTERVAL/1000}s (${pendingInvoices.size} active)`);

          const pending  = flushNotifications(from);
          const text = `${pending}🧾 Invoice #${invoiceId} — Caixa\n\n${tableLabel}\nAmount: ${charge.amount} USDC\n\n👆 Tap to pay:\n${tapLink}\n\n(Or scan QR above with Phantom / Solflare)`;
          const esc  = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const mediaTag = qrUrl ? `<Media>${qrUrl}</Media>` : "";

          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}${mediaTag}</Message></Response>`);
          console.log(`[adapter] ✅ Reply sent${qrUrl ? " with QR" : ""}${pending ? " + queued notification" : ""}`);

        } else {
          const pending = flushNotifications(from);
          if (pending) {
            // Deliver queued payment confirmation(s) before normal reply
            console.log(`[adapter] 📬 Flushing queued notification to ${from}`);
            const esc = pending.trim().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
            res.writeHead(200, { "Content-Type": "text/xml" });
            res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`);
          } else {
            console.log(`[adapter] 🤖 Groq...`);
            let reply;
            try { reply = await callGroq(message); }
            catch (e) { reply = "Hi! Send 'charge table N, X USDC' to create a payment request."; }
            const esc = reply.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
            res.writeHead(200, { "Content-Type": "text/xml" });
            res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`);
          }
        }
      } catch (err) {
        console.error(`[adapter] ❌ ${err.message}`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error. Try: charge table N, X USDC</Message></Response>`);
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(ADAPTER_PORT, async () => {
  BASE_URL = await fetchNgrokUrl();
  const rpcLabel = HELIUS_API_KEY ? "Helius mainnet" : "api.mainnet-beta.solana.com";
  console.log(`\n🦀 Caixa Payment Terminal — port ${ADAPTER_PORT}`);
  console.log(`🌐 ngrok:    ${BASE_URL || "NOT DETECTED"}`);
  console.log(`💳 Merchant: ${MERCHANT_WALLET.slice(0, 8)}...`);
  console.log(`⛓️  RPC:      ${rpcLabel}`);
  console.log(`🔄 Polling:  every ${POLL_INTERVAL/1000}s`);
  console.log(`\nEndpoints:`);
  console.log(`  POST /webhook/whatsapp`);
  console.log(`  GET  /qr?d=<url>  (QR proxy)`);
  console.log(`  GET  /pay?url=<url>  (wallet redirect)`);
  console.log(`\n✅ Ready. Text 'charge table N, X USDC' to the sandbox!\n`);
});

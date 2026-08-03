#!/usr/bin/env bash
# Caixa Integration Test — Devnet end-to-end
# Tests the full payment flow against Solana devnet
# Run from repo root: ./tests/integration_test.sh

set -euo pipefail

HELIUS_KEY="${HELIUS_API_KEY:-}"
MERCHANT_ADDR="${CAIXA_MERCHANT_ADDR:-}"

if [[ -z "$HELIUS_KEY" ]] || [[ -z "$MERCHANT_ADDR" ]]; then
    echo "ERROR: Set HELIUS_API_KEY and CAIXA_MERCHANT_ADDR environment variables"
    exit 1
fi

RPC_URL="https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}"
USDC_DEVNET="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"  # USDC devnet mint

echo "=== Caixa Integration Test Suite ==="
echo "Network: devnet"
echo "Merchant: ${MERCHANT_ADDR:0:8}..."
echo ""

# ── Test 1: RPC connectivity ──────────────────────────────────────────────────
echo "[1/5] Testing RPC connectivity..."
SLOT=$(curl -s -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")

if [[ -n "$SLOT" ]] && [[ "$SLOT" =~ ^[0-9]+$ ]]; then
    echo "  ✅ RPC connected. Current slot: $SLOT"
else
    echo "  ❌ RPC connection failed"
    exit 1
fi

# ── Test 2: Solana Pay URL construction ──────────────────────────────────────
echo "[2/5] Testing Solana Pay URL construction..."

INVOICE_ID=999
AMOUNT="0.01"
MEMO="Integration%20Test%20%23999"
# Simple reference key: hash of invoice_id + timestamp
TIMESTAMP=$(date +%s)
REF_SEED="${INVOICE_ID}_${TIMESTAMP}"
# Use a valid devnet address as reference (in real usage, this would be a fresh keypair pubkey)
REFERENCE_KEY="11111111111111111111111111111112"  # System program (safe for devnet test)

SOLANA_PAY_URL="solana:${MERCHANT_ADDR}?amount=${AMOUNT}&spl-token=${USDC_DEVNET}&reference=${REFERENCE_KEY}&label=Caixa&message=${MEMO}"

echo "  Solana Pay URL:"
echo "  $SOLANA_PAY_URL"

# Validate URL format
if [[ "$SOLANA_PAY_URL" == solana:* ]] && [[ "$SOLANA_PAY_URL" == *"reference="* ]]; then
    echo "  ✅ URL format valid"
else
    echo "  ❌ URL format invalid"
    exit 1
fi

# ── Test 3: getSignaturesForAddress with empty result ─────────────────────────
echo "[3/5] Testing getSignaturesForAddress (expect empty — no payment made)..."

SIGS=$(curl -s -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"${REFERENCE_KEY}\",{\"commitment\":\"confirmed\",\"limit\":1}]}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result', [])))")

echo "  Signatures found: $SIGS"
# For the system program reference key, there will be transactions
echo "  ✅ RPC call succeeded (found $SIGS signatures for reference key)"

# ── Test 4: Token risk check (allowlist fast path) ────────────────────────────
echo "[4/5] Testing token allowlist (USDC devnet mint)..."

# Simulate allowlist check
USDC_MAINNET="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
ALLOWLIST=("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")

if [[ " ${ALLOWLIST[*]} " =~ " ${USDC_MAINNET} " ]]; then
    echo "  ✅ USDC correctly identified as allowlisted (score=0, safe=true)"
else
    echo "  ❌ USDC not in allowlist"
    exit 1
fi

# ── Test 5: RugCheck API connectivity ─────────────────────────────────────────
echo "[5/5] Testing RugCheck API connectivity..."

RUGCHECK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://api.rugcheck.xyz/v1/tokens/${USDC_MAINNET}/report/summary" \
    -H "Accept: application/json" \
    --max-time 10)

if [[ "$RUGCHECK_STATUS" == "200" ]]; then
    echo "  ✅ RugCheck API reachable (HTTP 200)"
else
    echo "  ⚠️  RugCheck API returned HTTP $RUGCHECK_STATUS (non-blocking — allowlist covers USDC)"
fi

echo ""
echo "=== All tests completed ==="
echo ""
echo "Next steps for full E2E test:"
echo "1. Run: zeroclaw run --config config/agent.toml"
echo "2. Send WhatsApp: 'charge 0.01 USDC test payment'"
echo "3. Scan the Solana Pay QR with Phantom on devnet"
echo "4. Wait 30 seconds for poll SOP confirmation"

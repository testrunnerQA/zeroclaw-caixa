#!/usr/bin/env bash
# Build script for Caixa — ZeroClaw Solana Pay agent
# Run from repo root: ./build.sh

set -euo pipefail

echo "=== Caixa Build Script ==="
echo ""

# ── Check prerequisites ───────────────────────────────────────────────────────
echo "[1/4] Checking prerequisites..."

# Ensure ~/.cargo/bin is in PATH for shell execution
export PATH="$HOME/.cargo/bin:$PATH"

check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo "  ❌ '$1' not found. $2"
        return 1
    fi
    echo "  ✅ $1 found: $(command -v "$1")"
}

check_cmd cargo "Install Rust: https://rustup.rs/"
check_cmd git "Install Git from your OS package manager"

# Check wasm32-wasip2 target
if "$HOME/.cargo/bin/rustup" target list --installed 2>/dev/null | grep -q "wasm32-wasip2" || rustup target list --installed 2>/dev/null | grep -q "wasm32-wasip2"; then
    echo "  ✅ wasm32-wasip2 target installed"
else
    echo "  Installing wasm32-wasip2 target..."
    "$HOME/.cargo/bin/rustup" target add wasm32-wasip2 || rustup target add wasm32-wasip2
fi

# ── Clone ZeroClaw (if not already present) ───────────────────────────────────
echo ""
echo "[2/4] Setting up ZeroClaw host..."

if [[ ! -d "zeroclaw" ]]; then
    echo "  Cloning ZeroClaw..."
    git clone https://github.com/zeroclaw-labs/zeroclaw zeroclaw
else
    echo "  ZeroClaw directory exists, pulling latest..."
    git -C zeroclaw pull --ff-only
fi

echo "  Building ZeroClaw with plugin & WhatsApp support..."
echo "  Command: cargo build --release --features plugins-wasm-cranelift,channel-whatsapp-cloud"
(cd zeroclaw && cargo build --release --features plugins-wasm-cranelift,channel-whatsapp-cloud)

ZEROCLAW_BIN="./zeroclaw/target/release/zeroclaw"
if [[ -f "$ZEROCLAW_BIN" ]]; then
    echo "  ✅ ZeroClaw binary built: $ZEROCLAW_BIN"
    echo "  Version: $($ZEROCLAW_BIN --version 2>/dev/null || echo 'unknown')"
else
    echo "  ❌ ZeroClaw binary not found after build"
    exit 1
fi

# Sync WIT files from ZeroClaw to make sure the interface signatures match exactly
echo "  Syncing WIT definitions..."
rm -rf plugins/solana-risk/wit
mkdir -p plugins/solana-risk/wit
cp -r zeroclaw/wit/v0/* plugins/solana-risk/wit/

# Generate WIT bindings first
echo "  Generating WIT bindings..."
(cd plugins/solana-risk && \
    cargo build --release --target wasm32-wasip2 \
    2>&1 | tail -5)

WASM_PATH="plugins/solana-risk/target/wasm32-wasip2/release/zeroclaw_solana_risk.wasm"
if [[ -f "$WASM_PATH" ]]; then
    WASM_SIZE=$(du -h "$WASM_PATH" | cut -f1)
    echo "  ✅ WASM plugin built: $WASM_PATH ($WASM_SIZE)"
else
    echo "  ❌ WASM plugin not found after build"
    echo "  Hint: Check if wit/v0 bindings match the actual ZeroClaw WIT definitions"
    echo "        Copy wit/ files from: zeroclaw/wit/v0/"
    exit 1
fi

# ── Run host-target tests ────────────────────────────────────────────────────
echo ""
echo "[4/4] Running tests (host target)..."

(cd plugins/solana-risk && cargo test --target $(rustup show | grep "Default host" | awk '{print $3}') 2>&1)
echo "  ✅ Plugin tests passed"

# ── Final instructions ────────────────────────────────────────────────────────
echo ""
echo "=== Build complete! ==="
echo ""
echo "Next steps:"
echo "1. Configure variables: cp .env.example .env (and fill in your real values)"
echo "2. Set up Twilio WhatsApp webhook to your ngrok URL + /webhook/whatsapp"
echo "3. Start the Twilio adapter: node twilio_adapter.js"
echo "4. In a new window, start the daemon:"
echo "   export \$(grep -v '^#' .env | xargs)"
echo "   ./zeroclaw/target/release/zeroclaw daemon --config-dir config/"
echo ""
echo "Test it:"
echo "  Send 'charge table 4, 0.01 USDC' to your Twilio sandbox WhatsApp number"
echo "  Or run: ./tests/integration_test.sh"

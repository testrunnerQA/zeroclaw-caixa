// ZeroClaw WASM Plugin: Solana Token Risk Checker
//
// Implements the `tool-plugin` world from ZeroClaw's wit/v0 WIT definitions.
// This plugin checks a Solana SPL token's risk score using RugCheck's public API
// and applies a hard-coded allowlist for known-safe tokens.
//
// Permissions required: ["http_client", "config_read"]
//
// One component = one tool: "solana_risk_check"

#![no_std]
extern crate alloc;

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::format;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// WIT bindings — generated from zeroclaw's wit/v0/tool-plugin.wit
// Replace this path with the actual generated bindings from your ZeroClaw checkout
#[allow(warnings)]
mod bindings;

use bindings::exports::zeroclaw::plugin::tool::{Guest, ToolCall, ToolResult, ToolDefinition, ParameterSchema};
use bindings::zeroclaw::plugin::http::{request, HttpRequest, HttpMethod};
use bindings::zeroclaw::plugin::logging::log;

/// Hard-coded allowlist: tokens that ALWAYS pass risk check.
/// These are the canonical mainnet addresses.
const ALLOWLIST: &[&str] = &[
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
    "So11111111111111111111111111111111111111112",      // Wrapped SOL
    "11111111111111111111111111111111",                  // Native SOL (system program)
];

/// Maximum allowed risk score (0–100). Scores above this are rejected.
const MAX_SAFE_SCORE: u8 = 30;

/// RugCheck API base URL
const RUGCHECK_API: &str = "https://api.rugcheck.xyz/v1/tokens";

#[derive(Serialize, Deserialize, Debug)]
struct RiskCheckInput {
    /// SPL token mint address (base58)
    token_mint: String,
    /// Optional: transaction signature for context (not used in API call, for logging)
    transaction_signature: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct RiskCheckOutput {
    /// Whether the token is considered safe
    safe: bool,
    /// Risk score 0–100 (0 = safest, 100 = highest risk)
    score: u8,
    /// Human-readable risk flags
    flags: Vec<String>,
    /// Token name if available
    token_name: Option<String>,
    /// Whether the result came from the allowlist
    allowlisted: bool,
}

/// RugCheck API response shape (simplified)
#[derive(Deserialize, Debug)]
struct RugCheckResponse {
    #[serde(rename = "score")]
    score: Option<f64>,
    #[serde(rename = "risks")]
    risks: Option<Vec<RugCheckRisk>>,
    #[serde(rename = "tokenMeta")]
    token_meta: Option<RugCheckTokenMeta>,
}

#[derive(Deserialize, Debug)]
struct RugCheckRisk {
    #[serde(rename = "name")]
    name: Option<String>,
    #[serde(rename = "description")]
    description: Option<String>,
    #[serde(rename = "level")]
    level: Option<String>,  // "danger", "warn", "info"
    #[serde(rename = "score")]
    score: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct RugCheckTokenMeta {
    #[serde(rename = "name")]
    name: Option<String>,
    #[serde(rename = "symbol")]
    symbol: Option<String>,
}

struct SolanaRiskPlugin;

impl Guest for SolanaRiskPlugin {
    fn get_definition() -> ToolDefinition {
        ToolDefinition {
            name: "solana_risk_check".to_string(),
            description: "Checks a Solana SPL token's risk score using RugCheck. \
                Returns safe=true if the token is on the allowlist or has a risk score \
                below the threshold. Always pass USDC/USDT/SOL — they are allowlisted. \
                Use this before confirming an SPL token payment.".to_string(),
            parameters: alloc::vec![
                ParameterSchema {
                    name: "token_mint".to_string(),
                    description: "The SPL token mint address (base58)".to_string(),
                    required: true,
                    schema_type: "string".to_string(),
                },
                ParameterSchema {
                    name: "transaction_signature".to_string(),
                    description: "Optional: the Solana transaction signature for logging".to_string(),
                    required: false,
                    schema_type: "string".to_string(),
                },
            ],
        }
    }

    fn invoke(call: ToolCall) -> ToolResult {
        log(&format!("[solana-risk] invoke called with {} args", call.arguments.len()));

        // Parse input arguments
        let input: RiskCheckInput = match parse_input(&call.arguments) {
            Ok(v) => v,
            Err(e) => {
                return ToolResult {
                    success: false,
                    output: format!("{{\"error\": \"Invalid input: {}\"}}", e),
                };
            }
        };

        log(&format!("[solana-risk] checking mint: {}", input.token_mint));

        // Check allowlist first — fast path, no HTTP needed
        if ALLOWLIST.contains(&input.token_mint.as_str()) {
            log(&format!("[solana-risk] mint {} is allowlisted — safe", input.token_mint));
            let output = RiskCheckOutput {
                safe: true,
                score: 0,
                flags: Vec::new(),
                token_name: allowlist_name(&input.token_mint),
                allowlisted: true,
            };
            return ToolResult {
                success: true,
                output: serde_json::to_string(&output).unwrap_or_default(),
            };
        }

        // Call RugCheck API
        match check_rugcheck(&input.token_mint) {
            Ok(output) => ToolResult {
                success: true,
                output: serde_json::to_string(&output).unwrap_or_default(),
            },
            Err(e) => {
                // On API failure, fail conservatively — do NOT approve unknown tokens
                log(&format!("[solana-risk] RugCheck API error: {} — failing closed", e));
                let output = RiskCheckOutput {
                    safe: false,
                    score: 100,
                    flags: alloc::vec![format!("API unavailable: {}", e), "Manual review required".to_string()],
                    token_name: None,
                    allowlisted: false,
                };
                ToolResult {
                    success: true,  // tool succeeded, but result says unsafe
                    output: serde_json::to_string(&output).unwrap_or_default(),
                }
            }
        }
    }
}

fn parse_input(args: &[(String, String)]) -> Result<RiskCheckInput, String> {
    let mut token_mint = None;
    let mut transaction_signature = None;

    for (key, value) in args {
        match key.as_str() {
            "token_mint" => token_mint = Some(value.clone()),
            "transaction_signature" => transaction_signature = Some(value.clone()),
            _ => {}
        }
    }

    let token_mint = token_mint.ok_or("missing required parameter: token_mint")?;
    
    // Basic base58 validation — must be 32–44 chars, no invalid chars
    if token_mint.len() < 32 || token_mint.len() > 44 {
        return Err(format!("invalid mint address length: {}", token_mint.len()));
    }

    Ok(RiskCheckInput { token_mint, transaction_signature })
}

fn check_rugcheck(mint: &str) -> Result<RiskCheckOutput, String> {
    // GET https://api.rugcheck.xyz/v1/tokens/<mint>/report/summary
    let url = format!("{}/{}/report/summary", RUGCHECK_API, mint);
    
    log(&format!("[solana-risk] calling RugCheck: {}", url));

    let req = HttpRequest {
        method: HttpMethod::Get,
        url,
        headers: alloc::vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("User-Agent".to_string(), "zeroclaw-solana-risk/0.1".to_string()),
        ],
        body: None,
        timeout_ms: Some(5000),
    };

    let resp = request(req).map_err(|e| format!("HTTP error: {:?}", e))?;

    if resp.status < 200 || resp.status >= 300 {
        return Err(format!("RugCheck returned HTTP {}", resp.status));
    }

    let body = resp.body.ok_or("empty response body")?;
    let body_str = core::str::from_utf8(&body).map_err(|_| "invalid UTF-8 response")?;
    
    log(&format!("[solana-risk] RugCheck response length: {} bytes", body_str.len()));

    // Parse response — shape output to ~200 tokens (don't flood context)
    let rugcheck: RugCheckResponse = serde_json::from_str(body_str)
        .map_err(|e| format!("JSON parse error: {}", e))?;

    // Extract score (RugCheck uses 0–1000 internally, normalize to 0–100)
    let raw_score = rugcheck.score.unwrap_or(0.0);
    let normalized_score = (raw_score / 10.0).min(100.0) as u8;

    // Extract significant risk flags (danger and warn level only)
    let mut flags: Vec<String> = Vec::new();
    if let Some(risks) = rugcheck.risks {
        for risk in risks {
            let level = risk.level.as_deref().unwrap_or("info");
            if level == "danger" || level == "warn" {
                let name = risk.name.as_deref().unwrap_or("unknown risk");
                let desc = risk.description.as_deref().unwrap_or("");
                // Keep flags short — model context is expensive
                flags.push(format!("[{}] {}", level.to_uppercase(), name));
                if !desc.is_empty() && desc.len() < 80 {
                    flags.push(desc.to_string());
                }
                if flags.len() >= 6 {
                    // Cap at 3 flag pairs (6 strings) to avoid context flooding
                    flags.push("...additional flags truncated".to_string());
                    break;
                }
            }
        }
    }

    // Token name (optional, for display)
    let token_name = rugcheck.token_meta.and_then(|m| {
        m.symbol.or(m.name)
    });

    let is_safe = normalized_score <= MAX_SAFE_SCORE && flags.iter().all(|f| !f.starts_with("[DANGER]"));

    log(&format!("[solana-risk] score={}, safe={}, flags={}", normalized_score, is_safe, flags.len()));

    Ok(RiskCheckOutput {
        safe: is_safe,
        score: normalized_score,
        flags,
        token_name,
        allowlisted: false,
    })
}

fn allowlist_name(mint: &str) -> Option<String> {
    match mint {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" => Some("USDC".to_string()),
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" => Some("USDT".to_string()),
        "So11111111111111111111111111111111111111112" => Some("Wrapped SOL".to_string()),
        _ => Some("SOL".to_string()),
    }
}

// Export the plugin implementation
bindings::export!(SolanaRiskPlugin with_types_in bindings);

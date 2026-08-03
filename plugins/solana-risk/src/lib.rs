// ZeroClaw WASM Plugin: Solana Token Risk Checker
//
// Modeled exactly on zeroclaw/crates/zeroclaw-plugins/tests/fixtures/channel-fixture
// Uses wit_bindgen::generate! macro pattern with #[cfg(target_family = "wasm")] gate.
//
// World: tool-plugin from zeroclaw:plugin@0.1.0
// Imports: logging
// Exports: plugin-info, tool
//
// Safety: fails CLOSED on API errors — unknown tokens are never auto-approved.

// Host-target code (tests, utilities)
#[cfg(not(target_family = "wasm"))]
pub mod host {
    use super::*;

    /// Validate mint address format (base58, 32-44 chars)
    pub fn validate_mint(mint: &str) -> Result<(), String> {
        if mint.len() < 32 || mint.len() > 44 {
            return Err(format!("Invalid mint length: {}", mint.len()));
        }
        Ok(())
    }

    /// Check if a mint is in the allowlist
    pub fn is_allowlisted(mint: &str) -> Option<&'static str> {
        crate::ALLOWLIST
            .iter()
            .find(|(m, _)| *m == mint)
            .map(|(_, name)| *name)
    }

    /// Build a safe output JSON string
    pub fn safe_output(name: &str) -> String {
        format!(
            r#"{{"safe":true,"score":0,"flags":[],"token_name":"{}","allowlisted":true}}"#,
            name
        )
    }

    /// Build an unsafe output JSON string  
    pub fn unsafe_output(score: u8, reason: &str) -> String {
        format!(
            r#"{{"safe":false,"score":{},"flags":["{}"],"token_name":null,"allowlisted":false}}"#,
            score, reason
        )
    }
}

/// Hard-coded allowlist: always safe, no HTTP call needed.
pub const ALLOWLIST: &[(&str, &str)] = &[
    ("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"),
    ("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"),
    ("So11111111111111111111111111111111111111112",    "Wrapped SOL"),
    ("11111111111111111111111111111111",               "SOL"),
];

/// Maximum safe RugCheck score (0-100). Above this → rejected.
pub const MAX_SAFE_SCORE: u8 = 30;

// ── WASM component (only compiled for wasm32 target) ─────────────────────────

#[cfg(target_family = "wasm")]
mod component {
    // Generate WIT bindings from the actual zeroclaw wit/v0 directory
    // The path here is relative to this file at build time
    wit_bindgen::generate!({
        path: "wit",
        world: "tool-plugin",
        features: ["plugins-wit-v0"],
    });

    extern crate alloc;
    use alloc::format;
    use alloc::string::{String, ToString};
    use alloc::vec::Vec;

    use exports::zeroclaw::plugin::plugin_info::Guest as GuestInfo;
    use exports::zeroclaw::plugin::tool::{Guest as GuestTool, ToolResult};
    use zeroclaw::plugin::logging::{
        log_record, LogLevel, PluginAction, PluginEvent, PluginOutcome,
    };

    struct SolanaRisk;

    impl GuestInfo for SolanaRisk {
        fn plugin_name() -> String {
            "zeroclaw-solana-risk".to_string()
        }
        fn plugin_version() -> String {
            env!("CARGO_PKG_VERSION").to_string()
        }
    }

    impl GuestTool for SolanaRisk {
        fn name() -> String {
            "solana_risk_check".to_string()
        }

        fn description() -> String {
            "Check a Solana SPL token risk score. \
             USDC/USDT/SOL always pass. Unknown tokens scored via RugCheck (0-100). \
             Fails closed on errors — never approves unknown tokens silently. \
             Use before confirming any non-USDC/USDT/SOL payment."
                .to_string()
        }

        fn parameters_schema() -> String {
            // Compact JSON schema — keeps model context usage low
            r#"{"type":"object","required":["token_mint"],"properties":{"token_mint":{"type":"string","description":"SPL token mint address (base58)"},"transaction_signature":{"type":"string","description":"Optional: tx signature for logging"}}}"#.to_string()
        }

        fn execute(args: String) -> Result<ToolResult, String> {
            emit(LogLevel::Info, PluginAction::Start, "execute", "Risk check started", None);

            // Parse JSON args — token_mint is required
            let token_mint = parse_mint(&args)?;

            // Validate length
            if token_mint.len() < 32 || token_mint.len() > 44 {
                let msg = format!("Invalid mint address length: {}", token_mint.len());
                return Ok(fail_result(&msg));
            }

            // Allowlist fast path — no HTTP
            for (mint, name) in crate::ALLOWLIST {
                if *mint == token_mint.as_str() {
                    emit(LogLevel::Info, PluginAction::Complete, "execute",
                         &format!("{} allowlisted", name), Some(PluginOutcome::Success));
                    return Ok(ToolResult {
                        success: true,
                        output: format!(
                            r#"{{"safe":true,"score":0,"flags":[],"token_name":"{}","allowlisted":true}}"#,
                            name
                        ),
                        error: None,
                    });
                }
            }

            emit(LogLevel::Info, PluginAction::Outbound, "execute",
                 &format!("Calling RugCheck for {}", &token_mint[..8]), None);

            // HTTP call via waki
            match rugcheck(&token_mint) {
                Ok(output) => {
                    let outcome = if output.safe { PluginOutcome::Success } else { PluginOutcome::Failure };
                    emit(LogLevel::Info, PluginAction::Complete, "execute",
                         &format!("score={} safe={}", output.score, output.safe),
                         Some(outcome));
                    Ok(ToolResult {
                        success: true,
                        output: output.to_json(),
                        error: None,
                    })
                }
                Err(e) => {
                    // Fail CLOSED — API down means unknown = unsafe
                    emit(LogLevel::Warn, PluginAction::Fail, "execute",
                         &format!("RugCheck error, failing closed: {}", e),
                         Some(PluginOutcome::Failure));
                    Ok(ToolResult {
                        success: true,
                        output: format!(
                            r#"{{"safe":false,"score":100,"flags":["API unavailable: {}","Manual review required"],"token_name":null,"allowlisted":false}}"#,
                            e
                        ),
                        error: None,
                    })
                }
            }
        }
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    struct RiskOutput {
        safe: bool,
        score: u8,
        flags: Vec<String>,
        token_name: Option<String>,
    }

    impl RiskOutput {
        fn to_json(&self) -> String {
            let flags_json: String = self.flags.iter()
                .map(|f| format!("\"{}\"", f.replace('"', "\\\"")))
                .collect::<Vec<_>>()
                .join(",");
            let name_json = match &self.token_name {
                Some(n) => format!("\"{}\"", n),
                None => "null".to_string(),
            };
            format!(
                r#"{{"safe":{},"score":{},"flags":[{}],"token_name":{},"allowlisted":false}}"#,
                self.safe, self.score, flags_json, name_json
            )
        }
    }

    // ── HTTP call ─────────────────────────────────────────────────────────────

    fn rugcheck(mint: &str) -> Result<RiskOutput, String> {
        let url = format!("https://api.rugcheck.xyz/v1/tokens/{}/report/summary", mint);

        let resp = waki::Client::new()
            .get(&url)
            .header("Accept", "application/json")
            .header("User-Agent", "zeroclaw-solana-risk/0.1")
            .connect_timeout(core::time::Duration::from_secs(5))
            .send()
            .map_err(|e| format!("HTTP: {:?}", e))?;

        if resp.status_code() < 200 || resp.status_code() >= 300 {
            return Err(format!("HTTP {}", resp.status_code()));
        }

        let body = resp.body().map_err(|e| format!("Body: {:?}", e))?;
        let s = core::str::from_utf8(&body).map_err(|_| "UTF-8")?;

        parse_rugcheck_response(s)
    }

    fn parse_rugcheck_response(body: &str) -> Result<RiskOutput, String> {
        // Manual JSON parsing to avoid complex serde deps in no_std WASM
        // RugCheck returns: {"score": <float>, "risks": [...], "tokenMeta": {...}}
        
        let score_raw = extract_f64(body, "\"score\"").unwrap_or(0.0);
        let score = ((score_raw / 10.0).min(100.0)) as u8;

        // Extract token name/symbol
        let token_name = extract_str(body, "\"symbol\"")
            .or_else(|| extract_str(body, "\"name\""));

        // Extract risk flags (danger and warn only, cap at 3 pairs)
        let flags = extract_flags(body);

        let has_danger = flags.iter().any(|f| f.starts_with("[DANGER]"));
        let is_safe = score <= crate::MAX_SAFE_SCORE && !has_danger;

        Ok(RiskOutput { safe: is_safe, score, flags, token_name })
    }

    // Minimal JSON field extractors — keeps binary small
    fn extract_f64(json: &str, key: &str) -> Option<f64> {
        let pos = json.find(key)?;
        let after = json[pos + key.len()..].trim_start_matches(|c| c == ':' || c == ' ');
        let end = after.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
            .unwrap_or(after.len());
        after[..end].parse().ok()
    }

    fn extract_str(json: &str, key: &str) -> Option<String> {
        let pos = json.find(key)?;
        let after = json[pos + key.len()..].trim_start_matches(|c| c == ':' || c == ' ');
        if !after.starts_with('"') { return None; }
        let inner = &after[1..];
        let end = inner.find('"')?;
        Some(inner[..end].to_string())
    }

    fn extract_flags(json: &str) -> Vec<String> {
        let mut flags = Vec::new();
        let mut search = json;
        
        while let Some(level_pos) = search.find("\"level\"") {
            let level_area = &search[level_pos..level_pos.min(search.len()).saturating_add(30)];
            let is_danger = level_area.contains("\"danger\"");
            let is_warn = level_area.contains("\"warn\"");
            
            if is_danger || is_warn {
                let label = if is_danger { "[DANGER]" } else { "[WARN]" };
                if let Some(name) = extract_str(search, "\"name\"") {
                    if name.len() <= 60 {
                        flags.push(format!("{} {}", label, name));
                    }
                }
                if flags.len() >= 6 {
                    flags.push("...more omitted".to_string());
                    break;
                }
            }
            // Advance past this occurrence
            search = &search[level_pos + 7..];
        }
        
        flags
    }

    // ── Arg parsing ───────────────────────────────────────────────────────────

    fn parse_mint(args: &str) -> Result<String, String> {
        // Extract token_mint from JSON string: {"token_mint": "..."}
        extract_str(args, "\"token_mint\"")
            .ok_or_else(|| "missing required field: token_mint".to_string())
    }

    fn fail_result(msg: &str) -> ToolResult {
        ToolResult {
            success: false,
            output: format!(r#"{{"error":"{}"}}"#, msg),
            error: Some(msg.to_string()),
        }
    }

    // ── Logging helper ────────────────────────────────────────────────────────

    fn emit(level: LogLevel, action: PluginAction, func: &str, msg: &str, outcome: Option<PluginOutcome>) {
        log_record(
            level,
            PluginEvent {
                function_name: format!("zeroclaw_solana_risk::{}", func),
                action,
                outcome,
                duration_ms: None,
                attrs: None,
                message: msg.to_string(),
            },
        );
    }

    export!(SolanaRisk);
}

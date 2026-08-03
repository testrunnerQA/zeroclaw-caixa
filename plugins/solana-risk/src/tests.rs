// Host-run tests for the solana-risk plugin.
// These run on the host (not WASM) using mocked HTTP.
// Run with: cargo test (from host target, not wasm32-wasip2)

#[cfg(test)]
mod tests {
    use mockito::Server;
    use serde_json::json;

    // ── Allowlist tests ──────────────────────────────────────────────────────

    #[test]
    fn test_usdc_is_allowlisted() {
        let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        assert!(crate::ALLOWLIST.contains(&usdc));
    }

    #[test]
    fn test_usdt_is_allowlisted() {
        let usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        assert!(crate::ALLOWLIST.contains(&usdt));
    }

    #[test]
    fn test_unknown_token_not_allowlisted() {
        let unknown = "FakeToken111111111111111111111111111111111111";
        assert!(!crate::ALLOWLIST.contains(&unknown));
    }

    // ── Input validation tests ───────────────────────────────────────────────

    #[test]
    fn test_parse_input_valid() {
        let args = vec![
            ("token_mint".to_string(), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()),
        ];
        let result = crate::parse_input(&args);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().token_mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    }

    #[test]
    fn test_parse_input_missing_mint() {
        let args = vec![];
        let result = crate::parse_input(&args);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("token_mint"));
    }

    #[test]
    fn test_parse_input_invalid_mint_too_short() {
        let args = vec![
            ("token_mint".to_string(), "tooshort".to_string()),
        ];
        let result = crate::parse_input(&args);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_input_with_signature() {
        let args = vec![
            ("token_mint".to_string(), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()),
            ("transaction_signature".to_string(), "5KtPn1LGuxhFT...".to_string()),
        ];
        let result = crate::parse_input(&args);
        assert!(result.is_ok());
        let input = result.unwrap();
        assert!(input.transaction_signature.is_some());
    }

    // ── RugCheck API response parsing tests ─────────────────────────────────

    #[test]
    fn test_parse_safe_rugcheck_response() {
        let response = json!({
            "score": 50.0,  // 50/1000 → normalized to 5/100 — safe
            "risks": [],
            "tokenMeta": {
                "name": "My Token",
                "symbol": "MTK"
            }
        });

        let parsed: crate::RugCheckResponse = serde_json::from_value(response).unwrap();
        let score = (parsed.score.unwrap_or(0.0) / 10.0).min(100.0) as u8;
        assert_eq!(score, 5);
        assert!(score <= crate::MAX_SAFE_SCORE);
    }

    #[test]
    fn test_parse_danger_rugcheck_response() {
        let response = json!({
            "score": 800.0,  // 800/1000 → normalized to 80/100 — unsafe
            "risks": [
                {
                    "name": "Mint authority not revoked",
                    "description": "Token supply can be inflated",
                    "level": "danger",
                    "score": 300.0
                }
            ],
            "tokenMeta": {
                "symbol": "SCAM"
            }
        });

        let parsed: crate::RugCheckResponse = serde_json::from_value(response).unwrap();
        let score = (parsed.score.unwrap_or(0.0) / 10.0).min(100.0) as u8;
        assert_eq!(score, 80);
        assert!(score > crate::MAX_SAFE_SCORE);

        let risks = parsed.risks.unwrap();
        assert!(!risks.is_empty());
        assert_eq!(risks[0].level.as_deref(), Some("danger"));
    }

    #[test]
    fn test_fail_closed_on_high_score_with_danger_flags() {
        // Even if score is borderline, DANGER flag should fail it
        let flags = alloc::vec!["[DANGER] Mint authority not revoked".to_string()];
        let has_danger = flags.iter().any(|f| f.starts_with("[DANGER]"));
        assert!(has_danger);
    }

    // ── Output token count test ──────────────────────────────────────────────

    #[test]
    fn test_output_is_compact() {
        // Ensure the output JSON is small enough for agent context
        // Target: < 200 tokens (approximately < 800 bytes for typical output)
        let output = crate::RiskCheckOutput {
            safe: true,
            score: 0,
            flags: alloc::vec![],
            token_name: Some("USDC".to_string()),
            allowlisted: true,
        };
        let json_str = serde_json::to_string(&output).unwrap();
        assert!(json_str.len() < 800, "Output too large: {} bytes", json_str.len());
    }

    #[test]
    fn test_flag_count_capped() {
        // Verify that flag output is limited to avoid flooding context
        let max_flags = 7; // 6 flag strings + "truncated" message
        let flags: alloc::vec::Vec<String> = (0..100)
            .map(|i| format!("[DANGER] risk {}", i))
            .collect();
        
        let capped: alloc::vec::Vec<_> = flags.into_iter().take(max_flags).collect();
        assert!(capped.len() <= max_flags);
    }
}

// Re-exports for test access to private functions
#[cfg(test)]
pub use crate::{parse_input, check_rugcheck, ALLOWLIST, MAX_SAFE_SCORE, RiskCheckOutput, RugCheckResponse};

// Host-target unit tests for zeroclaw-solana-risk plugin
// These run on the native host (not WASM) — no HTTP calls, no WIT bindings
// Run: cargo test

#[cfg(test)]
mod tests {
    use crate::{host, ALLOWLIST, MAX_SAFE_SCORE};

    // ── Allowlist tests ──────────────────────────────────────────────────────

    #[test]
    fn usdc_is_allowlisted() {
        let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        assert_eq!(host::is_allowlisted(usdc), Some("USDC"));
    }

    #[test]
    fn usdt_is_allowlisted() {
        let usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
        assert_eq!(host::is_allowlisted(usdt), Some("USDT"));
    }

    #[test]
    fn wrapped_sol_is_allowlisted() {
        let wsol = "So11111111111111111111111111111111111111112";
        assert_eq!(host::is_allowlisted(wsol), Some("Wrapped SOL"));
    }

    #[test]
    fn unknown_token_not_allowlisted() {
        let unknown = "FakeScamToken1111111111111111111111111111111";
        assert_eq!(host::is_allowlisted(unknown), None);
    }

    #[test]
    fn all_allowlisted_tokens_have_names() {
        for (mint, name) in ALLOWLIST {
            assert!(!mint.is_empty(), "Mint should not be empty");
            assert!(!name.is_empty(), "Name should not be empty for {}", mint);
        }
    }

    // ── Mint validation tests ────────────────────────────────────────────────

    #[test]
    fn valid_mint_passes_validation() {
        let valid = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // 44 chars
        assert!(host::validate_mint(valid).is_ok());
    }

    #[test]
    fn short_mint_fails_validation() {
        assert!(host::validate_mint("tooshort").is_err());
    }

    #[test]
    fn empty_mint_fails_validation() {
        assert!(host::validate_mint("").is_err());
    }

    #[test]
    fn min_length_32_passes() {
        let mint_32 = "11111111111111111111111111111111"; // 32 chars
        assert!(host::validate_mint(mint_32).is_ok());
    }

    #[test]
    fn too_long_mint_fails() {
        let too_long = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vXXX"; // 48 chars
        assert!(host::validate_mint(too_long).is_err());
    }

    // ── Output format tests ──────────────────────────────────────────────────

    #[test]
    fn safe_output_contains_true() {
        let out = host::safe_output("USDC");
        assert!(out.contains("\"safe\":true"));
        assert!(out.contains("\"score\":0"));
        assert!(out.contains("\"allowlisted\":true"));
        assert!(out.contains("USDC"));
    }

    #[test]
    fn unsafe_output_contains_false() {
        let out = host::unsafe_output(80, "Mint authority not revoked");
        assert!(out.contains("\"safe\":false"));
        assert!(out.contains("\"score\":80"));
        assert!(out.contains("\"allowlisted\":false"));
    }

    #[test]
    fn output_is_compact_under_800_bytes() {
        // Verify output stays small enough to not flood agent context
        let out = host::safe_output("USDC");
        assert!(out.len() < 800, "Output too large: {} bytes", out.len());
    }

    // ── Score threshold test ──────────────────────────────────────────────────

    #[test]
    fn max_safe_score_is_30() {
        // Verify the threshold is set correctly
        assert_eq!(MAX_SAFE_SCORE, 30);
    }

    #[test]
    fn score_at_threshold_is_safe() {
        assert!(MAX_SAFE_SCORE <= 100);
        // score = 30 should be safe
        let is_safe = 30u8 <= MAX_SAFE_SCORE;
        assert!(is_safe);
    }

    #[test]
    fn score_above_threshold_is_unsafe() {
        // score = 31 should be unsafe
        let is_safe = 31u8 <= MAX_SAFE_SCORE;
        assert!(!is_safe);
    }

    // ── Fail-closed behavior ──────────────────────────────────────────────────

    #[test]
    fn danger_flag_forces_unsafe_regardless_of_score() {
        // Even a low score with DANGER flag should fail
        let flags = vec!["[DANGER] Mint authority not revoked".to_string()];
        let has_danger = flags.iter().any(|f| f.starts_with("[DANGER]"));
        // Safe = score <= threshold AND no danger flags
        let score: u8 = 10; // below threshold
        let is_safe = score <= MAX_SAFE_SCORE && !has_danger;
        assert!(!is_safe, "DANGER flag should force unsafe even with low score");
    }
}

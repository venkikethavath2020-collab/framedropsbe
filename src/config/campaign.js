/**
 * Campaign leaderboard scoring — published, transparent constants.
 *
 * Roadmap feature: International Photography Day. Photographers are ranked on a
 * SINGLE balanced composite score (not per-category boards) computed LIVE from
 * source tables over a campaign window.
 *
 * Each of the 5 factors is computed as a RAW per-photographer aggregate over the
 * window, then min-max normalized to [0,1] RELATIVE TO THE MAX in the candidate
 * set, then multiplied by its published weight:
 *
 *     compositeScore = ( Σ  weightᵢ × normᵢ ) × 100
 *
 * Normalization + weighting happen in the SERVICE layer (JS) so the maths is
 * transparent and testable; SQL only does the raw aggregation + filtering.
 *
 * Weights are intentionally balanced and SUM TO 1.0. To re-weight a single
 * campaign without a deploy, set campaigns.weights (same keys) in the DB — it
 * overrides this default for that campaign only.
 */

export const CAMPAIGN_WEIGHTS = Object.freeze({
  clients:    0.20, // # clients created in the window
  uploads:    0.20, // combined: 0.5·albums + 0.5·images (see UPLOAD_SUBWEIGHTS)
  payments:   0.25, // SUM(transactions.amount) success — money paid TO THE PLATFORM
  agreements: 0.20, // # agreements accepted in the window
  activity:   0.15, // distinct active weeks in the window (consistency)
})

/** The five factor keys, in display order. */
export const CAMPAIGN_FACTORS = Object.freeze(Object.keys(CAMPAIGN_WEIGHTS))

/**
 * Sub-weights inside the combined "uploads" factor. Albums and images are
 * blended before normalization so one huge album and many small ones are
 * weighed sensibly against each other.
 */
export const UPLOAD_SUBWEIGHTS = Object.freeze({ albums: 0.5, images: 0.5 })

/**
 * Flow 2 (client_payments — customer → photographer) is deliberately EXCLUDED
 * from the "payments" factor. The campaign rewards contribution to the PLATFORM
 * (Flow 1 `transactions`), not the photographer's own customer revenue.
 */
export const CAMPAIGN_INCLUDE_CLIENT_PAYMENTS = false

/** How many top-ranked photographers the /winners endpoint returns. */
export const TOP_N_WINNERS = 10

/** Tolerance when validating that a custom weights override sums to 1.0. */
export const WEIGHTS_SUM_TOLERANCE = 0.001

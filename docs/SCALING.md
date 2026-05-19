# SCALING.md — FrameDrops capacity & upgrade thresholds

> Source of truth for "when do we upgrade what." Pairs with the live
> `/v1/admin/capacity` endpoint and the `/admin/capacity` dashboard view.
>
> When you change a threshold here, also update the `THRESHOLDS` constant
> in [`src/admin/services/capacity.service.js`](../src/admin/services/capacity.service.js).
> The two must stay in sync.

---

## TL;DR

The current single-instance setup (1 backend, starter Postgres, R2 + Workers)
**comfortably supports 0–100 photographers** and **can be pushed to 500** with
no code changes. The first real upgrade is needed at **~500–1,000 active
photographers**.

R2 + Workers won't be the bottleneck at any plausible scale. Postgres pool
saturation, single-instance availability, and Brevo email tier are.

## Capacity by tier

| Photographers | Setup | Cost / month (₹ approx) | First thing to break |
|---|---|---:|---|
| **0 – 100** | 1 instance, 512 MB RAM, starter Postgres, Brevo free | 4,000 | Nothing |
| **100 – 500** | + Brevo Starter | 6,000 | Email rate limit |
| **500 – 1,000** | + 2nd backend instance, Postgres plan with `PG_POOL_MAX=100`, Brevo Business | 10,000 | DB pool, single-point-of-failure |
| **1K – 5K** | + Postgres read replica, dedicated worker process, 2 GB primary | 25,000 | DB primary CPU, heap |
| **5K – 25K** | + 3 backend instances, Redis cache, larger Postgres | 1,25,000 | Worker process competing with API |
| **25K – 100K** | k8s, multi-region replicas, CDN, paid Sentry, on-call rotation | 6,50,000 | Team capacity |
| **100K+** | Sharded DB, multi-region writes, dedicated SRE | 50,00,000+ | Organizational |

## Thresholds (graded by the capacity endpoint)

Each metric reports `ok | warn | critical` based on these cutoffs.

| Metric | warn | critical | Notes |
|---|---:|---:|---|
| `pool_utilization_pct`     | 60% | 85% | `pg.Pool.totalCount / max` |
| `pool_waiting`             | 1   | 5   | Queries queued for a free socket |
| `db_connection_pct`        | 60% | 85% | Postgres-side, includes all tools |
| `memory_pressure_pct`      | 70% | 90% | RSS / V8 heap_size_limit. **NOT** heapUsed/heapTotal — V8 grows heapTotal lazily so a healthy 75 MB process can read 96% on that and be fine. |
| `long_query_count`         | 1   | 5   | Queries running > 1 s |
| `active_24h_per_instance`  | 500 | 1000 | Photographers active in last 24 h |

When the admin `/admin/capacity` page shows the `overall` chip in **warn** or
**critical**, it's worst-of across all metrics.

## When to upgrade what

### At 100 photographers
- **Brevo:** upgrade to Starter (~₹1,500/mo). Free tier caps at ~300/day,
  and the lifecycle worker + signup OTPs + payment receipts add up.

### At 500 photographers (first real upgrade)
This is where the audit predicted the "single-instance wall." Three changes
at once:

1. **Add a 2nd backend instance** behind a load balancer.
   The existing advisory-lock guard (`pg_try_advisory_lock(728_491_001)`) means
   workers already cope with multiple processes safely.
2. **Bump `PG_POOL_MAX` to 100.** Requires upgrading the Postgres plan to
   allow more `max_connections`. If the plan caps at 100 total, leave room
   for admin tools and migrations: set the app's pool to 80.
3. **Brevo → Business tier.**

Cost delta: roughly +₹6,000/mo. Revenue at 500 photographers is ~₹2 L/mo, so
infra remains a single-digit % of revenue.

### At 1,000 photographers
1. **Add a Postgres read replica.** Move all admin / analytics queries to
   it (see `src/admin/repositories/*.repository.js`). Frees the primary for
   transactional writes.
2. **Split the worker process from the API.** Currently the 6 workers
   (album expiry, R2 cleanup, lifecycle email, etc.) run in the same Node
   process as the API. A memory leak in one takes down both. Run them as
   a separate deploy.
3. **Scale primary Postgres to 2 GB RAM** if the dashboard's `dbConnectionPct`
   has been hovering > 50%.

### At 5,000 photographers
- 3+ backend instances.
- **Add Redis** for response caching on heavy admin queries.
- Larger Postgres (`shared_buffers`, `work_mem`).
- Hire a part-time DevOps consultant for a 2-week scaling pass.

### At 25,000 photographers
- Containers / k8s.
- Multi-region Postgres read replicas (Mumbai + Singapore).
- CDN for static assets.
- Paid Sentry, paid PostHog (or self-host).
- On-call rotation.

### At 100,000 photographers
- Sharded Postgres.
- Possibly multi-region writes.
- Dedicated SRE.

## What R2 + Workers can do without changes

For sanity:

- R2 storage scales to petabytes. The compressed-only pipeline at ~275 KB
  per photo means **even at 1M photographers, total storage ~860 TB** — and
  with the 30-day retention, only ~70 TB live at steady state. R2 doesn't
  notice. Egress is free.
- Workers' free $5 plan covers 10M req/mo. Your unit-economics model puts
  delivery requests at ~12.9 GB/mo per 10K photographers. Worker cost grows
  linearly and stays under 1% of revenue at every tier.

You will outgrow your team before you outgrow Cloudflare.

## How to verify a tier is safe

Before scaling marketing past a tier:

1. Run the load test:
   ```bash
   cd framedropsbe/load-tests
   BASE_URL="https://staging.api.framedrops.in" k6 run photographer-baseline.js
   ```
2. Watch the live `/admin/capacity` dashboard during the run.
3. Pass criteria from the test must hold (p95 < 800 ms, error rate < 1%).
4. Capacity overall must stay `ok` at the target VU count — if it flips
   to `warn` mid-run, plan the upgrade *before* you announce the launch.

## Operational runbook

When the dashboard goes red, in priority order:

| Symptom on dashboard | First action |
|---|---|
| `pool.utilization` critical, `pool.waiting > 5` | Bump `PG_POOL_MAX`, verify Postgres has spare connections, restart |
| `database.utilization` critical | Postgres plan upgrade — out of total connections |
| `process.heap` critical | Restart instance, then look for leaks (long-lived Buffers, growing Maps) |
| `longQueries.count` > 5 | Check pgAdmin / `pg_stat_activity`; usually a stuck cron tick |
| `activity.active24h` > 1000 per instance | You crossed a tier — add an instance |

## Don't do these

- Don't **lower** these thresholds without a measured baseline run.
- Don't **lower `PG_POOL_MAX`** below 50; the workers alone need ~6
  connections steady-state.
- Don't **disable the apiLimiter / paymentLimiter** to "fix" load test
  failures. Those limits are protecting real photographers.
- Don't **add an ORM** in a scaling pass. The capacity story is built
  around tight raw-SQL queries — an ORM will paper over slow queries.
- Don't **scale Brevo aggressively** ahead of need. Email cost scales
  cleanly; jumping to enterprise too early is wasted spend.

## Last reviewed

Update this section when thresholds change.

- 2026-05-09 — initial doc; thresholds match `THRESHOLDS` constant in
  `capacity.service.js`. Tier costs from unit-economics model with
  compressed photos (~275 KB) and 30-day retention.

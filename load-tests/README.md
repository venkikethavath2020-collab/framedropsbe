# Load tests

Single-purpose load tests for Framedrops, written in [k6](https://k6.io/).

> **Never point these at production.** The scripts refuse to run against `framedrops.in` (only `staging.framedrops.in` and `localhost`).

## Install k6

```bash
brew install k6              # macOS
# or: https://k6.io/docs/get-started/installation/
```

## Run the baseline test

```bash
# Against local backend
TOKEN="<jwt>" \
BASE_URL="http://localhost:3000" \
k6 run photographer-baseline.js

# Or with login credentials (script logs in once per VU)
LOAD_USER_EMAIL="loadtest@framedrops.in" \
LOAD_USER_PASSWORD="..." \
BASE_URL="https://staging.api.framedrops.in" \
k6 run photographer-baseline.js
```

## What it tests

The script ramps up to 500 concurrent virtual photographers and exercises the
typical dashboard-browsing mix (albums list → clients → billing → notifications).
This matches the "where will the system break first?" thresholds documented in
[`../docs/SCALING.md`](../docs/SCALING.md).

### Pass criteria

| Metric | Target |
|---|---|
| `http_req_failed` rate | < 1% |
| Overall p95 | < 800 ms |
| Albums list p95 | < 800 ms |
| Billing endpoint p95 | < 1500 ms (heavier query) |
| Notifications p95 | < 500 ms |

If thresholds fail at 250 VUs but pass at 100, you've reproduced the
"500-photographer wall" predicted in `SCALING.md` and need to plan the
2-instance + larger Postgres upgrade.

## Watching capacity during the run

In a separate terminal, hit the admin capacity endpoint every 10s:

```bash
watch -n 10 'curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3000/v1/admin/capacity | jq ".data.pool, .data.database, .data.process"'
```

You'll see pool waiting count climb, heap utilization rise, and the
`overall` field flip from `ok → warn → critical` as load increases.
That's exactly what the dashboard at `/admin/capacity` will show in
real time.

## Adding a new test

Create a new `*.js` file in this folder. Reuse the BASE_URL guard pattern
to avoid accidental production runs. Don't commit anything that
auto-targets production.

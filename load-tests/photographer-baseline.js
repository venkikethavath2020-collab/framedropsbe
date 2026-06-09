/**
 * Framedrops baseline load test — simulates a typical photographer mix
 * against a running backend (local or staging only).
 *
 * Run:
 *   BASE_URL=http://localhost:3000  k6 run photographer-baseline.js
 *   BASE_URL=https://staging.api.framedrops.in  k6 run photographer-baseline.js
 *
 * The script REFUSES to run if BASE_URL contains `framedrops.in` without
 * `staging.` — guards against accidentally hammering production.
 *
 * What it simulates per VU (virtual photographer):
 *   1. POST /v1/auth/login       (or use a pre-issued token via TOKEN env)
 *   2. GET  /v1/albums           (dashboard list)
 *   3. GET  /v1/clients          (clients tab)
 *   4. GET  /v1/billing/locked-albums?clientId=...   (gate fetch)
 *   5. GET  /v1/notifications    (poll)
 *   6. Sleep 5–15s, repeat
 *
 * VU ramp:
 *   30s →  10 VUs   (smoke)
 *   2m  → 100 VUs   (Phase-1 target)
 *   2m  → 250 VUs   (mid-tier check)
 *   2m  → 500 VUs   (where the audit predicts pool pressure)
 *   1m  → 0 VUs     (cooldown)
 *
 * Pass criteria:
 *   p95 < 800 ms across all GET endpoints
 *   error rate < 1%
 */

import http from 'k6/http'
import { check, sleep, fail } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const PRESET_TOKEN = __ENV.TOKEN || ''
const EMAIL = __ENV.LOAD_USER_EMAIL || ''
const PASSWORD = __ENV.LOAD_USER_PASSWORD || ''

if (BASE_URL.includes('framedrops.in') && !BASE_URL.includes('staging')) {
  fail(`Refusing to run against ${BASE_URL}. Use staging or localhost.`)
}

export const options = {
  scenarios: {
    photographer_browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '2m',  target: 100 },
        { duration: '2m',  target: 250 },
        { duration: '2m',  target: 500 },
        { duration: '1m',  target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed:   ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    'http_req_duration{endpoint:albums}':       ['p(95)<800'],
    'http_req_duration{endpoint:clients}':      ['p(95)<800'],
    'http_req_duration{endpoint:billing}':      ['p(95)<1500'],   // billing is heavier
    'http_req_duration{endpoint:notifications}':['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

const errorRate  = new Rate('framedrops_errors')
const albumsTrend = new Trend('framedrops_albums_ms')

// k6 `setup` runs ONCE before any VU starts. The returned value is passed
// into the default function on every iteration — that's how all 500 VUs
// share one token without re-logging-in.
//
// We also probe ONE authenticated request here so we fail fast with a
// clear message instead of silently 401'ing 21k times across all VUs.
export function setup() {
  let token
  if (PRESET_TOKEN) {
    console.log('Using preset TOKEN env var')
    token = PRESET_TOKEN
  } else {
    if (!EMAIL || !PASSWORD) {
      fail('Provide TOKEN env var, or LOAD_USER_EMAIL + LOAD_USER_PASSWORD')
    }
    console.log(`Logging in as ${EMAIL}…`)
    const res = http.post(
      `${BASE_URL}/v1/auth/login`,
      JSON.stringify({ email: EMAIL, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } },
    )
    if (res.status !== 200) {
      fail(`Login failed: ${res.status} ${res.body}`)
    }
    const body = res.json()
    token = body && body.data && body.data.token
    if (!token) fail('Login response did not include token')
  }

  // Sanity probe — does the token actually work?
  const probe = http.get(`${BASE_URL}/v1/albums`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: 'setup-probe' },
  })
  if (probe.status !== 200) {
    fail(
      `Token probe failed: status=${probe.status} ` +
      `body=${String(probe.body).slice(0, 200)}\n` +
      `Re-grab a fresh token before running the test.`
    )
  }
  console.log(`Token probe OK (status ${probe.status}). Starting load test…`)
  return { token }
}

export default function (data) {
  const headers = {
    'Authorization': `Bearer ${data.token}`,
    'Accept': 'application/json',
  }

  // 1. Albums list — most common dashboard hit
  const albumsRes = http.get(`${BASE_URL}/v1/albums`, {
    headers,
    tags: { endpoint: 'albums' },
  })
  albumsTrend.add(albumsRes.timings.duration)
  if (!check(albumsRes, { 'albums 200': (r) => r.status === 200 })) {
    errorRate.add(1)
    if (__ITER === 0) console.error(`albums failed: ${albumsRes.status} ${String(albumsRes.body).slice(0, 150)}`)
  }

  sleep(randBetween(0.5, 1.5))

  // 2. Clients list
  const clientsRes = http.get(`${BASE_URL}/v1/clients`, {
    headers,
    tags: { endpoint: 'clients' },
  })
  check(clientsRes, { 'clients 200': (r) => r.status === 200 }) || errorRate.add(1)

  // Try to extract a real clientId for the billing call below.
  let clientId = null
  try {
    const body = clientsRes.json()
    const list = (body && body.data) || []
    if (list.length > 0) clientId = list[0].id
  } catch (_) { /* ignore */ }

  sleep(randBetween(0.5, 1.5))

  // 3. Billing — the gate fetch. Heavy query (joins + aggregates).
  if (clientId) {
    const billingRes = http.get(
      `${BASE_URL}/v1/billing/locked-albums?clientId=${clientId}`,
      { headers, tags: { endpoint: 'billing' } },
    )
    check(billingRes, { 'billing 200': (r) => r.status === 200 }) || errorRate.add(1)
  }

  sleep(randBetween(0.5, 1.5))

  // 4. Notifications poll — lightweight
  const notifRes = http.get(`${BASE_URL}/v1/notifications`, {
    headers,
    tags: { endpoint: 'notifications' },
  })
  check(notifRes, { 'notifs 200': (r) => r.status === 200 }) || errorRate.add(1)

  // Real photographers don't refresh every 100ms.
  sleep(randBetween(5, 15))
}

function randBetween(min, max) {
  return Math.random() * (max - min) + min
}

/**
 * Framedrops billing-endpoint stress test.
 *
 * The general baseline test (photographer-baseline.js) often skips the
 * billing endpoint when the test photographer has no clients yet. This
 * test focuses *only* on /v1/billing/locked-albums?clientId=X — the
 * heaviest query in the stack (joins albums × photos × transactions, plus
 * the per-(photographer,client) image pool aggregate).
 *
 * Run:
 *   TOKEN="<jwt without 'Bearer '>" \
 *   BASE_URL="http://localhost:3000" \
 *   k6 run billing-stress.js
 *
 * Prerequisites:
 *   The test photographer the JWT belongs to must have at least 1 client.
 *   Create one through the UI or seed the DB before running. The test
 *   refuses to start if it finds zero clients (better than running 7
 *   minutes against an empty endpoint).
 */

import http from 'k6/http'
import { check, sleep, fail } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const TOKEN = __ENV.TOKEN || ''

if (BASE_URL.includes('framedrops.in') && !BASE_URL.includes('staging')) {
  fail(`Refusing to run against ${BASE_URL}. Use staging or localhost.`)
}
if (!TOKEN) {
  fail('Provide TOKEN env var (no "Bearer " prefix).')
}

export const options = {
  scenarios: {
    billing_hammer: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m',  target: 100 },
        { duration: '2m',  target: 250 },
        { duration: '2m',  target: 500 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed:   ['rate<0.02'],            // billing is heavy; allow 2%
    http_req_duration: ['p(95)<2000'],           // billing target
    'http_req_duration{endpoint:billing}': ['p(95)<2000', 'p(99)<5000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

const errorRate = new Rate('billing_errors')
const billingTrend = new Trend('billing_ms')

// Run once before VUs start. Probes auth + harvests real client UUIDs to
// rotate through. All VUs share the resulting client list.
export function setup() {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
  }

  // 1. Auth probe.
  const probe = http.get(`${BASE_URL}/v1/albums`, {
    headers,
    tags: { endpoint: 'setup-probe' },
  })
  if (probe.status !== 200) {
    fail(
      `Token probe failed: status=${probe.status} ` +
      `body=${String(probe.body).slice(0, 200)}\n` +
      `Re-grab a fresh token before running.`
    )
  }

  // 2. Harvest client IDs.
  const clientsRes = http.get(`${BASE_URL}/v1/clients?perPage=50`, {
    headers,
    tags: { endpoint: 'setup-clients' },
  })
  if (clientsRes.status !== 200) {
    fail(`Clients fetch failed: ${clientsRes.status} ${clientsRes.body}`)
  }
  const body = clientsRes.json()
  const list = (body && body.data) || []
  const ids = list.map((c) => c && c.id).filter(Boolean)

  if (ids.length === 0) {
    fail(
      'Test photographer has 0 clients — billing test cannot run.\n' +
      'Create at least one client through the UI (Dashboard → Clients → New)\n' +
      'or via the API, then re-run.'
    )
  }

  console.log(`Token probe OK. Harvested ${ids.length} client UUID(s) to rotate through.`)
  return { clientIds: ids }
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
  }

  // Pick a client UUID — rotate so we don't hit the same DB rows every iteration.
  const clientId = data.clientIds[Math.floor(Math.random() * data.clientIds.length)]

  const res = http.get(
    `${BASE_URL}/v1/billing/locked-albums?clientId=${clientId}`,
    { headers, tags: { endpoint: 'billing' } },
  )
  billingTrend.add(res.timings.duration)

  if (!check(res, { 'billing 200': (r) => r.status === 200 })) {
    errorRate.add(1)
    if (__ITER === 0) {
      console.error(`billing failed: ${res.status} ${String(res.body).slice(0, 200)}`)
    }
  }

  // Real photographers don't refresh the gate every 100ms.
  sleep(randBetween(2, 5))
}

function randBetween(min, max) {
  return Math.random() * (max - min) + min
}

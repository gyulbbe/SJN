#!/usr/bin/env bash
# The sanitary-ware AI direction-photo trial's Cloudflare step (docs/sanitary-direction-photos-20261107.md
# section 5): the 41 class views the free local run did not get right, one answer each (seed 1001), with
# the class guide. The user chose this on 2026-11-07 ("안 된 41곳만"). Run after 09:00 KST, when the
# account's day has turned:
#   bash tests/sanitary-guides/cf-failed.sh
# The run refuses past the day's share (budget.ts) and stops on a 429 or the account's limit; no retry.
# Stop wrangler and workerd afterwards.
set -u
cd /c/dev/SJN-wall-drawing
SP="${SP:-/tmp}"
OUT="/c/dev/SJN/test-results/위생도기-방향사진-20261107"
echo "start $(date -u +%FT%TZ)"
npx wrangler dev --config tests/direction-photo-methods/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8806 > "$SP/ai-worker-sanitary.log" 2>&1 &
for i in $(seq 1 60); do curl -s http://127.0.0.1:8806/ > /dev/null && break; sleep 2; done
curl -s http://127.0.0.1:8806/ || { echo "worker did not start"; exit 1; }
echo
ONLY="$(cat "$OUT/review/local-failed-views.txt")" node tests/run-browser-test.mjs tests/sanitary-guides/run.ts cf all G rep 1001
echo "run exit $? at $(date -u +%FT%TZ)"

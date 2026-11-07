#!/usr/bin/env bash
# The sanitary-ware AI direction-photo trial's second Cloudflare step (docs/sanitary-direction-photos-20261107.md
# section 8, the user's choice of 2026-11-07 "옆 문장 시험"): G2 (the class guide with the photo-angle and
# elevation sentences) once (seed 1001) at the 29 views that turned to the photo's angle on 2026-11-07
# (review/cf-turned-views.txt; T5's front left out, its G2 is its G), and T8's front with its new guide.
# Run after 09:00 KST on 2026-11-08, when the account's day has turned:
#   bash tests/sanitary-guides/cf-g2.sh
# The run refuses past the day's share (budget.ts) and stops on a 429 or the account's limit; no retry.
set -u
cd /c/dev/SJN-wall-drawing
SP="${SP:-/tmp}"
OUT="/c/dev/SJN/test-results/위생도기-방향사진-20261107"
echo "start $(date -u +%FT%TZ)"
npx wrangler dev --config tests/direction-photo-methods/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8806 > "$SP/ai-worker-sanitary-g2.log" 2>&1 &
for i in $(seq 1 60); do curl -s http://127.0.0.1:8806/ > /dev/null && break; sleep 2; done
curl -s http://127.0.0.1:8806/ || { echo "worker did not start"; exit 1; }
echo
R="node tests/run-browser-test.mjs tests/sanitary-guides/run.ts"
ONLY="$(cat "$OUT/review/cf-turned-views.txt")" $R cf all G2 rep 1001 &&
  ONLY="T8:front" $R cf T8 G rep 1001
echo "run exit $? at $(date -u +%FT%TZ)"

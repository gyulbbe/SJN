#!/usr/bin/env bash
# cf-g2.sh's 30 calls on the user's second Cloudflare account (2026-11-07: "cloudflare 계정 하나 더 있는데
# 그걸로 해봐"), straight to its Workers AI REST API with the token in the main checkout's git-ignored
# .env.cf-second (paths.mjs SECOND_ACCOUNT_FILE); no Worker. The ledger rows say account "second", and
# the day's share (budget.ts, estimated 5,000) counts that account only. Stops on a 429 or a limit; no retry.
#   bash tests/sanitary-guides/cf-g2-second.sh
set -u
cd /c/dev/SJN-wall-drawing
OUT="/c/dev/SJN/test-results/위생도기-방향사진-20261107"
echo "start $(date -u +%FT%TZ)"
R="node tests/run-browser-test.mjs tests/sanitary-guides/run.ts"
CF_ACCOUNT=second ONLY="$(cat "$OUT/review/cf-turned-views.txt")" $R cf all G2 rep 1001 &&
  CF_ACCOUNT=second ONLY="T8:front" $R cf T8 G rep 1001
echo "run exit $? at $(date -u +%FT%TZ)"

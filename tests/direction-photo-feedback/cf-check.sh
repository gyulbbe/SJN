#!/usr/bin/env bash
# The Cloudflare check of 2026-11-07 (docs/direction-photo-feedback-20261107.md), the user's second account
# (CF_ACCOUNT=second, the main checkout's git-ignored .env.cf-second): 14 calls, estimate 1,548.
# - "고칠 점" way A on four failed answers: the words (quick fix for B1·B15, Korean for B6·B12) and the
#   control with nothing asked, one each (8).
# - The basin sentences on the app's own guide: the old app text (C0) and the new one (C0G2) at three
#   basin sides (6).
# Stops on a refusal of the daily share, a 429 or a limit; no retry.
set -u
cd /c/dev/SJN-wall-drawing
export CF_ACCOUNT=second
F="node tests/run-browser-test.mjs tests/direction-photo-feedback/run.ts"
S="node tests/run-browser-test.mjs tests/sanitary-guides/run.ts"
$F cf A fix B1,B15 &&
  $F cf A ko B6,B12 &&
  $F cf A none B1,B6,B15,B12 &&
  ONLY="B1:left,B15:left,B21:left" $S cf B1,B15,B21 C0,C0G2 rep 1001
echo "exit $?"

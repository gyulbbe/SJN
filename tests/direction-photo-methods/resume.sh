#!/usr/bin/env bash
# The direction-photo methods trial's remaining Cloudflare runs (docs/direction-photo-methods-results-20261105.md
# section 12), after 09:00 KST when the account's daily allowance has reset:
#   bash tests/direction-photo-methods/resume.sh
# Each run starts only if the one before finished (&&): a refusal or a 429 (exit 3) stops the rest.
# The worker's log goes to $SP (default /tmp). Stop wrangler and workerd afterwards.
set -u
cd /c/dev/SJN-wall-drawing
SP="${SP:-/tmp}"
echo "start $(date -u +%FT%TZ)"
npx wrangler dev --config tests/direction-photo-methods/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8806 > "$SP/ai-worker3.log" 2>&1 &
for i in $(seq 1 60); do curl -s http://127.0.0.1:8806/ > /dev/null && break; sleep 2; done
curl -s http://127.0.0.1:8806/ || { echo "worker did not start"; exit 1; }
echo
R="node tests/run-browser-test.mjs tests/direction-photo-methods/run.ts"
$R r6 cf b04,b09,b13 B2 front --holdout &&
  $R r6 cf b09 B2B4 back --holdout &&
  $R r6 cf b04,b09,b13 B2C3 left --holdout &&
  $R r6 cf b13 C0 left --holdout &&
  $R r3 cf t-ark-2p,u5 C0 left,right &&
  $R r3 cf t-ark-2p,u5 B4 right &&
  $R r3 cf t-ark-2p,u5 B6 right &&
  $R r3 cf t-ark-2p A1 right &&
  $R r3 cf bath61 C0 left,back &&
  $R r3 cf bath61 C3 left,back &&
  $R r3 cf bath61 B4 back
echo "runs exit $? at $(date -u +%FT%TZ)"

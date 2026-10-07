#!/usr/bin/env bash
# Production gate for a vendored-HiGHS refresh (vendor/highs-build/PROVENANCE.md,
# refresh procedure step 3): compare the vendored build against a reference
# build on a snapshot of the real DATA_DIR, solving the config production
# builds (prediction adjustments + the adaptive-learning calibration).
#
#   scripts/prod-solver-gate.sh <addon-host[:port]>
#       fetches GET /data, /settings, /plan-accuracy/calibration and
#       /predictions/adjustments (port 3070; read-only GETs)
#   scripts/prod-solver-gate.sh <data.json> <settings.json> [calibration.json [ev-calibration.json]]
#       uses files copied from the add-on's /data (adjustments live in data.json)
#
# Without a calibration snapshot a box in adaptive-learning auto mode is solved
# UNCALIBRATED, and compare-highs-builds.ts says so. REF=<git rev> picks the
# commit whose vendor/highs-build is the reference (default 3fe075e = v0.7.56,
# HiGHS 1.8.0). The snapshot is written to a private temp dir and removed on
# exit; any haToken in the settings is stripped before it is written.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ref="${REF:-3fe075e}"
work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

strip_token='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);delete o.haToken;process.stdout.write(JSON.stringify(o))})'
snapshot=()
if [[ $# -eq 1 ]]; then
  host="$1"
  [[ "$host" == *:* ]] || host="$host:3070"
  curl -fsS -m 15 "http://$host/data" -o "$work/data.json"
  curl -fsS -m 15 "http://$host/settings" | node -e "$strip_token" > "$work/settings.json"
  if curl -fsS -m 15 "http://$host/plan-accuracy/calibration" -o "$work/calibration.json"; then
    snapshot+=(--calibration "$work/calibration.json")
  else
    echo "warning: could not fetch /plan-accuracy/calibration; the gate runs uncalibrated" >&2
  fi
  if curl -fsS -m 15 "http://$host/predictions/adjustments" -o "$work/adjustments.json"; then
    snapshot+=(--adjustments "$work/adjustments.json")
  else
    echo "warning: could not fetch /predictions/adjustments; using the adjustments stored in data.json" >&2
  fi
elif [[ $# -ge 2 && $# -le 4 ]]; then
  cp "$1" "$work/data.json"
  node -e "$strip_token" < "$2" > "$work/settings.json"
  for f in "${@:3}"; do snapshot+=(--calibration "$f"); done
else
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
fi

# Reference build, verbatim from git (the directory needs its CommonJS marker).
mkdir -p "$work/ref"
for f in highs.js highs.wasm package.json; do
  git -C "$root" show "$ref:vendor/highs-build/$f" > "$work/ref/$f"
done
echo "vendored : $(sha256sum "$root/vendor/highs-build/highs.wasm" | cut -c1-16)…  (working tree)"
echo "reference: $(sha256sum "$work/ref/highs.wasm" | cut -c1-16)…  ($ref)"

# Two horizons: the whole stored series, and the plan as it would be built now.
cd "$root"
rc=0
echo; echo "== full stored horizon"
npx --no-install tsx scripts/compare-highs-builds.ts "$work/ref/highs.js" "$work/data.json" "$work/settings.json" "${snapshot[@]}" || rc=$?
echo; echo "== from the current slot"
# String(): console.log colours a bare number when FORCE_COLOR is set.
step=$(node -e 'console.log(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stepSize_m ?? 15))' "$work/settings.json")
now=$(node -e 'const s=Number(process.argv[1])*60000;console.log(new Date(Math.floor(Date.now()/s)*s).toISOString())' "$step")
future=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const end=Math.min(...["load","pv","importPrice","exportPrice"].map(k=>Date.parse(d[k].start)+d[k].values.length*d[k].step*60000));console.log(end>Date.parse(process.argv[2])?"yes":"no")' "$work/data.json" "$now")
if [[ "$future" == "yes" ]]; then
  NOW="$now" npx --no-install tsx scripts/compare-highs-builds.ts "$work/ref/highs.js" "$work/data.json" "$work/settings.json" "${snapshot[@]}" || rc=$?
else
  echo "skipped: the snapshot has no data after $now (stale snapshot or sample data)"
fi
exit "$rc"

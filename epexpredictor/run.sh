#!/bin/sh
# Starts EpexPredictor with the add-on options. /data is the add-on's persistent
# storage: trained models live in /data/models so a restart does not retrain
# from scratch.
set -eu

OPTIONS=/data/options.json
if [ -f "$OPTIONS" ]; then
  key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("entsoe_api_key") or "")' "$OPTIONS")"
  if [ -n "$key" ]; then
    export EPEXPREDICTOR_ENTSOE_API_KEY="$key"
  else
    echo "No ENTSO-E API key set: running without the ENTSO-E load forecast (reduced accuracy)."
  fi
fi

mkdir -p /data/models
export EPEXPREDICTOR_DATADIR=/data/models/

cd /code
exec uvicorn predictor.api.priceapi:app --host 0.0.0.0 --port 80

# EpexPredictor

A local copy of [EpexPredictor](https://github.com/b3nn0/EpexPredictor)
(BSD-3-Clause, by b3nn0), the day-ahead electricity price forecaster that
OptiVolt's multi-day horizon uses. Running it here means OptiVolt no longer
depends on the author's public server at `epexpredictor.batzill.com`.

## What it does

The add-on trains LightGBM models on about 180 days of history and serves
15-minute price forecasts for the next ~7 days over a small HTTP API (the same
API as the public server). It trains every region it supports, not just the
one you use, because each region's model uses its neighbours' forecasts.

It still needs internet access for its input data:

- weather: [Open-Meteo](https://open-meteo.com) (OptiVolt already uses it for PV);
- prices: [energy-charts.info](https://www.energy-charts.info) (Fraunhofer ISE);
- grid load and a second price source: the
  [ENTSO-E transparency platform](https://transparency.entsoe.eu), only with an
  API key (see below).

Trained models are kept in the add-on's `/data`, so a restart does not start
from scratch, and they are part of Home Assistant backups.

## Configuration

**ENTSO-E API key** (optional, recommended): adds ENTSO-E's grid load forecast,
which noticeably improves the model, and a fallback price source. The key is
free: register on the ENTSO-E transparency platform, then e-mail
`transparency@entsoe.eu` with "Restful API access" in the subject. Without a
key the add-on works, with somewhat lower accuracy.

## Connecting OptiVolt

1. Start this add-on and wait for the first forecast. The first request trains
   all models, which takes several minutes; the log shows the progress.
2. Open the add-on's **Info** tab and note its hostname, normally
   `601a68d0-epexpredictor`.
3. In OptiVolt → Settings → Multi-day horizon, set **Forecast URL** to
   `http://601a68d0-epexpredictor` (with your hostname) and keep the region.

The add-on is only reachable from other add-ons; no port is opened on your
network. To try the API from a browser, map port 80 in the **Network** section
and open `http://<home assistant>:<port>/docs`.

If the add-on is stopped or fails, OptiVolt plans with published prices only
(as without the multi-day horizon) and shows a warning.

## Resource use

Measured on a fast x86 desktop (2026-10-13, no ENTSO-E key): the first
forecast took about 2¼ minutes (downloading ~6 months of weather and prices
for all regions, then training); later requests answer in seconds from the
trained models. Peak memory was about 600 MB; the stored models and data take
about 15 MB. Expect the first training to take several times longer on a
low-power box. Retraining repeats when new data arrives; in between, the
add-on idles.

**Without an ENTSO-E key** the forecaster has a single price source
(energy-charts.info). In the measurement that source briefly returned empty
answers while all regions were fetched at once, the first request failed with
a server error, and the retry a few seconds later succeeded. OptiVolt retries
and keeps its last forecast, so this only delays the forecast. The local
forecast also differed from the public server's by 2.8 c/kWh on average,
about 1.7 c higher. The public server has the ENTSO-E load forecast, which
probably explains most of the gap, so set the key.

## Updates

The add-on pins one upstream commit. A new add-on version moves that pin; the
changelog says which upstream commit it runs.

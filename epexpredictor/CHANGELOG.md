# Changelog

## 0.1.0 - 2026-10-13

- First version: [EpexPredictor](https://github.com/b3nn0/EpexPredictor) at upstream commit `1f7954b` (2026-10-10), on Python 3.13 (Debian slim), with dependencies pinned in `constraints.txt`.
- Option: ENTSO-E API key (optional).
- Trained models persist in the add-on's `/data/models`; the API is reachable from other add-ons only (port 80 declared, not mapped).

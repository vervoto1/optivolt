# Home Assistant add-on image for EpexPredictor (github.com/b3nn0/EpexPredictor,
# BSD-3-Clause), the day-ahead price forecaster behind OptiVolt's multi-day
# horizon. Debian slim (glibc) rather than the Alpine HA base: LightGBM has no
# musl wheels, and the manylinux wheels install on amd64 and aarch64 alike.
FROM python:3.13-slim-bookworm

# Upstream is pinned to one commit; move it deliberately (and bump the add-on
# version in config.yaml so the new image is published).
ARG EPEXPREDICTOR_COMMIT=1f7954b96269a5a24f3e3e453f5527d413f31b1d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /code

# constraints.txt pins every runtime dependency to the versions this add-on was
# tested with; upstream's requirements.txt is unpinned. The test-only packages
# after its "# Testing dependencies" marker are not installed.
COPY constraints.txt /tmp/constraints.txt
ADD https://github.com/b3nn0/EpexPredictor/archive/${EPEXPREDICTOR_COMMIT}.tar.gz /tmp/epexpredictor.tar.gz
RUN tar -xzf /tmp/epexpredictor.tar.gz --strip-components=1 -C /code \
  && sed '/# Testing dependencies/,$d' requirements.txt > /tmp/requirements.txt \
  && pip install -r /tmp/requirements.txt -c /tmp/constraints.txt \
  && rm -rf /tmp/epexpredictor.tar.gz /tmp/requirements.txt /code/tests \
  && python -c "import lightgbm, pandas, fastapi, entsoe"

COPY run.sh /run.sh
CMD ["/run.sh"]

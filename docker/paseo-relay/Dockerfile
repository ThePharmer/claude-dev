# Paseo relay, built from getpaseo/paseo-relay at a pinned commit.
#
# Upstream publishes no container image (its CI builds one and never pushes it), so this
# wrapper reproduces upstream's Dockerfile against a source tarball. The build context is
# this directory alone; the workflow's content tag is the git tree hash of it, so bumping
# PASEO_RELAY_REF (or the base image) is what triggers a rebuild.
#
# Keep the two base images in sync with upstream's Dockerfile when bumping the ref:
#   https://github.com/getpaseo/paseo-relay/blob/<ref>/Dockerfile

ARG PASEO_RELAY_REF=3fc41c96c8c63f3a7109e832899cc57d473c4531

FROM hexpm/elixir:1.20.2-erlang-29.0.2-debian-bookworm-20260623-slim AS build
ARG PASEO_RELAY_REF
WORKDIR /app
ENV MIX_ENV=prod
ADD https://github.com/getpaseo/paseo-relay/archive/${PASEO_RELAY_REF}.tar.gz /tmp/paseo-relay.tar.gz
RUN tar -xzf /tmp/paseo-relay.tar.gz --strip-components=1 -C /app \
 && mix local.hex --force \
 && mix local.rebar --force \
 && mix deps.get --only prod \
 && mix compile \
 && mix release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 libsctp1 openssl ca-certificates \
 && rm -r /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/_build/prod/rel/paseo_relay ./
ENV HOME=/app \
    PASEO_RELAY_HOST=0.0.0.0 \
    PASEO_RELAY_PORT=4000 \
    PASEO_RELAY_DRAIN=false
EXPOSE 4000
ENTRYPOINT ["/app/bin/paseo_relay"]
CMD ["start"]

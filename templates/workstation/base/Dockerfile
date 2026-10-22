# Generic Linux workstation: a private Xvfb screen, input injection and
# screenshots for one agent. Project runtimes (engines, SDKs, assets) go in a
# separate layer FROM this image; see ../examples/.
#
# Packages come from the Debian archive (apt verifies the signed Release files)
# at fixed versions on a fixed base digest. A Debian point release can retire a
# pinned version; the build then fails instead of drifting. Update the pins, or
# point sources.list at snapshot.debian.org for an exact rebuild.
# DEBIAN_MIRROR only changes the transport path (for a slow link); signatures
# are still checked against the base image's Debian archive keyring.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb=2:21.1.16-1.3+deb13u4 \
      xdotool=1:3.20160805.1-5.1 \
      x11-utils=7.7+7 \
      x11-apps=7.7+11+b2 \
      netpbm=2:11.10.02-1 \
      xauth=1:1.1.2-1.1 \
      tini \
      jq \
      procps \
 && rm -rf /var/lib/apt/lists/*

COPY bin/ /usr/local/bin/

# One screen per container. Every `docker exec` sees the same DISPLAY, so an
# agent can drive a session container step by step.
ENV DISPLAY=:99 \
    WS_SCREEN=1920x1080x24 \
    WS_OUT=/ws/out \
    LANG=C.UTF-8

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ws-run"]

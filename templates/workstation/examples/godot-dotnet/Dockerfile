# Example project layer: Godot 4 .NET on Mesa software rendering (llvmpipe for
# OpenGL, lavapipe for Vulkan) plus the .NET SDK, so a workstation can build
# and run a Godot C# project on its private screen. Run ./fetch.sh first; the
# archives are checked again here against the official SHA512 sums.
#   docker build --build-arg BASE=<workstation base image> -t <name> .
# apt uses the base image's sources (and mirror, if one was chosen there).
ARG BASE=ai-dev-kit/workstation-base:local
FROM ${BASE}
ARG TARGETARCH
ARG GODOT_VERSION=4.7.1-stable
ARG DOTNET_SDK=8.0.129

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libgl1-mesa-dri=25.0.7-2+deb13u1 \
      libglx-mesa0=25.0.7-2+deb13u1 \
      mesa-vulkan-drivers=25.0.7-2+deb13u1 \
      libvulkan1=1.4.309.0-1 \
      libegl1 libxcursor1 libxinerama1 libxrandr2 libxi6 libfontconfig1 \
      libicu76 libssl3t64 ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

COPY SHA512SUMS /tmp/SHA512SUMS
RUN --mount=type=bind,source=downloads,target=/tmp/downloads \
    set -eu; \
    case "$TARGETARCH" in \
      arm64) godot=linux_arm64 bin=linux.arm64 dotnet=linux-arm64 ;; \
      amd64) godot=linux_x86_64 bin=linux.x86_64 dotnet=linux-x64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    zip="Godot_v${GODOT_VERSION}_mono_${godot}.zip" sdk="dotnet-sdk-${DOTNET_SDK}-${dotnet}.tar.gz"; \
    cd /tmp/downloads; \
    grep -E "  (${zip}|${sdk})\$" /tmp/SHA512SUMS | sha512sum -c -; \
    test "$(grep -cE "  (${zip}|${sdk})\$" /tmp/SHA512SUMS)" = 2; \
    mkdir -p /opt/godot /usr/share/dotnet; \
    unzip -q "$zip" -d /opt/godot; \
    ln -s "/opt/godot/Godot_v${GODOT_VERSION}_mono_${godot}/Godot_v${GODOT_VERSION}_mono_${bin}" /usr/local/bin/godot; \
    tar -xzf "$sdk" -C /usr/share/dotnet; \
    ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet; \
    rm /tmp/SHA512SUMS

# No resident MSBuild nodes or compiler server: they outlive `dotnet build` and
# share the container's memory limit with the engine that runs next.
ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_CLI_USE_MSBUILD_SERVER=0 \
    MSBUILDDISABLENODEREUSE=1 \
    UseSharedCompilation=false

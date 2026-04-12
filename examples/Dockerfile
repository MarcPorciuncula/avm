# Example ~/.avm/Dockerfile — copy to ~/.avm/Dockerfile and customize.
#
#   cp <avm-repo>/examples/Dockerfile ~/.avm/Dockerfile
#
# This Dockerfile layers your toolchain on top of the avm-core image.
# It replaces examples/setup.sh for Docker-based avm.
#
# This example reproduces the toolchain used by the Alcova-AI stack:
# pnpm, Python 3, Go (with GOPRIVATE), Buf CLI, Atlas CLI, Task,
# golangci-lint, staticcheck, Docker CLI, and git URL rewrites.
# Trim or extend it to fit your own stack.

FROM avm-core:latest

USER root

# --- Extra system packages ---

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -qq && \
    apt-get install -y -qq \
      software-properties-common \
      libssl-dev \
      > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- pnpm via corepack ---

RUN corepack enable pnpm

# --- Python 3 ---

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -qq && \
    apt-get install -y -qq python3 python3-pip python3-venv > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- Go toolchain ---

RUN GO_VERSION=$(curl -fsSL https://go.dev/VERSION?m=text | head -n1) && \
    curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-arm64.tar.gz" -o /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz && \
    echo 'export PATH=$PATH:/usr/local/go/bin:/home/agent/go/bin' > /etc/profile.d/go.sh && \
    chmod +x /etc/profile.d/go.sh

USER agent
RUN export PATH=$PATH:/usr/local/go/bin && \
    go env -w GOPRIVATE=github.com/Alcova-AI/* && \
    mkdir -p /home/agent/go/bin
USER root

# --- Buf CLI ---

RUN BUF_VERSION="1.50.0" && \
    curl -fsSL \
      "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-aarch64" \
      -o /usr/local/bin/buf && \
    chmod +x /usr/local/bin/buf

# --- Atlas CLI ---

RUN curl -sSf https://atlasgo.sh | sh > /dev/null

# --- Task (taskfile.dev) ---

RUN curl -sL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin > /dev/null

# --- golangci-lint ---

RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
    | sh -s -- -b /usr/local/bin > /dev/null

# --- staticcheck (requires Go, runs as agent) ---

USER agent
RUN export PATH=$PATH:/usr/local/go/bin && \
    go install honnef.co/go/tools/cmd/staticcheck@latest
USER root

# --- Git URL rewriting for Alcova-AI private repos ---

RUN git config --system url."git@github.com:Alcova-AI/".insteadOf "https://github.com/Alcova-AI/"

USER agent

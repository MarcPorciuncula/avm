FROM ubuntu:24.04

# --- Core system packages ---

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -qq && \
    apt-get install -y -qq \
      build-essential \
      curl \
      wget \
      git \
      jq \
      unzip \
      zip \
      tar \
      openssh-client \
      ca-certificates \
      gnupg \
      pkg-config \
      > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- Node.js (via NodeSource) — required by Claude Code ---

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1 && \
    apt-get install -y -qq nodejs > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- Docker CLI (socket is mounted from host; only the client is needed) ---

RUN curl -fsSL https://get.docker.com | sh > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

# --- Create agent user ---

RUN useradd -m -s /bin/bash agent && \
    groupadd -f docker && \
    usermod -aG docker agent

# --- Claude Code (must run as agent — installs to ~/.claude/) ---

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash

# --- Git defaults ---
RUN git config --global init.defaultBranch main && \
    git config --global pull.rebase true

# --- Standard directories ---

RUN mkdir -p ~/work

# --- Shell aliases ---

RUN echo 'alias clauded="claude --dangerously-skip-permissions"' >> ~/.bashrc

# --- Install helpers library ---

USER root
COPY templates/vm-helpers.sh /opt/avm/helpers.sh
RUN chmod 644 /opt/avm/helpers.sh

USER agent
WORKDIR /home/agent

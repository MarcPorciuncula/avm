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
      openssh-server \
      ca-certificates \
      gnupg \
      pkg-config \
      > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- Node.js (via NodeSource) — broadly useful in the core image ---

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null 2>&1 && \
    apt-get install -y -qq nodejs > /dev/null && \
    rm -rf /var/lib/apt/lists/*

# --- Docker Engine (DinD — full daemon + CLI + containerd) ---

RUN curl -fsSL https://get.docker.com | sh > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

# --- Create agent user ---

RUN useradd -m -s /bin/bash agent && \
    groupadd -f docker && \
    usermod -aG docker agent

# --- sudo for start-dockerd (agent needs to launch dockerd as root) ---

RUN apt-get update -qq && \
    apt-get install -y -qq sudo > /dev/null && \
    rm -rf /var/lib/apt/lists/* && \
    echo 'agent ALL=(root) NOPASSWD: /opt/avm/start-dockerd.sh' > /etc/sudoers.d/dockerd && \
    echo 'agent ALL=(root) NOPASSWD: /opt/avm/start-sshd.sh' > /etc/sudoers.d/sshd && \
    chmod 440 /etc/sudoers.d/dockerd /etc/sudoers.d/sshd

USER agent

# --- Git defaults (use XDG path so ~/.gitconfig doesn't shadow bind mounts) ---
RUN mkdir -p ~/.config/git && \
    git config --file ~/.config/git/config init.defaultBranch main && \
    git config --file ~/.config/git/config pull.rebase true

# --- Standard directories ---

RUN mkdir -p ~/work

# --- Shell profile ---

RUN echo 'source /opt/avm/helpers.sh' >> ~/.profile

# --- Install helpers library ---

USER root
COPY templates/vm-helpers.sh /opt/avm/helpers.sh
RUN chmod 644 /opt/avm/helpers.sh
COPY templates/start-dockerd.sh /opt/avm/start-dockerd.sh
RUN chmod 755 /opt/avm/start-dockerd.sh
COPY templates/start-sshd.sh /opt/avm/start-sshd.sh
RUN chmod 755 /opt/avm/start-sshd.sh

# --- xdg-open shim: forward browser-open requests to the host via avm-bridge ---
# Tools like `gh`, `claude /login`, npm, git web--browse, Python webbrowser,
# etc. fall back to `xdg-open` when they need to open a URL. We provide a shim
# that calls `avm-bridge browser open` so the URL opens on the host instead.
COPY templates/xdg-open.sh /usr/local/bin/xdg-open
RUN chmod 755 /usr/local/bin/xdg-open

# --- In-container skills ---

COPY templates/skills/ /opt/avm/skills/

USER agent
WORKDIR /home/agent

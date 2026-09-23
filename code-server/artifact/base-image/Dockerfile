FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG CODE_SERVER_VERSION=4.126.0
ARG BUN_VERSION=1.3.14
ARG OMP_VERSION=18.2.11
ARG GH_VERSION=2.96.0
ARG AWS_CLI_VERSION=2.34.45
ARG NODE_VERSION=24.21.0
ARG UV_VERSION=0.12.18
ARG RIPGREP_VERSION=15.2.0

RUN dnf install -y \
      shadow-utils \
      tar zip unzip gzip bzip2 xz \
      git \
      wget \
      findutils which file \
      procps-ng \
      less \
      jq \
      tree \
      diffutils \
      libatomic \
      python3 python3-pip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl.tar.gz" \
      -o /tmp/ripgrep.tar.gz \
    && echo "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915  /tmp/ripgrep.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/ripgrep.tar.gz -C /tmp \
    && install -m 0755 "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl/rg" /usr/local/bin/rg \
    && rm -rf /tmp/ripgrep.tar.gz "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl"

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-arm64.rpm" \
      -o /tmp/code-server.rpm \
    && rpm -U /tmp/code-server.rpm \
    && rm -f /tmp/code-server.rpm

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
      -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.xz \
    && npm install --global \
      "typescript@7.0.2" \
      "typescript-language-server@6.0.0" \
      "pyright@1.1.414" \
      "bash-language-server@5.8.1" \
      "yaml-language-server@1.24.0" \
    && npm cache clean --force

RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" \
      -o /tmp/bun.zip \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64

ENV BUN_INSTALL=/opt/bun
ENV PATH=${BUN_INSTALL}/bin:/usr/local/bin:/usr/bin:/bin

RUN mkdir -p ${BUN_INSTALL} \
    && bun install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
    && omp --version

RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_arm64"

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip" \
      -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz" \
      -o /tmp/uv.tar.gz \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uv /usr/local/bin/uv \
    && install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uvx /usr/local/bin/uvx \
    && rm -rf /tmp/uv.tar.gz /tmp/uv-aarch64-unknown-linux-gnu

RUN /usr/sbin/groupadd --gid 1000 vscode \
    && /usr/sbin/useradd --uid 1000 --gid 1000 --create-home --home-dir /home/vscode --shell /bin/bash vscode

ENV HOME=/home/vscode
ENV USER=vscode
ENV USER_DATA_DIR=${HOME}/.vscode
ENV EXTENSIONS_DIR=${HOME}/.local/share/code-server/extensions
ENV PI_CODING_AGENT_DIR=${HOME}/.omp/agent

RUN mkdir -p \
      ${HOME}/workspace \
      ${EXTENSIONS_DIR} \
      ${USER_DATA_DIR}/User \
      ${PI_CODING_AGENT_DIR} \
      ${HOME}/.config/gh \
      /opt/cloud-ide

COPY settings.json ${USER_DATA_DIR}/User/settings.json
COPY omp-config.yml ${PI_CODING_AGENT_DIR}/config.yml
COPY omp-cloud-ide-controls ${EXTENSIONS_DIR}/har1101.omp-cloud-ide-controls-0.1.0
COPY lifecycle.py /opt/cloud-ide/lifecycle.py
COPY start-cloud-ide.sh /usr/local/bin/start-cloud-ide
COPY persist-auth-state /usr/local/bin/persist-auth-state

COPY extensions.txt /tmp/extensions.txt
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      case "$ext" in ''|\#*) continue ;; esac; \
      code-server --install-extension "$ext" --extensions-dir "${EXTENSIONS_DIR}"; \
    done < /tmp/extensions.txt \
    && rm -f /tmp/extensions.txt

RUN echo '{"locale":"ja"}' > ${USER_DATA_DIR}/User/argv.json \
    && git config --system credential.https://github.com.helper '!gh auth git-credential' \
    && chmod 0755 /usr/local/bin/start-cloud-ide /usr/local/bin/persist-auth-state /opt/cloud-ide/lifecycle.py \
    && chown -R vscode:vscode ${HOME}

EXPOSE 8080 9000

USER vscode

CMD ["/usr/local/bin/start-cloud-ide"]

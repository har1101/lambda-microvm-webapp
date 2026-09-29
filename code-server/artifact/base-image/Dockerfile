FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Every directly downloaded artifact is verified against a pinned SHA-256.
# `npm run update-versions` rewrites CODE_SERVER_VERSION/CODE_SERVER_ARM64_RPM_SHA256
# and OMP_VERSION; update the other pairs together by hand.
ARG CODE_SERVER_VERSION=4.139.1
ARG CODE_SERVER_ARM64_RPM_SHA256=34e38458bfad5dd68dce20aa3b5d7b89dd9632ac516e109c21fa0ebbb5fca95e
ARG BUN_VERSION=1.3.14
ARG BUN_ARM64_ZIP_SHA256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b
ARG OMP_VERSION=18.4.3
ARG GH_VERSION=2.96.0
ARG GH_ARM64_TAR_SHA256=06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909
ARG AWS_CLI_VERSION=2.34.45
ARG AWS_CLI_ARM64_ZIP_SHA256=bf29e06a06fb9bac2a3803931e6618a9f7c9f4c6632ec3b587184850b8f03433
ARG NODE_VERSION=24.21.0
ARG NODE_ARM64_TAR_SHA256=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
ARG UV_VERSION=0.12.18
ARG UV_ARM64_TAR_SHA256=afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_ARM64_TAR_SHA256=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915
ARG CHROME_VERSION=154.0.8037.57
ARG CHROME_HEADLESS_SHELL_ARM64_ZIP_SHA256=2213770a541c7ea17c900c631bdb6a3cda97ecf5194a34a575f32e54a8f5ab70

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
    && echo "${RIPGREP_ARM64_TAR_SHA256}  /tmp/ripgrep.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/ripgrep.tar.gz -C /tmp \
    && install -m 0755 "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl/rg" /usr/local/bin/rg \
    && rm -rf /tmp/ripgrep.tar.gz "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl"

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-arm64.rpm" \
      -o /tmp/code-server.rpm \
    && echo "${CODE_SERVER_ARM64_RPM_SHA256}  /tmp/code-server.rpm" | sha256sum -c - \
    && rpm -U /tmp/code-server.rpm \
    && rm -f /tmp/code-server.rpm

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
      -o /tmp/node.tar.xz \
    && echo "${NODE_ARM64_TAR_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
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
    && echo "${BUN_ARM64_ZIP_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64

ENV BUN_INSTALL=/opt/bun
ENV PATH=${BUN_INSTALL}/bin:/usr/local/bin:/usr/bin:/bin

RUN mkdir -p ${BUN_INSTALL} \
    && bun install --global "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
    && omp --version

# OMP drives puppeteer-core. Chrome for Testing publishes linux-arm64 builds
# (since 153), but puppeteer would download them on first use; pre-install the
# pinned headless shell instead. Its shared libraries and fonts come from AL2023
# (CJK and Latin fallbacks keep font fallback from failing), so no process-wide
# LD_LIBRARY_PATH/FONTCONFIG_PATH override is needed.
RUN dnf install -y \
      alsa-lib at-spi2-atk at-spi2-core atk cairo cups-libs dbus-libs \
      libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon \
      mesa-libgbm nspr nss pango \
      fontconfig liberation-sans-fonts google-noto-sans-cjk-ttc-fonts \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    && curl -fsSL \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux-arm64/chrome-headless-shell-linux-arm64.zip" \
      -o /tmp/chrome-headless-shell.zip \
    && echo "${CHROME_HEADLESS_SHELL_ARM64_ZIP_SHA256}  /tmp/chrome-headless-shell.zip" | sha256sum -c - \
    && unzip -q /tmp/chrome-headless-shell.zip -d /opt \
    && rm -f /tmp/chrome-headless-shell.zip \
    && ! ldd /opt/chrome-headless-shell-linux-arm64/chrome-headless-shell | grep 'not found' \
    && /opt/chrome-headless-shell-linux-arm64/chrome-headless-shell --version

ENV PUPPETEER_EXECUTABLE_PATH=/opt/chrome-headless-shell-linux-arm64/chrome-headless-shell

RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && echo "${GH_ARM64_TAR_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_arm64"

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip" \
      -o /tmp/awscliv2.zip \
    && echo "${AWS_CLI_ARM64_ZIP_SHA256}  /tmp/awscliv2.zip" | sha256sum -c - \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz" \
      -o /tmp/uv.tar.gz \
    && echo "${UV_ARM64_TAR_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
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
      ${HOME}/workspace/.artifacts/screenshots \
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

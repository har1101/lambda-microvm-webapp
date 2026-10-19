# PoC-only interpreter. Do not change AL2023's system Python or the shared image.
USER root
RUN UV_PYTHON_INSTALL_DIR=/opt/t3poc-python UV_PYTHON_BIN_DIR=/usr/local/bin \
      UV_CACHE_DIR=/tmp/t3poc-uv-cache uv python install 3.14.4 \
    && /usr/local/bin/python3.14 -c 'import sys, sqlite3; assert sys.version_info[:3] == (3, 14, 4); assert hasattr(sqlite3.Connection, "deserialize")' \
    && rm -rf /tmp/t3poc-uv-cache
USER vscode

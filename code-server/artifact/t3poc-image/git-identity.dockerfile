# t3poc-only (not the shared OmpCloudIde base image): commit identity + gh for
# *.ghe.com. gh reads GH_TOKEN, not GH_ENTERPRISE_TOKEN. The token stays in
# /dev/shm and is never written into this image.
RUN git config --global user.name haruki-fukuchi \
    && git config --global user.email haruki-fukuchi@nec.com \
    && printf '%s\n' 'export GH_HOST=ai-native-factory-ltd.ghe.com' \
      'if [ -s /dev/shm/gh-token ]; then export GH_TOKEN="$(cat /dev/shm/gh-token)"; fi' >> ${HOME}/.bashrc

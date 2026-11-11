FROM mcr.microsoft.com/devcontainers/typescript-node:26

# Meta's Bubblewrap: packages the hosted PWA as an Android app (APK) for Meta Quest / the Horizon Store.
# Pinned: the version Meta's packaging guide was verified with. On first use it downloads a JDK and the
# Android SDK into ~/.bubblewrap, which docker-compose.yml keeps in a named volume. See docs/QUEST-PACKAGING.md.
USER root
RUN npm install --global @meta-quest/bubblewrap-cli@1.24.1 && npm cache clean --force
USER node

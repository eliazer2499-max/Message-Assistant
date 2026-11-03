# Releasing Message Assistant

1. Bump `VERSION` (and `package.json` "version").
2. `npm test` (with `MSA_PLAYWRIGHT_PATH` + `MSA_CHROMIUM` set to also run the browser tests).
3. Build the release into `docs/`:
   ```
   V=$(cat VERSION); rm -rf /tmp/pkg && mkdir -p /tmp/pkg/messageassistant
   tar -cf - --exclude=node_modules --exclude=docs --exclude=.git . | tar -xf - -C /tmp/pkg/messageassistant
   tar -czf docs/messageassistant-$V.tar.gz -C /tmp/pkg messageassistant
   cp docs/messageassistant-$V.tar.gz docs/messageassistant-latest.tar.gz
   (cd docs && sha256sum messageassistant-$V.tar.gz > messageassistant-$V.tar.gz.sha256 && sha256sum messageassistant-latest.tar.gz > messageassistant-latest.tar.gz.sha256)
   cp install.sh docs/install.sh
   ```
4. Commit and push to `main`. Servers update with `sudo messageassistant update`.

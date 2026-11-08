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
   # version.json LAST (servers look at it first): version, date, sha256, tarball, notes (the newest CHANGELOG section)
   node -e 'const fs=require("fs");const v=fs.readFileSync("VERSION","utf8").trim();const sha=fs.readFileSync("docs/messageassistant-"+v+".tar.gz.sha256","utf8").split(" ")[0];const c=fs.readFileSync("CHANGELOG.md","utf8");const m=c.split(/\n## /)[1]||"";const notes=m.split("\n").slice(1).join("\n").trim().replace(/\*\*/g,"").replace(/"/g,"\x27");fs.writeFileSync("docs/version.json.tmp",JSON.stringify({version:v,date:new Date().toISOString().slice(0,10),sha256:sha,tarball:"messageassistant-"+v+".tar.gz",notes})+"\n");fs.renameSync("docs/version.json.tmp","docs/version.json")'
   ```
4. Commit and push to `main` (version.json last). Nothing installs by itself: each server shows "update available" (and texts the admin once);
   the admin presses Update now or types `sudo messageassistant update`. Servers only install a version NEWER than theirs, so always bump VERSION.

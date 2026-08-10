#!/usr/bin/env node
/*
 * Build a portable macOS bundle of BatonBot (Apple Silicon / arm64).
 *
 * Output: dist/batonbot-portable-mac-arm64/  (and a .zip alongside)
 *
 * Layout:
 *   batonbot-portable-mac-arm64/
 *     ├── bin/
 *     │    └── node                (pinned Node 20 LTS darwin-arm64)
 *     ├── app/
 *     │    ├── batonbot.js, modules/, index.html, ...
 *     │    └── node_modules/       (prod-only)
 *     ├── config/                  (empty — first-run seeds prompts.json)
 *     ├── start.command            (double-clickable in Finder)
 *     └── README.txt
 *
 * Usage:
 *   node scripts/build-portable/build-mac.js [--node-version 20.18.1] [--arch arm64] [--skip-zip]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  REPO_ROOT, DIST_ROOT, CACHE_DIR,
  makeLog, rmrf, download,
  copyAppFiles, stagedNpmInstall, ensureCacheDir,
} = require('./common');

const NODE_VERSION_DEFAULT = '20.18.1';
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
const nodeVersion = argValue('--node-version', NODE_VERSION_DEFAULT);
const arch = argValue('--arch', 'arm64'); // arm64 | x64
const SKIP_ZIP = args.includes('--skip-zip');

if (!['arm64', 'x64'].includes(arch)) {
  console.error(`[build-mac] Invalid --arch: ${arch} (expected arm64 or x64)`);
  process.exit(1);
}

const BUNDLE_NAME = `batonbot-portable-mac-${arch}`;
const BUNDLE_DIR = path.join(DIST_ROOT, BUNDLE_NAME);
const APP_DIR = path.join(BUNDLE_DIR, 'app');
const BIN_DIR = path.join(BUNDLE_DIR, 'bin');
const CONFIG_DIR = path.join(BUNDLE_DIR, 'config');

const log = makeLog('build-mac');

async function fetchPinnedNode() {
  ensureCacheDir();
  const tarballName = `node-v${nodeVersion}-darwin-${arch}.tar.gz`;
  const tarballPath = path.join(CACHE_DIR, tarballName);
  const extractedDir = path.join(CACHE_DIR, `node-v${nodeVersion}-darwin-${arch}`);
  const nodeBinCached = path.join(extractedDir, 'bin', 'node');

  if (fs.existsSync(nodeBinCached)) {
    log(`Using cached node binary (${nodeVersion}, darwin-${arch})`);
    return nodeBinCached;
  }

  if (!fs.existsSync(tarballPath)) {
    const url = `https://nodejs.org/dist/v${nodeVersion}/${tarballName}`;
    log(`Downloading pinned Node from ${url}`);
    await download(url, tarballPath);
  }

  log(`Extracting ${tarballName}`);
  execSync(`tar -xzf "${tarballPath}" -C "${CACHE_DIR}"`, { stdio: 'inherit' });

  if (!fs.existsSync(nodeBinCached)) {
    throw new Error(`Expected node binary not found after extract: ${nodeBinCached}`);
  }
  return nodeBinCached;
}

function writeStartCommand() {
  // start.command:
  //   - Double-clickable in Finder (opens Terminal).
  //   - Sets BATONBOT_CONFIG_DIR to the sibling config/ folder.
  //   - Launches bundled node against app/batonbot.js in the background.
  //   - Waits for /health, then `open`s the browser.
  //   - `wait`s so Ctrl+C in Terminal cleanly stops the server.
  //
  // First launch on macOS: Gatekeeper will block unsigned .command files.
  // README.txt documents the right-click -> Open workaround.
  const content = `#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
export BATONBOT_CONFIG_DIR="$DIR/config"
export PORT="\${PORT:-4321}"

mkdir -p "$BATONBOT_CONFIG_DIR"

clear
echo ""
echo "  BatonBot Portable"
echo "  ================="
echo "  Config dir: $BATONBOT_CONFIG_DIR"
echo "  Server:     http://localhost:$PORT"
echo ""
echo "Starting server (keep this Terminal window open while BatonBot is running)..."
echo ""

# Launch the server in the background so we can poll /health and open the browser.
"$DIR/bin/node" "$DIR/app/batonbot.js" &
SERVER_PID=$!

# Kill the server if this Terminal window is closed or Ctrl+C is pressed.
trap 'echo ""; echo "Stopping BatonBot..."; kill $SERVER_PID 2>/dev/null || true; exit 0' INT TERM EXIT

# Poll /health for up to 15s, then open the browser.
OK=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
    OK=1
    break
  fi
  sleep 0.5
done

if [ "$OK" = "1" ]; then
  open "http://localhost:$PORT"
else
  echo "Server did not respond on /health within 15s. Check log output above."
fi

echo ""
echo "Press Ctrl+C to stop BatonBot."
wait $SERVER_PID
`;
  const dest = path.join(BUNDLE_DIR, 'start.command');
  fs.writeFileSync(dest, content);
  fs.chmodSync(dest, 0o755);
}

function writeReadme() {
  const content = `BatonBot Portable (macOS ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'})
============================================================

Quick start
-----------
  1. Double-click start.command
  2. Wait for your browser to open http://localhost:4321
  3. To stop: press Ctrl+C in the Terminal window (or just close it).

First-launch note (IMPORTANT)
-----------------------------
  macOS Gatekeeper will block start.command the very first time you
  double-click it, with a message like:

    "start.command" cannot be opened because it is from
     an unidentified developer.

  Workaround (one time only):
    1. Right-click (or Control-click) start.command
    2. Choose "Open"
    3. In the dialog that appears, click "Open" again
  macOS remembers your choice; from then on plain double-click works.

  Alternative (Terminal, one time only):
    xattr -dr com.apple.quarantine "$(pwd)"

  This bundle is not code-signed yet. Signing is planned for a future release.

Where is my data?
-----------------
  All projects, settings, and session logs live in the \`config/\` folder
  next to this README. To uninstall, just delete this entire folder.

Optional: change the port
-------------------------
  Create config/.env with one line:    PORT=5000
  Then re-run start.command.

Troubleshooting
---------------
  - "start.command cannot be opened..." (Gatekeeper):
    See the first-launch note above.
  - Browser does not open:
    Open http://localhost:4321 manually.
  - Port already in use:
    Set PORT in config/.env (see above) and restart.
`;
  fs.writeFileSync(path.join(BUNDLE_DIR, 'README.txt'), content);
}

async function main() {
  log(`Build target: ${BUNDLE_DIR}`);
  rmrf(BUNDLE_DIR);
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  log('Copying app files...');
  copyAppFiles(APP_DIR, log);

  stagedNpmInstall(APP_DIR, log);

  log('Fetching pinned Node binary...');
  const nodeBinSrc = await fetchPinnedNode();
  const nodeBinDst = path.join(BIN_DIR, 'node');
  fs.copyFileSync(nodeBinSrc, nodeBinDst);
  fs.chmodSync(nodeBinDst, 0o755);

  log('Writing start.command and README.txt...');
  writeStartCommand();
  writeReadme();

  log('Bundle staged successfully.');

  if (!SKIP_ZIP) {
    try {
      const zipPath = path.join(DIST_ROOT, `${BUNDLE_NAME}.zip`);
      rmrf(zipPath);
      // Use `ditto` on macOS so extended attributes / permissions survive.
      // Falls back to `zip` if ditto is unavailable (non-macOS build hosts).
      const hasDitto = process.platform === 'darwin';
      if (hasDitto) {
        execSync(`ditto -c -k --sequesterRsrc --keepParent "${BUNDLE_DIR}" "${zipPath}"`, { stdio: 'inherit' });
      } else {
        execSync(`cd "${DIST_ROOT}" && zip -rq "${BUNDLE_NAME}.zip" "${BUNDLE_NAME}"`, { stdio: 'inherit', shell: '/bin/bash' });
      }
      log(`Zip created: ${zipPath}`);
    } catch (err) {
      log(`Zip step failed (bundle dir is still usable): ${err.message}`);
    }
  }

  log('Done.');
  log(`Bundle: ${BUNDLE_DIR}`);
}

main().catch((err) => {
  console.error('[build-mac] FAILED:', err);
  process.exit(1);
});

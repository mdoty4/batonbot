#!/usr/bin/env node
/*
 * Build a portable Windows x64 bundle of BatonBot.
 *
 * Output: dist/batonbot-portable-win-x64/  (and a .zip alongside if `zip` is on PATH)
 *
 * Layout:
 *   batonbot-portable-win-x64/
 *     ├── node.exe                 (pinned Node 20 LTS Windows x64)
 *     ├── app/                     (batonbot.js, modules/, index.html, etc.)
 *     │   └── node_modules/        (prod-only, installed against pinned Node)
 *     ├── config/                  (empty — first-run will seed prompts.json)
 *     ├── start.cmd                (sets BATONBOT_CONFIG_DIR, launches node, opens browser)
 *     └── README.txt               (end-user instructions)
 *
 * Usage:
 *   node scripts/build-portable/build-win.js [--node-version 20.18.1] [--skip-zip]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const NODE_VERSION_DEFAULT = '20.18.1';
const args = process.argv.slice(2);
const nodeVersion = (() => {
  const i = args.indexOf('--node-version');
  return i >= 0 ? args[i + 1] : NODE_VERSION_DEFAULT;
})();
const SKIP_ZIP = args.includes('--skip-zip');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
const BUNDLE_NAME = 'batonbot-portable-win-x64';
const BUNDLE_DIR = path.join(DIST_ROOT, BUNDLE_NAME);
const APP_DIR = path.join(BUNDLE_DIR, 'app');
const CONFIG_DIR = path.join(BUNDLE_DIR, 'config');
const CACHE_DIR = path.join(REPO_ROOT, '.build-cache');

const APP_FILES = [
  'batonbot.js',
  'index.html',
  'styles.css',
  'board.css',
  'prompts.json.example',
  'skill.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
];
const APP_DIRS = ['modules'];

function log(msg) { console.log(`[build-win] ${msg}`); }

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.unlinkSync(destPath);
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => { file.close(); fs.unlinkSync(destPath); reject(err); });
  });
}

async function fetchPinnedNodeExe() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, `node-v${nodeVersion}-win-x64.exe`);
  if (fs.existsSync(cached)) {
    log(`Using cached node.exe (${nodeVersion})`);
    return cached;
  }
  const url = `https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`;
  log(`Downloading pinned node.exe from ${url}`);
  await download(url, cached);
  log(`Cached at ${cached}`);
  return cached;
}

function stagedNpmInstall() {
  log('Installing prod-only node_modules into staged app/');
  // Copy package*.json into APP_DIR first, then run npm ci --omit=dev there.
  for (const f of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(APP_DIR, f));
  }
  const result = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`npm ci failed with exit code ${result.status}`);
  }
}

function writeStartCmd() {
  // start.cmd:
  //   - Sets BATONBOT_CONFIG_DIR to the sibling config/ folder.
  //   - Launches bundled node.exe against app\batonbot.js.
  //   - Waits for the server to bind, then opens the default browser.
  //   - Keeps a console window open so the user can see logs / Ctrl+C to stop.
  const content = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'set "BATONBOT_CONFIG_DIR=%~dp0config"',
    'set "PORT=4321"',
    'if not exist "%BATONBOT_CONFIG_DIR%" mkdir "%BATONBOT_CONFIG_DIR%"',
    'echo.',
    'echo  BatonBot Portable',
    'echo  =================',
    'echo  Config dir: %BATONBOT_CONFIG_DIR%',
    'echo  Server:     http://localhost:%PORT%',
    'echo.',
    'echo Starting server (this window must stay open while BatonBot is running)...',
    'echo.',
    'start "" /B "%~dp0node.exe" "%~dp0app\\batonbot.js"',
    'rem Give the server a moment to bind, then open the browser.',
    'powershell -NoProfile -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri http://localhost:%PORT%/health -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if ($ok) { Start-Process \'http://localhost:%PORT%\' } else { Write-Host \'Server did not respond on /health within 15s. Check the log window.\' }"',
    'echo.',
    'echo Press Ctrl+C in this window to stop BatonBot.',
    'pause >nul',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(BUNDLE_DIR, 'start.cmd'), content);
}

function writeReadme() {
  const content = [
    'BatonBot Portable (Windows x64)',
    '================================',
    '',
    'Quick start',
    '-----------',
    '  1. Double-click start.cmd',
    '  2. Wait for your browser to open http://localhost:4321',
    '  3. To stop: close the console window (or press Ctrl+C in it).',
    '',
    'Where is my data?',
    '-----------------',
    '  All projects, settings, and session logs live in the `config\\` folder',
    '  next to this README. To uninstall, just delete this entire folder.',
    '',
    'Optional: change the port',
    '-------------------------',
    '  Create config\\.env with one line:    PORT=5000',
    '  Then re-run start.cmd.',
    '',
    'Troubleshooting',
    '---------------',
    '  - SmartScreen popup ("Windows protected your PC"):',
    '    Click "More info" -> "Run anyway". The bundled node.exe and start.cmd',
    '    are unsigned. This is expected for v3.2.',
    '  - Antivirus quarantines node.exe:',
    '    Add this folder to your AV exclusions.',
    '  - Browser does not open:',
    '    Open http://localhost:4321 manually.',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(BUNDLE_DIR, 'README.txt'), content);
}

async function main() {
  log(`Build target: ${BUNDLE_DIR}`);
  rmrf(BUNDLE_DIR);
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  log('Copying app files...');
  for (const f of APP_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP_DIR, f));
    else log(`  (skipping missing file: ${f})`);
  }
  for (const d of APP_DIRS) {
    const src = path.join(REPO_ROOT, d);
    if (fs.existsSync(src)) copyDirSync(src, path.join(APP_DIR, d));
  }

  stagedNpmInstall();

  log('Fetching pinned node.exe...');
  const nodeExeSrc = await fetchPinnedNodeExe();
  fs.copyFileSync(nodeExeSrc, path.join(BUNDLE_DIR, 'node.exe'));

  log('Writing start.cmd and README.txt...');
  writeStartCmd();
  writeReadme();

  log('Bundle staged successfully.');

  if (!SKIP_ZIP) {
    try {
      const zipPath = path.join(DIST_ROOT, `${BUNDLE_NAME}.zip`);
      rmrf(zipPath);
      // Use system `zip` (macOS/Linux). On Windows use PowerShell Compress-Archive.
      if (process.platform === 'win32') {
        execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${BUNDLE_DIR}\\*' -DestinationPath '${zipPath}'"`, { stdio: 'inherit' });
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
  console.error('[build-win] FAILED:', err);
  process.exit(1);
});

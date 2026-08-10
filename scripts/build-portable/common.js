/*
 * Shared helpers for portable-bundle builders (Windows / macOS / Linux).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');
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

function makeLog(tag) {
  return (msg) => console.log(`[${tag}] ${msg}`);
}

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
    req.on('error', (err) => { file.close(); try { fs.unlinkSync(destPath); } catch {} reject(err); });
  });
}

function copyAppFiles(appDir, log) {
  for (const f of APP_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
    else log(`  (skipping missing file: ${f})`);
  }
  for (const d of APP_DIRS) {
    const src = path.join(REPO_ROOT, d);
    if (fs.existsSync(src)) copyDirSync(src, path.join(appDir, d));
  }
}

function stagedNpmInstall(appDir, log) {
  log('Installing prod-only node_modules into staged app/');
  for (const f of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(appDir, f));
  }
  const result = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`npm ci failed with exit code ${result.status}`);
  }
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

module.exports = {
  REPO_ROOT,
  DIST_ROOT,
  CACHE_DIR,
  APP_FILES,
  APP_DIRS,
  makeLog,
  rmrf,
  copyDirSync,
  download,
  copyAppFiles,
  stagedNpmInstall,
  ensureCacheDir,
};

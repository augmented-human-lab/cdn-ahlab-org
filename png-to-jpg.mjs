#!/usr/bin/env node
/**
 * png-to-jpg.mjs
 *
 * Recursively scans a directory for .png files and converts each one to
 * a .jpg sibling using the macOS built-in `sips` command. After a
 * successful conversion (output file exists, non-zero size), the original
 * .png is deleted.
 *
 * USAGE:
 *   node tools/png-to-jpg.mjs                              # dry-run, default roots
 *   node tools/png-to-jpg.mjs --apply                      # actually convert + delete
 *   node tools/png-to-jpg.mjs --apply --root path/to/dir   # custom root
 *   node tools/png-to-jpg.mjs --apply --quality 90         # custom JPG quality
 *
 * DEFAULT ROOTS (relative to CWD, both scanned if they exist):
 *   ./media/site/people
 *   ./media/site/projects
 *
 * BEHAVIOR:
 *   - Dry-run by default. Pass --apply to make changes.
 *   - Recursive: descends into every subdirectory.
 *   - Skips .png if a same-name .jpg already exists (warns).
 *   - Skips .DS_Store and any hidden file/folder.
 *   - Verifies the .jpg exists and is non-zero before deleting the .png.
 *   - Idempotent: re-running after success finds 0 PNGs.
 *
 * REQUIREMENTS:
 *   - macOS (uses `sips`, which is built in)
 *   - That's it. Zero npm dependencies.
 *
 * EXAMPLE:
 *   media/site/people/yize-wei/yize-wei.png
 *     → media/site/people/yize-wei/yize-wei.jpg  (created)
 *     → media/site/people/yize-wei/yize-wei.png  (deleted)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// -------- config --------
const DEFAULT_ROOTS = ['./media/site/people', './media/site/projects'];
const DEFAULT_QUALITY = 92; // sips JPG quality, 0-100. 92 is a sensible default for photos.

// -------- cli --------
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node png-to-jpg.mjs [--apply] [options]

Options:
  --apply              Actually convert and delete originals.
                       Without this, runs in dry-run mode.
  --root <dir>         Root directory to scan. Pass multiple --root flags
                       to scan several. Default: media/site/people and
                       media/site/projects (whichever exist).
  --quality <0-100>    JPG quality for sips. Default: ${DEFAULT_QUALITY}.

Examples:
  node tools/png-to-jpg.mjs                          # dry-run
  node tools/png-to-jpg.mjs --apply                  # convert + delete
  node tools/png-to-jpg.mjs --apply --root cdn-staging/media
`);
  process.exit(0);
}

const APPLY = args.includes('--apply');

// Collect all --root flags
const customRoots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') {
    if (!args[i + 1]) { console.error('--root needs a path argument'); process.exit(1); }
    customRoots.push(args[i + 1]);
    i++;
  }
}

let QUALITY = DEFAULT_QUALITY;
const qIdx = args.indexOf('--quality');
if (qIdx >= 0) {
  const q = parseInt(args[qIdx + 1], 10);
  if (Number.isNaN(q) || q < 0 || q > 100) {
    console.error('--quality must be an integer 0-100');
    process.exit(1);
  }
  QUALITY = q;
}

// Reject unknown flags
const KNOWN_FLAGS = new Set(['--apply', '--root', '--quality', '-h', '--help']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root' || a === '--quality') { i++; continue; }
  if (!KNOWN_FLAGS.has(a)) {
    console.error(`Unknown flag: ${a}`);
    console.error('Try: node tools/png-to-jpg.mjs --help');
    process.exit(1);
  }
}

// -------- helpers --------

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function nonZeroFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

/**
 * Recursively walk a directory and yield every regular file path.
 * Skips hidden files and folders (anything starting with a dot).
 */
async function* walkFiles(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // .DS_Store, .git, etc.
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Pre-flight: confirm `sips` is on PATH. Exits the script if not.
 */
function checkSips() {
  const result = spawnSync('sips', ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.error('❌ sips not found. This script requires macOS.');
    console.error('   On Linux/Windows, use the sharp or ImageMagick variant.');
    process.exit(1);
  }
}

/**
 * Run sips to convert a single PNG to JPG. Returns { ok, error }.
 * Does NOT delete the source.
 */
function sipsConvert(pngPath, jpgPath, quality) {
  const result = spawnSync('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(quality),
    pngPath,
    '--out', jpgPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });

  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `sips exited ${result.status}` };
  }
  return { ok: true };
}

function formatBytes(b) {
  if (b == null) return '?';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
}

// -------- main --------
async function main() {
  console.log(`${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} — png-to-jpg`);

  checkSips();

  // Resolve roots
  const requestedRoots = customRoots.length ? customRoots : DEFAULT_ROOTS;
  const roots = [];
  for (const r of requestedRoots) {
    const abs = path.resolve(r);
    if (await exists(abs)) {
      roots.push(abs);
    } else {
      console.log(`  (skipping missing root: ${path.relative(process.cwd(), abs)})`);
    }
  }
  if (roots.length === 0) {
    console.error('❌ No valid root directories found.');
    console.error('   Default roots: ' + DEFAULT_ROOTS.join(', '));
    console.error('   Pass --root to specify your own.');
    process.exit(1);
  }
  for (const r of roots) {
    console.log(`  scanning: ${path.relative(process.cwd(), r) || '.'}`);
  }
  console.log(`  quality:  ${QUALITY}`);
  console.log('');

  // ── Discover PNG files ─────────────────────────────────────
  const candidates = []; // { png, jpg, sourceBytes }
  for (const root of roots) {
    for await (const fp of walkFiles(root)) {
      if (path.extname(fp).toLowerCase() !== '.png') continue;
      const jpg = fp.slice(0, -4) + '.jpg';
      let sourceBytes = 0;
      try { sourceBytes = (await fs.stat(fp)).size; } catch {}
      candidates.push({ png: fp, jpg, sourceBytes });
    }
  }

  console.log(`Discovered ${candidates.length} .png files`);
  console.log('');

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // ── Plan + execute ─────────────────────────────────────────
  let converted = 0;
  let skippedCollision = 0;
  let failed = 0;
  const errors = [];

  for (const c of candidates) {
    const rel = path.relative(process.cwd(), c.png);
    const relOut = path.relative(process.cwd(), c.jpg);

    // Collision check: never overwrite an existing JPG
    if (await exists(c.jpg)) {
      console.log(`  ⚠  ${rel} — .jpg sibling already exists, skipping`);
      skippedCollision++;
      continue;
    }

    if (!APPLY) {
      console.log(`  → ${rel}  (${formatBytes(c.sourceBytes)})`);
      continue;
    }

    // Apply: convert
    const result = sipsConvert(c.png, c.jpg, QUALITY);
    if (!result.ok) {
      console.log(`  ✗ ${rel} — ${result.error}`);
      failed++;
      errors.push({ file: rel, error: result.error });
      continue;
    }

    // Verify the output is real before deleting the source
    if (!(await nonZeroFile(c.jpg))) {
      console.log(`  ✗ ${rel} — sips reported success but ${relOut} is missing or empty`);
      failed++;
      errors.push({ file: rel, error: 'output file missing or empty after sips' });
      continue;
    }

    // Delete the source
    try {
      await fs.unlink(c.png);
    } catch (e) {
      console.log(`  ✗ ${rel} — converted but couldn't delete source: ${e.message}`);
      failed++;
      errors.push({ file: rel, error: `delete failed: ${e.message}` });
      continue;
    }

    let outBytes = 0;
    try { outBytes = (await fs.stat(c.jpg)).size; } catch {}
    console.log(`  ✓ ${rel}  →  ${path.basename(c.jpg)}  (${formatBytes(c.sourceBytes)} → ${formatBytes(outBytes)})`);
    converted++;
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('');
  console.log('— summary —');
  console.log(`  PNGs found:        ${candidates.length}`);
  if (APPLY) {
    console.log(`  converted:         ${converted}`);
    console.log(`  skipped (collision): ${skippedCollision}`);
    console.log(`  failed:            ${failed}`);
  } else {
    console.log(`  would convert:     ${candidates.length - skippedCollision}`);
    console.log(`  skipped (collision): ${skippedCollision}`);
  }
  console.log('');

  if (errors.length > 0) {
    console.log('⚠  Errors:');
    for (const e of errors.slice(0, 10)) {
      console.log(`    ${e.file}: ${e.error}`);
    }
    if (errors.length > 10) console.log(`    … and ${errors.length - 10} more`);
    console.log('');
  }

  if (!APPLY) {
    console.log('🔍 DRY RUN — nothing changed. Re-run with --apply to convert.');
    console.log('');
  } else if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

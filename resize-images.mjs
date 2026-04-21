#!/usr/bin/env node
/**
 * resize-images.mjs
 *
 * Recursively scans a directory for raster images and downsizes any whose
 * long edge exceeds a target size. Uses the macOS built-in `sips` command
 * (same approach as png-to-jpg.mjs — zero npm deps).
 *
 * USAGE:
 *   node resize-images.mjs --profile people                 # dry-run
 *   node resize-images.mjs --profile people   --apply
 *   node resize-images.mjs --profile projects --apply
 *   node resize-images.mjs --profile paradigm --apply
 *   node resize-images.mjs --max 1400 --root media/site --no-recurse \
 *     --include 'Fig4.jpg' --apply                          # one-off
 *
 * PROFILES (max long-edge + default scan roots):
 *   people     900 px  ./media/site/people       recursive
 *   projects  1600 px  ./media/site/projects     recursive
 *   paradigm   800 px  ./media/site              non-recursive, only
 *                                                compatible_user.png +
 *                                                augmented_user.png
 *
 * BEHAVIOR:
 *   - Dry-run by default. Pass --apply to make changes.
 *   - Recursive by default. Pass --no-recurse to scan only the root.
 *   - Only touches files whose LONG edge is strictly greater than --max.
 *     Images already within budget are skipped.
 *   - Preserves aspect ratio (`sips -Z <max>` resizes to fit).
 *   - Keeps the original extension/format (JPG stays JPG, PNG stays PNG).
 *   - Writes to a temp `.resize.tmp` sibling, verifies it exists and is
 *     non-zero, then atomically replaces the original. On failure, the
 *     original is untouched.
 *   - Skips .DS_Store and hidden paths.
 *   - JPEG quality controlled by --quality (default 85). Lossless PNG is
 *     just a resize — quality flag is ignored for PNGs.
 *
 * FILTERS:
 *   --include <glob>   Only process files whose basename matches (simple
 *                      * glob). Repeatable.
 *   --exclude <glob>   Skip files whose basename matches. Repeatable.
 *
 * REQUIREMENTS:
 *   - macOS (uses `sips`, which is built in).
 *   - Node.js. Zero npm dependencies.
 *
 * EXAMPLE:
 *   # Dry-run the people resize to see what would change
 *   node resize-images.mjs --profile people
 *
 *   # Apply the people + projects resize (two runs)
 *   node resize-images.mjs --profile people   --apply
 *   node resize-images.mjs --profile projects --apply
 *
 *   # One-off: shrink just compatible_user.png + augmented_user.png
 *   node resize-images.mjs --max 800 --root media/site --no-recurse \
 *     --include 'compatible_user.png' --include 'augmented_user.png' --apply
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// -------- config --------
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const DEFAULT_QUALITY = 85;

// A profile may carry baked-in include globs (applied in addition to any
// --include passed on the CLI). Used by `paradigm` to target exactly the
// two vision-page illustrations (compatible_user.png, augmented_user.png)
// without also clobbering Fig4.jpg, hero backgrounds, or logos which all
// have different size budgets.
const PROFILES = {
  people:   { max:  900, roots: ['./media/site/people'],    recurse: true  },
  projects: { max: 1600, roots: ['./media/site/projects'],  recurse: true  },
  paradigm: {
    max: 800,
    roots: ['./media/site'],
    recurse: false,
    includes: ['compatible_user.png', 'augmented_user.png'],
  },
};

// -------- cli --------
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node resize-images.mjs [options]

Options:
  --apply              Actually resize files. Without this, runs in dry-run mode.
  --profile <name>     Use a built-in preset. One of: ${Object.keys(PROFILES).join(', ')}.
  --max <px>           Long-edge max in pixels. Overrides the profile's max.
  --root <dir>         Root to scan. Repeatable. Overrides profile roots.
  --no-recurse         Scan only the root, don't descend into subdirectories.
  --quality <0-100>    JPEG quality for sips. Default: ${DEFAULT_QUALITY}. (Ignored for PNGs.)
  --include <glob>     Only process files whose basename matches. Repeatable.
  --exclude <glob>     Skip files whose basename matches. Repeatable.

Profiles:
  people     max ${PROFILES.people.max}px   on ${PROFILES.people.roots.join(', ')}
  projects   max ${PROFILES.projects.max}px  on ${PROFILES.projects.roots.join(', ')}
  paradigm   max ${PROFILES.paradigm.max}px   on ${PROFILES.paradigm.roots.join(', ')} (only ${PROFILES.paradigm.includes.join(' + ')})

Examples:
  node resize-images.mjs --profile people                # dry-run
  node resize-images.mjs --profile people --apply        # apply
  node resize-images.mjs --max 1200 --root cdn-staging/media --apply
`);
  process.exit(0);
}

const APPLY = args.includes('--apply');
const NO_RECURSE = args.includes('--no-recurse');

function takeValueFlag(flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  if (!args[idx + 1]) { console.error(`${flag} needs a value`); process.exit(1); }
  return args[idx + 1];
}

function takeMultiFlag(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      if (!args[i + 1]) { console.error(`${flag} needs a value`); process.exit(1); }
      out.push(args[i + 1]);
      i++;
    }
  }
  return out;
}

const profileName = takeValueFlag('--profile');
if (profileName && !PROFILES[profileName]) {
  console.error(`Unknown profile: ${profileName}`);
  console.error(`Valid profiles: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
const profile = profileName ? PROFILES[profileName] : null;

const maxRaw = takeValueFlag('--max');
let MAX = maxRaw != null ? parseInt(maxRaw, 10) : (profile?.max ?? null);
if (MAX == null || Number.isNaN(MAX) || MAX < 16) {
  console.error('Must specify --max <px> or --profile <name>.');
  console.error('Try: node resize-images.mjs --help');
  process.exit(1);
}

const qualityRaw = takeValueFlag('--quality');
let QUALITY = DEFAULT_QUALITY;
if (qualityRaw != null) {
  const q = parseInt(qualityRaw, 10);
  if (Number.isNaN(q) || q < 0 || q > 100) {
    console.error('--quality must be an integer 0-100');
    process.exit(1);
  }
  QUALITY = q;
}

const customRoots = takeMultiFlag('--root');
const cliIncludes = takeMultiFlag('--include');
const excludes = takeMultiFlag('--exclude');

// CLI --include entries add to the profile's baked-in includes (if any).
// If the profile has no includes and the CLI has none, includes=[] means
// "no include filter" (match everything).
const includes = [...(profile?.includes ?? []), ...cliIncludes];

// Reject unknown flags
const KNOWN_FLAGS = new Set([
  '--apply', '--profile', '--max', '--root', '--no-recurse',
  '--quality', '--include', '--exclude', '-h', '--help',
]);
const VALUE_FLAGS = new Set(['--profile', '--max', '--root', '--quality', '--include', '--exclude']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; }
  if (!KNOWN_FLAGS.has(a)) {
    console.error(`Unknown flag: ${a}`);
    console.error('Try: node resize-images.mjs --help');
    process.exit(1);
  }
}

const RECURSE = profile ? (!NO_RECURSE && profile.recurse !== false) : !NO_RECURSE;

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
 * Walk directory. If recurse=false, only yields files directly in dir.
 * Skips hidden files and folders.
 */
async function* walkFiles(dir, recurse) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) yield* walkFiles(full, true);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Simple glob-to-regex for basename matching. Supports `*` only. */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}
const includeRes = includes.map(globToRegex);
const excludeRes = excludes.map(globToRegex);
function basenameAllowed(fp) {
  const base = path.basename(fp);
  if (includeRes.length && !includeRes.some(r => r.test(base))) return false;
  if (excludeRes.some(r => r.test(base))) return false;
  return true;
}

function checkSips() {
  const r = spawnSync('sips', ['--version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    console.error('sips not found. This script requires macOS.');
    process.exit(1);
  }
}

/** Read pixel dimensions via sips. Returns { w, h } or null on failure. */
function sipsDimensions(fp) {
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', fp], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  const w = parseInt((r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1], 10);
  const h = parseInt((r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

/**
 * Resize srcPath so the long edge is at most `max` px. Writes to outPath.
 * JPEG quality applies to JPEGs only. PNGs stay lossless.
 * Returns { ok, error }.
 */
function sipsResize(srcPath, outPath, max, isJpeg, quality) {
  const argv = [
    '-Z', String(max),
    srcPath,
    '--out', outPath,
  ];
  if (isJpeg) {
    argv.unshift('-s', 'formatOptions', String(quality));
    argv.unshift('-s', 'format', 'jpeg');
  }
  const r = spawnSync('sips', argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || `sips exited ${r.status}` };
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
  console.log(`${APPLY ? 'APPLY MODE' : 'DRY RUN'} — resize-images`);
  console.log(`  max long edge: ${MAX}px`);
  console.log(`  quality (JPEG): ${QUALITY}`);
  console.log(`  recurse: ${RECURSE}`);

  checkSips();

  // Resolve roots: explicit --root wins, else profile, else error.
  const requestedRoots = customRoots.length
    ? customRoots
    : (profile ? profile.roots : null);
  if (!requestedRoots) {
    console.error('No roots specified. Pass --profile or --root.');
    process.exit(1);
  }
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
    console.error('No valid roots found.');
    process.exit(1);
  }
  for (const r of roots) {
    console.log(`  scanning: ${path.relative(process.cwd(), r) || '.'}`);
  }
  if (includes.length) console.log(`  include: ${includes.join(', ')}`);
  if (excludes.length) console.log(`  exclude: ${excludes.join(', ')}`);
  console.log('');

  // ── Discover candidates ────────────────────────────────────
  const candidates = []; // { fp, w, h, bytes, longEdge }
  let scanned = 0;
  let alreadySmallEnough = 0;

  for (const root of roots) {
    for await (const fp of walkFiles(root, RECURSE)) {
      const ext = path.extname(fp).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      if (!basenameAllowed(fp)) continue;
      scanned++;

      const dim = sipsDimensions(fp);
      if (!dim) {
        console.log(`  ? ${path.relative(process.cwd(), fp)} — could not read dimensions, skipping`);
        continue;
      }
      const longEdge = Math.max(dim.w, dim.h);
      if (longEdge <= MAX) { alreadySmallEnough++; continue; }

      let bytes = 0;
      try { bytes = (await fs.stat(fp)).size; } catch {}
      candidates.push({ fp, w: dim.w, h: dim.h, bytes, longEdge });
    }
  }

  console.log(`Scanned ${scanned} image(s); ${alreadySmallEnough} already within ${MAX}px; ${candidates.length} oversized.`);
  console.log('');

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Sort biggest first — most satisfying to watch, and also surfaces
  // any failures on the largest (most expensive) files early.
  candidates.sort((a, b) => b.bytes - a.bytes);

  // ── Plan + execute ─────────────────────────────────────────
  let resized = 0;
  let failed = 0;
  let sourceBytesTotal = 0;
  let outBytesTotal = 0;
  const errors = [];

  for (const c of candidates) {
    const rel = path.relative(process.cwd(), c.fp);
    const ext = path.extname(c.fp).toLowerCase();
    const isJpeg = ext === '.jpg' || ext === '.jpeg';

    if (!APPLY) {
      console.log(`  → ${rel}  ${c.w}×${c.h} (${formatBytes(c.bytes)})`);
      sourceBytesTotal += c.bytes;
      continue;
    }

    const tmpPath = c.fp + '.resize.tmp';

    // Make sure no stale tmp from a previous crashed run is in the way.
    if (await exists(tmpPath)) {
      try { await fs.unlink(tmpPath); } catch {}
    }

    const result = sipsResize(c.fp, tmpPath, MAX, isJpeg, QUALITY);
    if (!result.ok) {
      console.log(`  ✗ ${rel} — ${result.error}`);
      failed++;
      errors.push({ file: rel, error: result.error });
      continue;
    }
    if (!(await nonZeroFile(tmpPath))) {
      console.log(`  ✗ ${rel} — sips reported success but tmp is missing/empty`);
      try { await fs.unlink(tmpPath); } catch {}
      failed++;
      errors.push({ file: rel, error: 'tmp file missing or empty after sips' });
      continue;
    }

    // Atomic replace. fs.rename is atomic on same filesystem (POSIX).
    try {
      await fs.rename(tmpPath, c.fp);
    } catch (e) {
      console.log(`  ✗ ${rel} — rename failed: ${e.message}`);
      try { await fs.unlink(tmpPath); } catch {}
      failed++;
      errors.push({ file: rel, error: `rename failed: ${e.message}` });
      continue;
    }

    let outBytes = 0;
    try { outBytes = (await fs.stat(c.fp)).size; } catch {}
    const outDim = sipsDimensions(c.fp) || { w: '?', h: '?' };
    console.log(`  ✓ ${rel}  ${c.w}×${c.h} → ${outDim.w}×${outDim.h}  (${formatBytes(c.bytes)} → ${formatBytes(outBytes)})`);
    sourceBytesTotal += c.bytes;
    outBytesTotal    += outBytes;
    resized++;
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('');
  console.log('— summary —');
  console.log(`  scanned:     ${scanned}`);
  console.log(`  already ok:  ${alreadySmallEnough}`);
  console.log(`  candidates:  ${candidates.length}`);
  if (APPLY) {
    console.log(`  resized:     ${resized}`);
    console.log(`  failed:      ${failed}`);
    console.log(`  bytes:       ${formatBytes(sourceBytesTotal)} → ${formatBytes(outBytesTotal)}  (saved ${formatBytes(sourceBytesTotal - outBytesTotal)})`);
  } else {
    console.log(`  would resize: ${candidates.length}`);
    console.log(`  source bytes (before): ${formatBytes(sourceBytesTotal)}`);
  }
  console.log('');

  if (errors.length > 0) {
    console.log('Errors:');
    for (const e of errors.slice(0, 10)) console.log(`    ${e.file}: ${e.error}`);
    if (errors.length > 10) console.log(`    … and ${errors.length - 10} more`);
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY RUN — nothing changed. Re-run with --apply to resize.');
  } else if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

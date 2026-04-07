#!/usr/bin/env node
/**
 * jpeg-to-jpg.mjs
 *
 * Recursively scans a directory for .jpeg files and renames each one to
 * .jpg. JPEG and JPG are the same image format — only the extension
 * differs — so this is a pure filesystem rename, no conversion needed.
 *
 * USAGE:
 *   node tools/jpeg-to-jpg.mjs                              # dry-run, default roots
 *   node tools/jpeg-to-jpg.mjs --apply                      # actually rename
 *   node tools/jpeg-to-jpg.mjs --apply --root path/to/dir   # custom root
 *
 * DEFAULT ROOTS (relative to CWD, both scanned if they exist):
 *   ./media/site/people
 *   ./media/site/projects
 *
 * BEHAVIOR:
 *   - Dry-run by default. Pass --apply to make changes.
 *   - Recursive: descends into every subdirectory.
 *   - Skips .DS_Store and any hidden file/folder.
 *   - On collision (same-name .jpg already exists), OVERWRITES the .jpg
 *     with the .jpeg. The .jpeg is then gone. This was an explicit
 *     decision; png-to-jpg.mjs has different collision behavior (skip).
 *   - Verifies the rename succeeded before treating it as done.
 *   - Idempotent: re-running after success finds 0 .jpeg files.
 *
 * REQUIREMENTS:
 *   - Node.js
 *   - That's it. Zero npm dependencies, no external commands.
 *
 * EXAMPLE:
 *   media/site/people/andrew-reis/andrew-reis.jpeg
 *     → media/site/people/andrew-reis/andrew-reis.jpg
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// -------- config --------
const DEFAULT_ROOTS = ['./media/site/people', './media/site/projects'];

// -------- cli --------
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node jpeg-to-jpg.mjs [--apply] [options]

Options:
  --apply         Actually rename files. Without this, runs in dry-run mode.
  --root <dir>    Root directory to scan. Pass multiple --root flags
                  to scan several. Default: media/site/people and
                  media/site/projects (whichever exist).

Examples:
  node tools/jpeg-to-jpg.mjs                          # dry-run
  node tools/jpeg-to-jpg.mjs --apply                  # rename
  node tools/jpeg-to-jpg.mjs --apply --root cdn-staging/media

Collision behavior:
  If foo.jpeg exists alongside foo.jpg, the .jpg is OVERWRITTEN with
  the .jpeg's contents. This is irreversible.
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

// Reject unknown flags
const KNOWN_FLAGS = new Set(['--apply', '--root', '-h', '--help']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') { i++; continue; }
  if (!KNOWN_FLAGS.has(a)) {
    console.error(`Unknown flag: ${a}`);
    console.error('Try: node tools/jpeg-to-jpg.mjs --help');
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

function formatBytes(b) {
  if (b == null) return '?';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
}

// -------- main --------
async function main() {
  console.log(`${APPLY ? '🔧 APPLY MODE' : '🔍 DRY RUN'} — jpeg-to-jpg`);

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
  console.log('');

  // ── Discover .jpeg files ───────────────────────────────────
  const candidates = []; // { jpeg, jpg, sourceBytes }
  for (const root of roots) {
    for await (const fp of walkFiles(root)) {
      if (path.extname(fp).toLowerCase() !== '.jpeg') continue;
      const jpg = fp.slice(0, -5) + '.jpg';
      let sourceBytes = 0;
      try { sourceBytes = (await fs.stat(fp)).size; } catch {}
      candidates.push({ jpeg: fp, jpg, sourceBytes });
    }
  }

  console.log(`Discovered ${candidates.length} .jpeg files`);
  console.log('');

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // ── Plan + execute ─────────────────────────────────────────
  let renamed = 0;
  let overwritten = 0;
  let failed = 0;
  const errors = [];

  for (const c of candidates) {
    const rel    = path.relative(process.cwd(), c.jpeg);
    const relOut = path.relative(process.cwd(), c.jpg);
    const collision = await exists(c.jpg);

    if (!APPLY) {
      if (collision) {
        console.log(`  ⚠  ${rel}  →  ${path.basename(c.jpg)}  (will OVERWRITE existing .jpg)`);
      } else {
        console.log(`  → ${rel}  (${formatBytes(c.sourceBytes)})`);
      }
      continue;
    }

    // Apply: rename. fs.rename overwrites the destination on POSIX,
    // which matches the user's choice.
    try {
      await fs.rename(c.jpeg, c.jpg);
    } catch (e) {
      console.log(`  ✗ ${rel} — rename failed: ${e.message}`);
      failed++;
      errors.push({ file: rel, error: e.message });
      continue;
    }

    // Verify
    if (!(await nonZeroFile(c.jpg))) {
      console.log(`  ✗ ${rel} — rename reported success but ${relOut} is missing or empty`);
      failed++;
      errors.push({ file: rel, error: 'destination missing or empty after rename' });
      continue;
    }

    if (collision) {
      console.log(`  ✓ ${rel}  →  ${path.basename(c.jpg)}  (OVERWROTE existing .jpg)`);
      overwritten++;
    } else {
      console.log(`  ✓ ${rel}  →  ${path.basename(c.jpg)}`);
    }
    renamed++;
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('');
  console.log('— summary —');
  console.log(`  .jpeg files found:   ${candidates.length}`);
  if (APPLY) {
    console.log(`  renamed:             ${renamed}`);
    console.log(`  (of which overwrote existing .jpg): ${overwritten}`);
    console.log(`  failed:              ${failed}`);
  } else {
    const willOverwrite = await Promise.all(candidates.map(c => exists(c.jpg)));
    const overwriteCount = willOverwrite.filter(Boolean).length;
    console.log(`  would rename:        ${candidates.length}`);
    console.log(`  would overwrite:     ${overwriteCount}`);
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
    console.log('🔍 DRY RUN — nothing changed. Re-run with --apply to rename.');
    console.log('');
  } else if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

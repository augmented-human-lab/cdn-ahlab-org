# data/

Canonical site data for the [AHLab](https://ahlab.org) static site, served by
the build pipeline in the sibling `new-ahlab-org` repo.

## Layout

```
data/
  people/
    _order.json           ["suranga-nanayakkara", "chitralekha-gupta", ...]
    suranga-nanayakkara.json
    chitralekha-gupta.json
    ...
  projects/      same shape: _order.json + <slug>.json per record
  publications/
  press/
  events/
```

Each subdirectory holds one JSON file per record, plus a single
`_order.json` listing the slugs in canonical render order. Build scripts
load a collection by reading `_order.json` and then each named record file.

## Why per-record + an explicit `_order.json`?

The future Apps Script edit pipeline will mutate one record at a time. With
master JSON files, every patch would rewrite the entire 900 KB people file
— creating noisy diffs and making concurrent edits impossible to reason
about. Per-record files mean one slug edited = one file changed in the
GitHub commit.

`_order.json` exists because some collections (notably `people`) have a
domain-meaningful order that isn't derivable from the records themselves.
It also doubles as the index of "what records exist" for fast loading.

## Editing rules

- **Don't edit by hand** while the Apps Script edit pipeline is in use —
  use the `/my-ahl/` editor on the site so changes go through review.
- One-off bulk migrations should use the `build/lib/data.js` helper in the
  `new-ahlab-org` repo: `loadCollection`, `writeCollection`, etc.
- When adding a record, append the slug to `_order.json` AND create the
  matching `<slug>.json` in the same commit.
- When removing a record, remove from `_order.json` AND delete the
  `<slug>.json` in the same commit.

## Migrated from

This data was previously stored as master JSON files at
`new-ahlab-org/src/data/{people,projects,publications,press,events}.json`.
The split was performed by `tools/split-data-to-cdn.mjs` (see that repo).
The original master files remain in place during the migration window for
audit; once the build is verified against this layout, they can be deleted.

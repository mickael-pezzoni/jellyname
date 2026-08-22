# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`jellyname` is a CLI that scans a media folder (movies/TV/anime) and proposes renaming files to the Jellyfin naming convention, identifying each file via the TMDB API. No file is ever renamed without explicit approval, and a file TMDB can't identify is left untouched.

## Commands

```bash
direnv allow          # activates the Nix dev shell (provides `bun`) for this folder — required once per clone
bun install
bun run src/index.ts <subcommand> ...   # == `bun run dev`
bun build ./src/index.ts --compile --outfile jellyname   # == `bun run build`, produces a standalone binary
bun test                                                    # no test files exist yet
```

There is no separate lint/typecheck script in `package.json`; type-check ad hoc with `bunx tsc --noEmit`.

If `direnv`/Nix isn't available, `bun` just needs to be on `PATH` — nothing else in `shell.nix` is required at runtime.

The CLI needs `TMDB_API_KEY` set (copy `.env.example` to `.env`).

### Subcommands

```bash
jellyname scan --dir <path> --type <movie|tv|anime> --out <path>
jellyname resolve --report <manifest.json>
jellyname apply --report <manifest.json> [--yes] [--retry-failed]
jellyname render --report <manifest.json>
```

## Architecture

The tool is deliberately split into four **independent** steps that communicate only through a JSON report on disk — there is no single "scan and apply in one run" path, and this must not be reintroduced:

1. **`scan`** — walks a folder, parses filenames, queries TMDB, writes a report. Never touches media files.
2. **`resolve`** — interactively resolves TMDB matches whose confidence score fell below threshold (`ambiguous[]` in the manifest), by writing a `resolvedTmdbId` onto the item.
3. **`render`** — reads the report and (re)generates an HTML viewer. Called on demand, never automatically from `apply`.
4. **`apply`** — reads the report, asks for one global yes/no confirmation (unless `--yes`), then moves/renames files.

**Report format** (`src/report/types.ts`): a `manifest.json` plus one or more `part-NNN.json` files. The split across parts exists purely to keep individual JSON files small, and the rule that governs it must be preserved in any future writer: **a show (with all its seasons/episodes) or a movie is never split across two part files** — a part boundary only ever falls between two whole shows/movies. Movies live under `movies[]`, TV/anime under `shows[] → seasons[] → episodes[]` (this nesting exists because the physical output layout is `Show/Season NN/`, and the JSON mirrors it 1:1). Items TMDB couldn't place confidently enough land in `manifest.ambiguous[]`; items with no match at all land in `manifest.unmatched[]`.

**Resumability**: every `MovieItem`/`EpisodeItem` carries its own `status: "pending" | "done" | "failed"`. `apply` updates this field (and rewrites the owning part file) as it processes each item, so an interrupted run can be re-invoked and will skip everything already `"done"`. `--retry-failed` is required to re-attempt items marked `"failed"` — by default they stay failed and are skipped, since a plain `apply` should not require the whole report and TMDB matching to be redone. `apply` itself never regenerates `report.html`; call `render` separately when a fresh view is wanted (this was a deliberate perf tradeoff — see git history / prior discussion if it needs revisiting).

**Safety invariants** that any change to `apply`/`fs` logic must keep:
- Never overwrite an existing file at `newPath` — mark the item `"failed"` instead.
- If `oldPath` no longer exists at apply time, mark that item `"failed"` and keep processing the rest of the report; don't abort the whole run.
- Validate the report (schema + no duplicate `newPath` across items) before moving anything, and refuse to start on a bad report rather than warn-and-continue.

**`--type movie|tv|anime`** picks both the TMDB endpoint (`movie` vs `tv`; anime is structurally `tv`) and the filename parser: `parse-torrent-title` for `movie`/`tv`, `anitomyscript` for `anime` (its release-naming conventions — absolute episode numbers, fansub group tags — don't parse well with the generic parser). One scan == one folder == one homogeneous type; there is no auto-detection of content type.

**Matching confidence**: TMDB search results are scored (title similarity + year match + popularity as a tiebreaker) against a configurable threshold. Above threshold → auto-accepted; below → the item goes to `ambiguous[]` for `resolve` to handle. Treat this threshold as a knob expected to need tuning once real data is available, not a fixed constant.

### Directory layout

```
src/
  index.ts        # argv[2] dispatch to the four subcommands, nothing else
  commands/       # one file per subcommand; each owns its own arg parsing (node:util parseArgs)
  report/types.ts  # the on-disk report schema — the shared contract between all four subcommands
  parsing/        # (not yet implemented) filename → {title, year, season, episode}
  tmdb/           # (not yet implemented) API client + confidence scoring
  html/           # (not yet implemented) report.html generation
  fs/             # (not yet implemented) move/rename with collision + cross-device handling
```

`commands/*.ts` currently validate their args and then throw `"<command>: pas encore implémenté"` — the business logic in `parsing/`, `tmdb/`, `html/`, `fs/` has not been written yet.

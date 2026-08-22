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
jellyname scan --dir <path> --type <movie|tv|anime> --out <path> [--dest <path>]
jellyname resolve --report <manifest.json>
jellyname apply --report <manifest.json> [--yes] [--retry-failed]
jellyname render --report <manifest.json>
```

## Architecture

The tool is deliberately split into four **independent** steps that communicate only through a JSON report on disk — there is no single "scan and apply in one run" path, and this must not be reintroduced:

1. **`scan`** — walks a folder, parses filenames, queries TMDB, writes a report. Never touches media files.
2. **`resolve`** — interactively walks `manifest.ambiguous[]` (TMDB matches whose confidence score fell below threshold), lets the user pick a candidate per item, and directly builds the resulting `MovieItem`/`EpisodeItem` into the parts (merging into an existing show/season across parts if one already matches by `tmdbId`, rather than duplicating it), removing the item from `ambiguous[]`.
3. **`render`** — reads the report and (re)generates an HTML viewer. Called on demand, never automatically from `apply`.
4. **`apply`** — reads the report, asks for one global yes/no confirmation (unless `--yes`), then moves/renames files.

**Report format** (`src/report/types.ts`): a `manifest.json` plus one or more `part-NNN.json` files. The split across parts exists purely to keep individual JSON files small, and the rule that governs it must be preserved in any future writer: **a show (with all its seasons/episodes) or a movie is never split across two part files** — a part boundary only ever falls between two whole shows/movies. Movies live under `movies[]`, TV/anime under `shows[] → seasons[] → episodes[]` (this nesting exists because the physical output layout is `Show/Season NN/`, and the JSON mirrors it 1:1). Items TMDB couldn't place confidently enough land in `manifest.ambiguous[]`; items with no match at all land in `manifest.unmatched[]`.

**Resumability**: every `MovieItem`/`EpisodeItem` carries its own `status: "pending" | "done" | "failed"`. `apply` updates this field (and rewrites the owning part file) as it processes each item, so an interrupted run can be re-invoked and will skip everything already `"done"`. `--retry-failed` is required to re-attempt items marked `"failed"` — by default they stay failed and are skipped, since a plain `apply` should not require the whole report and TMDB matching to be redone. `apply` itself never regenerates `report.html`; call `render` separately when a fresh view is wanted (this was a deliberate perf tradeoff — see git history / prior discussion if it needs revisiting).

**Safety invariants** that any change to `apply`/`fs` logic must keep:
- Never overwrite an existing file at `newPath` — mark the item `"failed"` instead.
- If `oldPath` no longer exists at apply time, mark that item `"failed"` and keep processing the rest of the report; don't abort the whole run.
- Validate the report (schema + no duplicate `newPath` across items) before moving anything, and refuse to start on a bad report rather than warn-and-continue.

**`--type movie|tv|anime`** picks both the TMDB endpoint (`movie` vs `tv`; anime is structurally `tv`) and the filename parser: `parse-torrent-title` for `movie`/`tv`, `anitomyscript` for `anime` (its release-naming conventions — absolute episode numbers, fansub group tags — don't parse well with the generic parser). One scan == one folder == one homogeneous type; there is no auto-detection of content type.

**Matching confidence**: TMDB is searched in multiple languages (`fr-FR` and `en-US`, hardcoded in `commands/scan.ts`) rather than a single one — the same title/show can come back once per language with a different localized name, and `scoreCandidates` (`tmdb/match.ts`) dedupes by `tmdbId`, keeping whichever language's title scores highest against the parsed filename. This matters because a French-named file and an English-named file for the same movie need different reference titles to score well; don't collapse this back to a single search language. Score = title similarity (normalized Levenshtein) blended with a year-match bonus, compared against a confidence threshold (currently `0.7`, in `tmdb/match.ts`). Above threshold → auto-accepted; below → the item goes to `ambiguous[]` for `resolve` to handle. Treat this threshold as a knob expected to need tuning as more real data comes in, not a fixed constant. Separately, `tmdb/client.ts` retries a search once with a lone mid-title number stripped (e.g. "Harry Potter 5 et...") when TMDB returns zero results — some parsed titles retain a franchise entry number that breaks TMDB's search outright.

`manifest.libraryRoot` (set from `scan`'s `--dest`, defaulting to `--dir`) is the root new paths are computed under — `resolve` needs it to build `newPath` for items that had none at scan time.

### Directory layout

```
src/
  index.ts        # argv[2] dispatch to the four subcommands, nothing else
  commands/       # one file per subcommand; each owns its own arg parsing (node:util parseArgs)
  report/types.ts  # the on-disk report schema — the shared contract between all four subcommands
  report/naming.ts # Jellyfin path builders (movieTargetPath, showRoot, seasonTargetDir, episodeFileName)
  report/writer.ts # scan's report writer — owns the part-splitting rule
  report/reader.ts # aggregates manifest + all parts for render (movies/shows collapsed into flat arrays)
  parsing/        # filename → {title, year, season, episode}; anime.ts hides globalThis.fetch during
                  # anitomyscript's one-time WASM init (its emscripten loader misdetects Bun's native
                  # fetch and tries to fetch() the wasm file by a relative path otherwise)
  tmdb/           # API client (multi-language search + throttling) + confidence scoring
  html/           # report.html generation (self-contained, data embedded inline — no fetch)
  fs/walk.ts      # recursive video file listing
```

All four commands are implemented; `apply` is the only one with real filesystem side effects.

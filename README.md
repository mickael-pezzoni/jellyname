# jellyname

CLI that scans a media folder (movies/TV shows/anime) and proposes renaming files to match the [Jellyfin](https://jellyfin.org/docs/general/server/media/movies/) naming convention, identifying each file via [TMDB](https://www.themoviedb.org/).

No file is ever renamed without explicit approval. A file that TMDB can't identify is left untouched.

## Stack

- [Bun](https://bun.sh/) + TypeScript
- TMDB API (v3)
- Dev environment managed with Nix (`shell.nix` + `direnv`)

## Setup

```bash
direnv allow      # activates the Nix environment (bun) for this folder
bun install
cp .env.example .env
# set TMDB_API_KEY in .env
```

## Usage

The workflow is split into 4 independent steps:

```bash
# 1. Scan a folder and generate a report (no writes to media files)
jellyname scan --dir /media/tv --type tv --out ./report
# add --dest <path> to compute new paths under a different library root than --dir
# (defaults to --dir itself, i.e. reorganizing files in place)
# add --render to also generate report.html right after the scan (same as running `render` after)

# 2. Manually resolve ambiguous TMDB matches (confidence score below threshold)
jellyname resolve --report ./report/manifest.json
# walks through ambiguous items one by one: pick a candidate number, "s" to skip, "q" to quit

# 3. Generate an HTML page to browse the report in a web browser
jellyname render --report ./report/manifest.json

# 4. Apply the renames after a single global confirmation
jellyname apply --report ./report/manifest.json
```

`--type` is one of `movie`, `tv` or `anime` — a scanned folder must be homogeneous (one type per scan).

### Useful flags

| Command | Flag | Effect |
|---|---|---|
| `apply` | `--yes` | Skip the interactive confirmation (scripted usage) |
| `apply` | `--retry-failed` | Retry items marked `failed` in a previous run |

`apply` updates each item's status (`pending`/`done`/`failed`) in the report as it goes, so an interrupted run can be resumed without starting over. It also reports how many ambiguous items are still pending `resolve`, if any.

## Report structure

A scan produces a folder containing:

```
report/
  manifest.json     # metadata, list of parts, ambiguous and unmatched items
  part-001.json      # groups whole shows/movies (never split mid-show/mid-movie)
  part-002.json
  report.html        # generated on demand via `render`, data embedded inline (no fetch)
```

An existing file at the destination path is never overwritten — the corresponding item is marked `failed` instead. A duplicate `newPath` between two items doesn't abort the run either — both are marked `failed` and everything else proceeds. After a successful move, the source directory (and any leftover non-video files in it, like posters or `.nfo`) is removed once it no longer contains any video file — a directory still holding an unmatched video is left untouched, and the scan root itself (`--dir`) is never removed this way even if a file sat directly at its root.

## Project structure

```
src/
  index.ts            # entry point, subcommand routing
  commands/           # scan, resolve, apply, render
  report/types.ts      # report schema (Manifest, Part, Show/Season/Episode, Movie...)
  parsing/            # title/year/season-episode extraction from filenames
  tmdb/               # API client + confidence scoring
  html/               # report.html generation
  fs/                 # file moving, collision handling
```

## Build

```bash
bun build ./src/index.ts --compile --outfile jellyname
```

Produces a standalone executable that doesn't require Bun to be installed on the target machine.

## Status

All four commands (`scan`, `resolve`, `render`, `apply`) are implemented and working end-to-end against the real TMDB API.

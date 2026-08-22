#!/usr/bin/env bun

import { runScan } from "./commands/scan.ts";
import { runResolve } from "./commands/resolve.ts";
import { runApply } from "./commands/apply.ts";
import { runRender } from "./commands/render.ts";

const USAGE = `jellyname — renomme des médias (films/séries/anime) selon la convention Jellyfin via TMDB

Usage:
  jellyname scan --dir <path> --type <movie|tv|anime> --out <path> [--dest <path>] [--render]
  jellyname resolve --report <manifest.json>
  jellyname apply --report <manifest.json> [--yes] [--retry-failed]
  jellyname render --report <manifest.json>
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "scan":
      await runScan(rest);
      break;
    case "resolve":
      await runResolve(rest);
      break;
    case "apply":
      await runApply(rest);
      break;
    case "render":
      await runRender(rest);
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main();

import { parseArgs } from "node:util";
import type { MediaType } from "../report/types.ts";

export interface ScanOptions {
  dir: string;
  type: MediaType;
  out: string;
}

function parseScanArgs(argv: string[]): ScanOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      type: { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.dir || !values.type || !values.out) {
    throw new Error("Usage: jellyname scan --dir <path> --type <movie|tv|anime> --out <path>");
  }

  if (values.type !== "movie" && values.type !== "tv" && values.type !== "anime") {
    throw new Error(`--type invalide: "${values.type}" (attendu: movie, tv ou anime)`);
  }

  return { dir: values.dir, type: values.type, out: values.out };
}

export async function runScan(argv: string[]): Promise<void> {
  const options = parseScanArgs(argv);
  console.log(`scan: dir=${options.dir} type=${options.type} out=${options.out}`);
  throw new Error("scan: pas encore implémenté");
}

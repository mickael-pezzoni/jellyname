import { parseArgs } from "node:util";

export interface ResolveOptions {
  report: string;
}

function parseResolveArgs(argv: string[]): ResolveOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
    },
  });

  if (!values.report) {
    throw new Error("Usage: jellyname resolve --report <manifest.json>");
  }

  return { report: values.report };
}

export async function runResolve(argv: string[]): Promise<void> {
  const options = parseResolveArgs(argv);
  console.log(`resolve: report=${options.report}`);
  throw new Error("resolve: pas encore implémenté");
}

import { parseArgs } from "node:util";

export interface RenderOptions {
  report: string;
}

function parseRenderArgs(argv: string[]): RenderOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
    },
  });

  if (!values.report) {
    throw new Error("Usage: jellyname render --report <manifest.json>");
  }

  return { report: values.report };
}

export async function runRender(argv: string[]): Promise<void> {
  const options = parseRenderArgs(argv);
  console.log(`render: report=${options.report}`);
  throw new Error("render: pas encore implémenté");
}

/**
 * The local embedding host, written to `<installDir>/embed-host.mjs` at install time and run by
 * bun from that directory, where `@huggingface/transformers` is installed. It is a string because
 * a compiled PPM reaches none of its own node_modules and cannot load the library itself.
 *
 * Protocol (JSON lines over stdio):
 *   in:  {"id": 1, "texts": ["passage: …"], "kind": "passage"}   texts already carry e5 prefixes
 *   out: {"id": 1, "vectors": [[…384 numbers…]]}  or  {"id": 1, "error": "…"}
 * Requests are answered one at a time. The host exits when stdin closes.
 * `--warm` loads (downloads) the model into `<installDir>/models`, embeds one text and exits 0.
 */
export const EMBED_HOST_FILE = "embed-host.mjs";

export const EMBED_HOST_SOURCE = `// Written by PPM. Do not edit: it is rewritten on every install.
import { pipeline, env } from "@huggingface/transformers";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "Xenova/multilingual-e5-small";
const DTYPE = "q8";
const here = dirname(fileURLToPath(import.meta.url));
env.cacheDir = join(here, "models");
mkdirSync(env.cacheDir, { recursive: true });

let extractor = null;
function load() {
  if (!extractor) {
    extractor = pipeline("feature-extraction", MODEL, { dtype: DTYPE });
    extractor.catch(() => { extractor = null; });
  }
  return extractor;
}

async function embed(texts) {
  const extract = await load();
  const out = await extract(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

if (process.argv.includes("--warm")) {
  try {
    const v = await embed(["passage: warm"]);
    send({ warm: true, dims: v[0] ? v[0].length : 0 });
    process.exit(0);
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\\n");
    process.exit(1);
  }
}

let chain = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    try {
      send({ id: req.id, vectors: await embed(Array.isArray(req.texts) ? req.texts : []) });
    } catch (err) {
      send({ id: req.id, error: String(err && err.message ? err.message : err) });
    }
  });
});
rl.on("close", () => {
  chain.finally(() => process.exit(0));
});
`;

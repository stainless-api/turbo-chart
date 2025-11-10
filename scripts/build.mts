import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

mkdirSync(new URL("./../dist", import.meta.url), { recursive: true });
writeFileSync(
  new URL("./../dist/turbo-chart.mjs", import.meta.url),
  stripTypeScriptTypes(
    readFileSync(new URL("../src/turbo-chart.mts", import.meta.url), "utf-8")
  ),
  "utf-8"
);

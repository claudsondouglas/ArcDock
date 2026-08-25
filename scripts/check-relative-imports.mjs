import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function* javascriptFiles(directory) {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* javascriptFiles(path);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) yield path;
  }
}

const failures = [];
const importPattern = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g;

for (const file of javascriptFiles(".")) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.endsWith(".js") && !specifier.endsWith(".mjs"))
      failures.push(`${file}: relative import needs an extension: ${specifier}`);
    else if (!existsSync(resolve(dirname(file), specifier)))
      failures.push(`${file}: relative import does not exist: ${specifier}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

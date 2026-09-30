import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.argv[2] ?? "main.js");
const code = readFileSync(file, "utf8");
const checks = [
  ["dynamic script element", /(?:createElement|createEl)\s*\(\s*(['"`])script\1\s*\)/g],
  ["dynamic function constructor", /\bnew\s+Function\s*\(/g],
  ["direct eval", /(?:^|[^\w.$])eval\s*\(/g],
];
let total = 0;
for (const [label, pattern] of checks) {
  const count = [...code.matchAll(pattern)].length;
  console.log(`${label}: ${count}`);
  total += count;
}
if (total) {
  console.error(`FAIL: ${file} contains ${total} prohibited dynamic-code constructs`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${file} contains no prohibited dynamic-code constructs`);
}

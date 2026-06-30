import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = resolve(process.env.LIFEOS_EXPERIENCE_VAULT || "D:\\个人信息\\人生-插件体验仓库");
const pluginDir = join(vaultRoot, ".obsidian", "plugins", "personal-life-system");
const dataPath = join(pluginDir, "data.json");
const reportPath = resolve(repoRoot, process.env.LIFEOS_SYNC_REPORT || "tmp/sync-experience-vault-result.json");
const artifacts = ["main.js", "manifest.json", "styles.css", "assets/default-background.png"];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), "-", pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

ensureFile(vaultRoot, "experience vault");
mkdirSync(pluginDir, { recursive: true });

const beforeDataPresent = existsSync(dataPath);
const beforeDataHash = beforeDataPresent ? sha256(dataPath) : "";
const backupDir = join(pluginDir, ".lifeos-backups", `${timestamp()}-pre-ai-edit-0.3.7`);
mkdirSync(backupDir, { recursive: true });

for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
  const current = join(pluginDir, artifact);
  if (existsSync(current)) copyFileSync(current, join(backupDir, artifact));
}

for (const artifact of artifacts) {
  const source = join(repoRoot, artifact);
  const target = join(pluginDir, artifact);
  ensureFile(source, "source artifact");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const afterDataPresent = existsSync(dataPath);
const afterDataHash = afterDataPresent ? sha256(dataPath) : "";
const dataPreserved = beforeDataPresent === afterDataPresent && beforeDataHash === afterDataHash;
const checks = artifacts.map((artifact) => {
  const source = join(repoRoot, artifact);
  const target = join(pluginDir, artifact);
  return {
    artifact,
    sourceSha256: sha256(source),
    targetSha256: sha256(target),
    matches: sha256(source) === sha256(target)
  };
});
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const bundle = readFileSync(join(pluginDir, "main.js"), "utf8");
const markers = {
  selectionCommand: bundle.includes("lifeos-ai-edit-selection"),
  panelView: bundle.includes("personal-life-system-ai-edit-panel"),
  popoverClass: bundle.includes("lifeos-ai-edit-popover")
};
const result = {
  pass: dataPreserved && manifest.version === "0.3.7" && checks.every((item) => item.matches) && Object.values(markers).every(Boolean),
  generatedAt: new Date().toISOString(),
  vaultRoot,
  pluginDir: relative(vaultRoot, pluginDir),
  version: manifest.version,
  dataJsonPresent: afterDataPresent,
  dataJsonPreserved: dataPreserved,
  backupDir: relative(vaultRoot, backupDir),
  markers,
  artifacts: checks
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n", "utf8");
if (!result.pass) throw new Error(`Experience vault sync failed: ${reportPath}`);
console.log("Life OS 0.3.7 experience vault sync passed.");
console.log(JSON.stringify(result, null, 2));

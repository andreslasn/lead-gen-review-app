import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || "public/data");
const requiredFiles = [
  "manifest.json",
  "queue.json",
  "clinic-index.json",
  "canonical-review-state.json",
];
const secretPatterns = [
  ["Google API key", /(^|[^0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}([^0-9A-Za-z_-]|$)/],
  ["GitHub token", /(^|[^0-9A-Za-z_])(ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,})/],
];

function fail(message) {
  throw new Error(`Review package check failed: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function json(relative) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    fail(`${relative}: ${error.message}`);
  }
}

async function sha256(file) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${digest.digest("hex")}`;
}

async function filesUnder(relative, suffix = null) {
  const directory = path.join(root, relative);
  const output = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (!suffix || target.endsWith(suffix)) output.push(target);
    }
  }
  await walk(directory);
  return output.sort((a, b) => {
    const left = path.relative(root, a).split(path.sep).join("/");
    const right = path.relative(root, b).split(path.sep).join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

async function treeSummary(paths) {
  const digest = createHash("sha256");
  let byteSize = 0;
  for (const file of paths) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const size = (await stat(file)).size;
    const fileHash = await sha256(file);
    byteSize += size;
    digest.update(relative, "utf8");
    digest.update("\0");
    digest.update(fileHash, "ascii");
    digest.update("\0");
    digest.update(String(size), "ascii");
    digest.update("\n");
  }
  return {
    file_count: paths.length,
    byte_size: byteSize,
    sha256: `sha256:${digest.digest("hex")}`,
  };
}

async function scanSecrets(file) {
  let carry = "";
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: "latin1" });
    stream.on("data", (chunk) => {
      const text = carry + chunk;
      for (const [name, pattern] of secretPatterns) {
        if (pattern.test(text)) {
          stream.destroy(new Error(`${name} detected in ${path.relative(root, file)}`));
          return;
        }
      }
      carry = text.slice(-128);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

const manifest = await json("manifest.json");
const queue = await json("queue.json");
const clinicIndex = await json("clinic-index.json");
const integrity = await json("package-integrity.json");

if (manifest.format !== "lead-gen-review-package" || manifest.schema_version !== 1) fail("unsupported manifest contract");
if (!manifest.country_pack?.config_hash) fail("country-pack hash missing");
if (!manifest.market?.country_code || !manifest.review_ui?.contact_types?.length) fail("market UI configuration missing");
if (integrity.dataset_id !== manifest.dataset_id || integrity.country !== manifest.country) fail("manifest/integrity identity mismatch");
const fingerprintPayload = { ...integrity };
delete fingerprintPayload.package_fingerprint;
const fingerprint = `sha256:${createHash("sha256").update(stableJson(fingerprintPayload), "utf8").digest("hex")}`;
if (fingerprint !== integrity.package_fingerprint) fail("integrity fingerprint mismatch");

const queueItems = queue.items || [];
const indexItems = clinicIndex.items || [];
const expectedClinics = Number(manifest.counts?.clinics || 0);
if (queueItems.length !== expectedClinics || indexItems.length < expectedClinics) fail("clinic counts are inconsistent");
const queueIds = queueItems.map((item) => String(item.id || ""));
const indexIds = indexItems.map((item) => String(item.id || ""));
if (new Set(queueIds).size !== queueIds.length || new Set(indexIds).size !== indexIds.length) fail("duplicate clinic IDs");
const indexSet = new Set(indexIds);
if (queueIds.some((id) => !indexSet.has(id))) fail("queue contains clinics absent from the market index");

for (const clinicId of queueIds) {
  try {
    await stat(path.join(root, "clinics", `${clinicId}.json`));
  } catch {
    fail(`missing clinic payload ${clinicId}`);
  }
}
for (const [relative, expectedHash] of Object.entries(integrity.required_files || {})) {
  if ((await sha256(path.join(root, relative))) !== expectedHash) fail(`generated file drift: ${relative}`);
}

const clinicFiles = await filesUnder("clinics", ".json");
const evidenceFiles = await filesUnder("sources");
const clinicTree = await treeSummary(clinicFiles);
const evidenceTree = await treeSummary(evidenceFiles);
if (JSON.stringify(clinicTree) !== JSON.stringify(integrity.trees?.clinics)) fail("clinic payload tree drift");
if (JSON.stringify(evidenceTree) !== JSON.stringify(integrity.trees?.evidence)) fail("evidence artifact tree drift");

for (const file of [...clinicFiles, ...evidenceFiles, ...requiredFiles.map((name) => path.join(root, name))]) {
  await scanSecrets(file);
}

console.log(`Review package OK: ${manifest.dataset_id} · ${expectedClinics} clinics · ${integrity.package_fingerprint}`);

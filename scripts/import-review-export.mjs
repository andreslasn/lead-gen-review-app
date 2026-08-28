import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const reviewExportPath = process.argv[3] ? path.resolve(process.argv[3]) : "";
if (!reviewExportPath) {
  throw new Error("Usage: node scripts/import-review-export.mjs <repo-root> <review-export.json>");
}

const dataDirectory = path.join(root, "public", "data");
const canonicalStatePath = path.join(dataDirectory, "canonical-review-state.json");
const validationSeedPath = path.join(dataDirectory, "email-validation-seed.json");
const emailIndexPath = path.join(dataDirectory, "email-index.json");
const integrityPath = path.join(dataDirectory, "package-integrity.json");

const EMAIL_STATUSES = new Set(["unreviewed", "valid", "invalid"]);

function normalizeEmailValue(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function normalizedEmailStatus(value) {
  return EMAIL_STATUSES.has(value) ? value : "unreviewed";
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort((a, b) => a.localeCompare(b));
}

function mergeObjectsByKey(existingItems, incomingItems, keyFn, timeFn) {
  const byKey = new Map();
  for (const item of [...(existingItems || []), ...(incomingItems || [])]) {
    const key = keyFn(item);
    if (!key) continue;
    const existing = byKey.get(key);
    const existingTime = String(timeFn(existing) || "");
    const incomingTime = String(timeFn(item) || "");
    if (!existing || existingTime <= incomingTime) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function mergeSourceExports(sourceExports, sourceExport) {
  const seen = new Set();
  return [...(sourceExports || []), sourceExport].filter((item) => {
    const key = typeof item === "string"
      ? item
      : [item?.name, item?.path, item?.exported_at].filter(Boolean).join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emailValidationFromDecision(decision, exportedAt) {
  const email = normalizeEmailValue(decision.reviewed_value || decision.original_value);
  if (!email || !email.includes("@")) return null;
  const status = ["confirmed", "edited_confirmed"].includes(decision.decision)
    ? "valid"
    : decision.decision === "rejected"
      ? "invalid"
      : null;
  if (!status) return null;
  return {
    email,
    display_value: decision.reviewed_value || decision.original_value || email,
    status,
    reason_code: decision.reason_code || null,
    note: decision.note || null,
    reviewed_by: decision.reviewer_id || "reviewer",
    reviewed_at: decision.created_at || exportedAt,
    updated_at: decision.created_at || exportedAt,
    source: "legacy-decision",
    source_exports: ["latest-reviewer-export"],
    source_exported_at: exportedAt,
    clinic_id: decision.clinic_id || null,
    contact_point_id: decision.contact_point_id || null,
    source_decision_ids: decision.id ? [decision.id] : [],
    audit_flags: [],
  };
}

function normalizeValidation(validation, reviewExport, sourcePath) {
  const email = normalizeEmailValue(validation?.email || validation?.display_value);
  if (!email || !email.includes("@")) return null;
  return {
    ...validation,
    email,
    display_value: validation.display_value || email,
    status: normalizedEmailStatus(validation.status),
    reviewed_at: validation.reviewed_at || validation.updated_at || reviewExport.exported_at,
    updated_at: validation.updated_at || validation.reviewed_at || reviewExport.exported_at,
    source: validation.source || "review-export-seed",
    source_exports: sortedUnique([...(validation.source_exports || []), "latest-reviewer-export"]),
    source_exported_at: reviewExport.exported_at,
    source_dataset_id: reviewExport.dataset_id,
    source_review_export_path: path.basename(sourcePath),
    audit_flags: validation.audit_flags || [],
  };
}

function mergeValidation(existing, incoming) {
  if (!existing) return incoming;
  const existingTime = String(existing.updated_at || existing.reviewed_at || "");
  const incomingTime = String(incoming.updated_at || incoming.reviewed_at || "");
  const base = existingTime <= incomingTime ? incoming : existing;
  return {
    ...base,
    source_exports: sortedUnique([...(existing.source_exports || []), ...(incoming.source_exports || [])]),
    source_decision_ids: sortedUnique([...(existing.source_decision_ids || []), ...(incoming.source_decision_ids || [])]),
    source_campaign_files: sortedUnique([...(existing.source_campaign_files || []), ...(incoming.source_campaign_files || [])]),
    source_campaign_lead_ids: sortedUnique([...(existing.source_campaign_lead_ids || []), ...(incoming.source_campaign_lead_ids || [])]),
    occurrences: [...(existing.occurrences || []), ...(incoming.occurrences || [])],
    audit_flags: sortedUnique([...(existing.audit_flags || []), ...(incoming.audit_flags || [])]),
  };
}

function mergeValidations(existingValidations, incomingValidations) {
  const byEmail = new Map();
  for (const validation of [...(existingValidations || []), ...(incomingValidations || [])]) {
    const email = normalizeEmailValue(validation?.email || validation?.display_value);
    if (!email || !email.includes("@")) continue;
    byEmail.set(email, mergeValidation(byEmail.get(email), { ...validation, email }));
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

async function refreshIntegrityCanonicalHash() {
  const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  integrity.required_files = {
    ...(integrity.required_files || {}),
    "canonical-review-state.json": await sha256(canonicalStatePath),
  };
  const fingerprintPayload = { ...integrity };
  delete fingerprintPayload.package_fingerprint;
  integrity.package_fingerprint = `sha256:${createHash("sha256").update(stableJson(fingerprintPayload), "utf8").digest("hex")}`;
  await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`);
}

const [canonicalState, validationSeed, emailIndex, reviewExport] = await Promise.all([
  readFile(canonicalStatePath, "utf8").then(JSON.parse),
  readFile(validationSeedPath, "utf8").then(JSON.parse),
  readFile(emailIndexPath, "utf8").then(JSON.parse),
  readFile(reviewExportPath, "utf8").then(JSON.parse),
]);

if (reviewExport.format !== "lead-gen-clinic-review" || reviewExport.schema_version !== 1) {
  throw new Error("Unsupported review export format.");
}
if (reviewExport.dataset_id !== canonicalState.dataset_id || reviewExport.dataset_id !== validationSeed.dataset_id) {
  throw new Error(`Dataset mismatch: ${reviewExport.dataset_id}`);
}
await stat(reviewExportPath);

const importedAt = new Date().toISOString();
const sourceExport = {
  name: "latest-reviewer-export",
  path: path.basename(reviewExportPath),
  exported_at: reviewExport.exported_at,
  imported_at: importedAt,
  reviewer: reviewExport.reviewer || null,
  decisions: (reviewExport.decisions || []).length,
  clinic_states: (reviewExport.clinic_states || []).length,
  email_validations: (reviewExport.email_validations || []).length,
};

const canonicalOutput = {
  ...canonicalState,
  exported_at: reviewExport.exported_at || importedAt,
  reviewer: reviewExport.reviewer || canonicalState.reviewer,
  decisions: mergeObjectsByKey(
    canonicalState.decisions || [],
    reviewExport.decisions || [],
    (decision) => decision?.id,
    (decision) => decision?.created_at,
  ).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
  clinic_states: mergeObjectsByKey(
    canonicalState.clinic_states || [],
    reviewExport.clinic_states || [],
    (state) => state?.clinic_id,
    (state) => state?.updated_at || state?.reviewed_at,
  ).sort((a, b) => String(a.clinic_id || "").localeCompare(String(b.clinic_id || ""))),
  role_overrides: mergeObjectsByKey(
    canonicalState.role_overrides || [],
    reviewExport.role_overrides || [],
    (override) => override?.contact_point_id,
    (override) => override?.updated_at,
  ).sort((a, b) => String(a.contact_point_id || "").localeCompare(String(b.contact_point_id || ""))),
  audit_events: mergeObjectsByKey(
    canonicalState.audit_events || [],
    reviewExport.audit_events || [],
    (event) => event?.id,
    (event) => event?.created_at,
  ).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
};

const importedValidations = [
  ...(reviewExport.email_validations || []).map((validation) => normalizeValidation(validation, reviewExport, reviewExportPath)),
  ...(reviewExport.decisions || []).map((decision) => emailValidationFromDecision(decision, reviewExport.exported_at || importedAt)),
].filter(Boolean);
const validations = mergeValidations(validationSeed.validations || [], importedValidations);
const indexedEmails = new Set((emailIndex.items || []).map((item) => item.email));
const validationSeedOutput = {
  ...validationSeed,
  generated_at: importedAt,
  source_exports: mergeSourceExports(validationSeed.source_exports, sourceExport),
  counts: {
    validations: validations.length,
    indexed_validations: validations.filter((validation) => indexedEmails.has(validation.email)).length,
    not_in_email_index: validations.filter((validation) => !indexedEmails.has(validation.email)).length,
  },
  validations,
};

await Promise.all([
  writeFile(canonicalStatePath, `${JSON.stringify(canonicalOutput, null, 2)}\n`),
  writeFile(validationSeedPath, `${JSON.stringify(validationSeedOutput, null, 2)}\n`),
]);
await refreshIntegrityCanonicalHash();

console.log(`Merged ${sourceExport.decisions} decisions and ${sourceExport.clinic_states} clinic states from ${path.basename(reviewExportPath)}.`);
console.log(`Email validation seed now has ${validations.length} validations (${validationSeedOutput.counts.not_in_email_index} not in email index).`);

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const defaultCampaignDirectories = [
  path.join(process.env.HOME || "", "Downloads", "campaign"),
  path.join(process.env.HOME || "", "Downloads", "campaigns"),
];
const campaignSources = (process.argv.slice(3).length ? process.argv.slice(3) : [defaultCampaignDirectories[1]])
  .map((source) => path.resolve(source));
const dataDirectory = path.join(root, "public", "data");
const emailIndexPath = path.join(dataDirectory, "email-index.json");
const emailQueuePath = path.join(dataDirectory, "email-review-queue.json");
const validationSeedPath = path.join(dataDirectory, "email-validation-seed.json");
const usagePath = path.join(dataDirectory, "campaign-email-usage.json");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === "\"") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value !== ""));
}

function normalizeEmailValue(value) {
  const match = String(value || "").trim().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function rowObject(header, row) {
  return Object.fromEntries(header.map((name, index) => [name, row[index] || ""]));
}

function firstValue(object, keys) {
  return keys.map((key) => object[key]).find((value) => String(value || "").trim()) || "";
}

function normalizedMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function safeSlug(value) {
  return normalizedMatchText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sentTimes(object) {
  return Object.entries(object)
    .filter(([key, value]) => /^sentAt\d*$/.test(key) && String(value || "").trim())
    .map(([, value]) => value)
    .sort();
}

function eventTimes(object) {
  return Object.entries(object)
    .filter(([key, value]) => /At\d*$/.test(key) && String(value || "").trim())
    .map(([, value]) => value)
    .sort();
}

async function jsonDocument(file) {
  const text = await readFile(file, "utf8");
  return {
    data: JSON.parse(text),
    pretty: text.includes("\n  \"") || text.split("\n").length > 2,
  };
}

function stringifyJson(value, pretty) {
  return pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))].sort((a, b) => a.localeCompare(b));
}

function mergedSourceExports(sourceExports, campaignSource) {
  const output = [...(sourceExports || []), campaignSource];
  const seen = new Set();
  return output.filter((item) => {
    const key = typeof item === "string"
      ? item
      : [item?.name, item?.path, item?.exported_at].filter(Boolean).join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function campaignFilesFromSources(sources) {
  const files = [];
  const seen = new Set();
  for (const source of sources) {
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      const directoryFiles = (await readdir(source))
        .filter((file) => file.toLowerCase().endsWith(".csv"))
        .map((file) => ({ file_name: file, path: path.join(source, file) }));
      for (const file of directoryFiles) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        files.push(file);
      }
    } else if (sourceStat.isFile() && source.toLowerCase().endsWith(".csv")) {
      if (seen.has(source)) continue;
      seen.add(source);
      files.push({ file_name: path.basename(source), path: source });
    }
  }
  return files.sort((a, b) => a.file_name.localeCompare(b.file_name) || a.path.localeCompare(b.path));
}

function makeCampaignSummary(record) {
  const sent = sentTimes(record.row);
  const events = eventTimes(record.row);
  return {
    source_file: record.source_file,
    row_number: record.row_number,
    lead_id: record.row._id || null,
    sent_at: sent[0] || null,
    last_event_at: events.at(-1) || sent.at(-1) || null,
    stage: record.row.Stage || null,
    company_name: firstValue(record.row, ["companyName", "Company", "Organization - Name _", "Szolg_ltat_ neve"]) || null,
    person_name: firstValue(record.row, ["Person - Name _", "H_ziorvos neve", "firstName", "cleanFirstName"]) || null,
    location: firstValue(record.row, ["location", "Customer Type", "V_rmegye"]) || null,
  };
}

function regionFromFilename(file) {
  const fileSlug = safeSlug(file);
  const rawMatches = knownRegions.filter((region) => fileSlug.includes(safeSlug(region)));
  const matches = rawMatches.filter((region) => {
    const slug = safeSlug(region);
    return !rawMatches.some((other) => other !== region && safeSlug(other).includes(slug));
  });
  return matches.length === 1 ? matches[0] : "";
}

function canonicalRegion(value) {
  const slug = safeSlug(value);
  if (!slug) return "";
  return regionBySlug.get(slug) || "";
}

function campaignRegion(record) {
  const explicit = canonicalRegion(firstValue(record.row, [
    "V_rmegye",
    "location",
    "Customer Type",
    "Customer type",
    "CSONGR_D-CSAN_D",
  ]));
  return explicit || regionFromFilename(record.source_file);
}

function campaignImportedEmailItem(email, records) {
  const preferred = records.find((record) => campaignRegion(record)) || records[0] || { row: {}, source_file: "" };
  const row = preferred.row || {};
  const region = campaignRegion(preferred);
  const city = firstValue(row, ["city", "Szeged"]);
  const address = firstValue(row, ["address", "Organization - Address _suggested_", "H_ziorvosi rendel_ c_me", "Debreceni u_ 10-14_"]);
  const name = firstValue(row, [
    "Person - Name _",
    "H_ziorvos neve",
    "Dr_ Garas Gy_rgyi Erzs_bet",
    "firstName",
    "cleanFirstName",
    "companyName",
    "Company",
    "Organization - Name _",
    "Szolg_ltat_ neve",
  ]);
  const occurrence = {
    clinic_id: null,
    contact_point_id: null,
    clinic_name: name || "",
    registry_id: "",
    city: city || "",
    region: region || "",
    address: address || "",
  };
  return {
    email,
    display_value: records[0]?.display_value || email,
    occurrence_count: 1,
    clinic_id: null,
    contact_point_id: null,
    name: name || "",
    registry_id: "",
    city: city || "",
    region: region || "",
    address: address || "",
    classification: "campaign_import",
    verification_status: "campaign_validated",
    mx_status: "unknown",
    deliverability_status: "unknown",
    usable_contact: true,
    confidence: 1,
    evidence_count: 0,
    regions: region ? [region] : [],
    region_occurrence_counts: region ? { [region]: 1 } : {},
    occurrences: [occurrence],
  };
}

const [emailIndexDocument, emailQueueDocument, validationSeedDocument] = await Promise.all([
  jsonDocument(emailIndexPath),
  jsonDocument(emailQueuePath),
  jsonDocument(validationSeedPath),
]);
const emailIndexPayload = emailIndexDocument.data;
const emailQueue = emailQueueDocument.data;
const validationSeed = validationSeedDocument.data;
const existingEmailItems = emailIndexPayload.items || [];
const existingEmailQueueItems = emailQueue.items || [];
const emailIndex = new Map(existingEmailItems.map((item) => [item.email, item]));
const emailQueueIndex = new Map(existingEmailQueueItems.map((item) => [item.email, item]));
const existingValidationByEmail = new Map((validationSeed.validations || []).map((item) => [normalizeEmailValue(item.email), item]));
const knownRegions = sortedUnique(existingEmailQueueItems.flatMap((item) => [
  item.region,
  ...(item.regions || []),
  ...(item.occurrences || []).map((occurrence) => occurrence.region),
]));
const regionBySlug = new Map(knownRegions.map((region) => [safeSlug(region), region]));
const sourceFiles = [];
const campaignRecordsByEmail = new Map();
const files = await campaignFilesFromSources(campaignSources);

for (const file of files) {
  const rows = parseCsv(await readFile(file.path, "utf8"));
  const header = rows[0] || [];
  const emailColumn = header.indexOf("email");
  if (emailColumn < 0) continue;
  const emails = [];
  for (const [offset, row] of rows.slice(1).entries()) {
    const email = normalizeEmailValue(row[emailColumn]);
    if (!email) continue;
    emails.push(email);
    const record = {
      email,
      display_value: row[emailColumn],
      source_file: file.file_name,
      row_number: offset + 2,
      row: rowObject(header, row),
    };
    if (!campaignRecordsByEmail.has(email)) campaignRecordsByEmail.set(email, []);
    campaignRecordsByEmail.get(email).push(record);
  }
  sourceFiles.push({
    file_name: file.file_name,
    path: file.path,
    row_count: Math.max(0, rows.length - 1),
    email_count: emails.length,
    unique_email_count: new Set(emails).size,
  });
}

const generatedAt = new Date().toISOString();
const campaignEmails = [...campaignRecordsByEmail.keys()].sort((a, b) => a.localeCompare(b));
const usageItems = campaignEmails.map((email) => {
  const records = campaignRecordsByEmail.get(email) || [];
  const campaigns = records.map(makeCampaignSummary);
  const sent = sortedUnique(campaigns.map((campaign) => campaign.sent_at));
  const events = sortedUnique(campaigns.map((campaign) => campaign.last_event_at));
  return {
    email,
    display_value: records[0]?.display_value || email,
    used_in_campaign: true,
    campaign_count: records.length,
    source_files: sortedUnique(records.map((record) => record.source_file)),
    lead_ids: sortedUnique(records.map((record) => record.row._id)),
    first_sent_at: sent[0] || null,
    last_sent_at: sent.at(-1) || null,
    last_event_at: events.at(-1) || sent.at(-1) || null,
    campaigns,
  };
});

const usagePayload = {
  format: "lead-gen-campaign-email-usage",
  schema_version: 1,
  dataset_id: emailQueue.dataset_id,
  dataset_version: emailQueue.dataset_version,
  generated_at: generatedAt,
  source_directory: campaignSources.length === 1 ? campaignSources[0] : null,
  source_inputs: campaignSources,
  source_files: sourceFiles,
  counts: {
    source_files: sourceFiles.length,
    rows: sourceFiles.reduce((sum, file) => sum + file.row_count, 0),
    campaign_email_rows: sourceFiles.reduce((sum, file) => sum + file.email_count, 0),
    emails: campaignEmails.length,
    indexed_emails: campaignEmails.filter((email) => emailIndex.has(email)).length,
    not_in_email_index: campaignEmails.filter((email) => !emailIndex.has(email)).length,
  },
  items: usageItems,
};

const importedEmailItems = [];
const upsertedCampaignOnlyEmailItems = [];
for (const [email, records] of campaignRecordsByEmail.entries()) {
  const existing = emailIndex.get(email);
  if (existing && existing.classification !== "campaign_import") continue;
  const item = campaignImportedEmailItem(email, records);
  if (!existing) importedEmailItems.push(item);
  upsertedCampaignOnlyEmailItems.push(item);
  emailIndex.set(email, item);
  emailQueueIndex.set(email, item);
}

const emailIndexExistingKeys = new Set(existingEmailItems.map((item) => item.email));
const emailQueueExistingKeys = new Set(existingEmailQueueItems.map((item) => item.email));
const emailIndexItems = [
  ...existingEmailItems.map((item) => emailIndex.get(item.email) || item),
  ...[...emailIndex.values()].filter((item) => !emailIndexExistingKeys.has(item.email)),
];
const emailQueueItems = [
  ...existingEmailQueueItems.map((item) => emailQueueIndex.get(item.email) || item),
  ...[...emailQueueIndex.values()].filter((item) => !emailQueueExistingKeys.has(item.email)),
];
const campaignOnlyEmailCount = emailIndexItems.filter((item) => item.classification === "campaign_import").length;
const emailIndexOutput = {
  ...emailIndexPayload,
  generated_at: generatedAt,
  counts: {
    ...(emailIndexPayload.counts || {}),
    emails: emailIndexItems.length,
    occurrences: emailIndexItems.reduce((sum, item) => sum + Number(item.occurrence_count || 0), 0),
    campaign_imported_emails: campaignOnlyEmailCount,
  },
  items: emailIndexItems,
};
const emailQueueOutput = {
  ...emailQueue,
  generated_at: generatedAt,
  counts: {
    ...(emailQueue.counts || {}),
    emails: emailQueueItems.length,
    occurrences: emailQueueItems.reduce((sum, item) => sum + Number(item.occurrence_count || 0), 0),
    campaign_imported_emails: campaignOnlyEmailCount,
  },
  items: emailQueueItems,
};
usagePayload.counts.indexed_emails = campaignEmails.filter((email) => emailIndex.has(email)).length;
usagePayload.counts.not_in_email_index = campaignEmails.filter((email) => !emailIndex.has(email)).length;
usagePayload.counts.campaign_imported_emails = campaignOnlyEmailCount;

const validationsByEmail = new Map(existingValidationByEmail);
for (const item of usageItems) {
  const indexed = emailIndex.get(item.email);
  const existing = validationsByEmail.get(item.email) || {};
  const timestamp = existing.updated_at || existing.reviewed_at || item.first_sent_at || generatedAt;
  validationsByEmail.set(item.email, {
    ...existing,
    email: item.email,
    display_value: existing.display_value || item.display_value || item.email,
    status: "valid",
    reviewed_by: existing.reviewed_by || "campaign-import",
    reviewed_at: existing.reviewed_at || timestamp,
    updated_at: existing.updated_at || timestamp,
    source: existing.source || "campaign-import",
    source_exports: sortedUnique([...(existing.source_exports || []), "campaign-csv-import"]),
    source_campaign_files: sortedUnique([...(existing.source_campaign_files || []), ...item.source_files]),
    source_campaign_lead_ids: sortedUnique([...(existing.source_campaign_lead_ids || []), ...item.lead_ids]),
    occurrence_count: existing.occurrence_count || indexed?.occurrence_count || null,
    clinic_id: existing.clinic_id || indexed?.clinic_id || null,
    contact_point_id: existing.contact_point_id || indexed?.contact_point_id || null,
    audit_flags: existing.audit_flags || [],
  });
}

const validations = [...validationsByEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
const seedPayload = {
  ...validationSeed,
  generated_at: generatedAt,
  source_exports: mergedSourceExports(validationSeed.source_exports, {
    name: "campaign-csv-import",
    path: campaignSources.join(","),
    exported_at: generatedAt,
    files: sourceFiles.length,
    emails: campaignEmails.length,
  }),
  counts: {
    validations: validations.length,
    indexed_validations: validations.filter((validation) => emailIndex.has(validation.email)).length,
    not_in_email_index: validations.filter((validation) => !emailIndex.has(validation.email)).length,
  },
  validations,
};

await Promise.all([
  writeFile(emailIndexPath, stringifyJson(emailIndexOutput, emailIndexDocument.pretty)),
  writeFile(emailQueuePath, stringifyJson(emailQueueOutput, emailQueueDocument.pretty)),
  writeFile(usagePath, `${JSON.stringify(usagePayload, null, 2)}\n`),
  writeFile(validationSeedPath, stringifyJson(seedPayload, validationSeedDocument.pretty)),
]);

console.log(`Imported ${campaignEmails.length} campaign emails from ${sourceFiles.length} files.`);
console.log(`Added ${importedEmailItems.length} campaign-only emails to the email dataset.`);
console.log(`Upserted ${upsertedCampaignOnlyEmailItems.length} campaign-only email dataset rows.`);
console.log(`Validation seed now has ${validations.length} validations (${seedPayload.counts.not_in_email_index} not in email index).`);

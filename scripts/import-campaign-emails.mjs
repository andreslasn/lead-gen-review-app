import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(tag, name) {
  const match = String(tag || "").match(new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

function columnIndex(cellReference) {
  const letters = String(cellReference || "").match(/^[A-Z]+/i)?.[0] || "";
  return [...letters.toUpperCase()].reduce((sum, character) => (sum * 26) + character.charCodeAt(0) - 64, 0) - 1;
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const item of String(xml || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const textParts = [...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1]));
    strings.push(textParts.length ? textParts.join("") : decodeXml(item[1].replace(/<[^>]*>/g, "")));
  }
  return strings;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of String(xml || "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attributes = cellMatch[1] || cellMatch[3] || "";
      const body = cellMatch[2] || "";
      const index = columnIndex(xmlAttribute(attributes, "r"));
      if (index < 0) continue;
      const type = xmlAttribute(attributes, "t");
      const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] || "";
      const inlineText = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join("");
      let value = "";
      if (type === "s") value = sharedStrings[Number(rawValue)] || "";
      else if (type === "inlineStr") value = inlineText;
      else value = decodeXml(rawValue);
      row[index] = value;
    }
    while (row.length && !String(row.at(-1) || "").trim()) row.pop();
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => String(value || "").trim()));
}

async function readZipEntry(file, entry, { optional = false } = {}) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", file, entry], { maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (optional) return "";
    throw err;
  }
}

async function xlsxWorksheets(file) {
  const [workbookXml, relationshipsXml] = await Promise.all([
    readZipEntry(file, "xl/workbook.xml"),
    readZipEntry(file, "xl/_rels/workbook.xml.rels"),
  ]);
  const relationshipById = new Map();
  for (const relationship of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attributes = relationship[1];
    const id = xmlAttribute(attributes, "Id");
    const target = xmlAttribute(attributes, "Target");
    if (id && target) relationshipById.set(id, target.startsWith("xl/") ? target : `xl/${target}`);
  }
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)].map((sheet, index) => {
    const attributes = sheet[1];
    const id = xmlAttribute(attributes, "r:id");
    const sheetName = xmlAttribute(attributes, "name") || `Sheet ${index + 1}`;
    return {
      sheet_name: sheetName,
      worksheet_path: relationshipById.get(id) || `xl/worksheets/sheet${index + 1}.xml`,
    };
  });
}

async function parseXlsx(file, worksheetPath) {
  const [sharedStringsXml, worksheetXml] = await Promise.all([
    readZipEntry(file, "xl/sharedStrings.xml", { optional: true }),
    readZipEntry(file, worksheetPath),
  ]);
  return parseWorksheetRows(worksheetXml, parseSharedStrings(sharedStringsXml));
}

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

function excelSerialDateToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 20000 || number > 70000) return "";
  return new Date(Math.round((number - 25569) * 86400 * 1000)).toISOString();
}

function spreadsheetIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  return Math.round(number).toString().padStart(9, "0");
}

function normalizeImportedRowObject(object) {
  const normalized = { ...object };
  if (normalized.registry_id) normalized.registry_id = spreadsheetIdentifier(normalized.registry_id);
  for (const key of ["reviewed_at", "sent_at", "last_event_at"]) {
    const converted = excelSerialDateToIso(normalized[key]);
    if (converted) normalized[key] = converted;
  }
  return normalized;
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
  async function addSourceFile(filePath, baseName = path.basename(filePath)) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".csv") {
      const key = filePath;
      if (seen.has(key)) return;
      seen.add(key);
      files.push({ type: "csv", file_name: baseName, path: filePath });
    } else if (extension === ".xlsx") {
      for (const sheet of await xlsxWorksheets(filePath)) {
        const key = `${filePath}#${sheet.worksheet_path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({
          type: "xlsx",
          file_name: `${baseName} - ${sheet.sheet_name}`,
          sheet_name: sheet.sheet_name,
          worksheet_path: sheet.worksheet_path,
          path: filePath,
        });
      }
    }
  }
  for (const source of sources) {
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      const directoryFiles = (await readdir(source))
        .filter((file) => [".csv", ".xlsx"].includes(path.extname(file).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      for (const file of directoryFiles) await addSourceFile(path.join(source, file), file);
    } else if (sourceStat.isFile()) {
      await addSourceFile(source);
    }
  }
  return files.sort((a, b) => a.file_name.localeCompare(b.file_name) || a.path.localeCompare(b.path));
}

async function campaignRows(file) {
  if (file.type === "xlsx") return parseXlsx(file.path, file.worksheet_path);
  return parseCsv(await readFile(file.path, "utf8"));
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
    reviewed_at: firstReviewTime(record),
    stage: record.row.Stage || null,
    company_name: firstValue(record.row, ["clinic_name", "companyName", "Company", "Organization - Name _", "Szolg_ltat_ neve"]) || null,
    person_name: firstValue(record.row, ["clinic_name", "Person - Name _", "H_ziorvos neve", "firstName", "cleanFirstName"]) || null,
    location: firstValue(record.row, ["county", "location", "Customer Type", "V_rmegye"]) || null,
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
    "county",
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
  const occurrenceCount = Math.max(1, ...records.map((record) => Number(record.row?.occurrence_count || 0)).filter(Number.isFinite));
  const name = firstValue(row, [
    "clinic_name",
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
    registry_id: firstValue(row, ["registry_id"]) || "",
    city: city || "",
    region: region || "",
    address: address || "",
  };
  return {
    email,
    display_value: records[0]?.display_value || email,
    occurrence_count: occurrenceCount,
    clinic_id: null,
    contact_point_id: null,
    name: name || "",
    registry_id: firstValue(row, ["registry_id"]) || "",
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
    region_occurrence_counts: region ? { [region]: occurrenceCount } : {},
    occurrences: [occurrence],
  };
}

function firstReviewTime(record) {
  return firstValue(record.row, ["reviewed_at"]) || null;
}

function mergeCampaignLists(existingCampaigns, incomingCampaigns) {
  const seen = new Set();
  return [...(existingCampaigns || []), ...(incomingCampaigns || [])].filter((campaign) => {
    const key = [
      campaign?.source_file,
      campaign?.row_number,
      campaign?.lead_id,
      campaign?.sent_at,
      campaign?.reviewed_at,
    ].filter(Boolean).join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeUsageItem(existing, incoming) {
  const campaigns = mergeCampaignLists(existing?.campaigns, incoming?.campaigns);
  const sent = sortedUnique(campaigns.map((campaign) => campaign.sent_at));
  const events = sortedUnique(campaigns.map((campaign) => campaign.last_event_at));
  const reviewed = sortedUnique(campaigns.map((campaign) => campaign.reviewed_at));
  return {
    ...(existing || {}),
    ...(incoming || {}),
    email: incoming?.email || existing?.email,
    display_value: existing?.display_value || incoming?.display_value || incoming?.email || existing?.email,
    used_in_campaign: true,
    campaign_count: campaigns.length || incoming?.campaign_count || existing?.campaign_count || 1,
    source_files: sortedUnique([...(existing?.source_files || []), ...(incoming?.source_files || [])]),
    lead_ids: sortedUnique([...(existing?.lead_ids || []), ...(incoming?.lead_ids || [])]),
    first_sent_at: sent[0] || existing?.first_sent_at || incoming?.first_sent_at || null,
    last_sent_at: sent.at(-1) || incoming?.last_sent_at || existing?.last_sent_at || null,
    last_event_at: events.at(-1) || sent.at(-1) || incoming?.last_event_at || existing?.last_event_at || null,
    first_reviewed_at: reviewed[0] || existing?.first_reviewed_at || incoming?.first_reviewed_at || null,
    last_reviewed_at: reviewed.at(-1) || incoming?.last_reviewed_at || existing?.last_reviewed_at || null,
    campaigns,
  };
}

function mergedUsageItems(existingItems, incomingItems) {
  const byEmail = new Map();
  for (const item of [...(existingItems || []), ...(incomingItems || [])]) {
    const email = normalizeEmailValue(item.email || item.display_value);
    if (!email) continue;
    byEmail.set(email, mergeUsageItem(byEmail.get(email), { ...item, email }));
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function sourceFileKey(file) {
  return [file?.file_name, file?.path, file?.sheet_name].filter(Boolean).join("|");
}

function mergedSourceFiles(existingSourceFiles, incomingSourceFiles) {
  const seen = new Set();
  return [...(existingSourceFiles || []), ...(incomingSourceFiles || [])].filter((file) => {
    const key = sourceFileKey(file);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const [emailIndexDocument, emailQueueDocument, validationSeedDocument, usageDocument] = await Promise.all([
  jsonDocument(emailIndexPath),
  jsonDocument(emailQueuePath),
  jsonDocument(validationSeedPath),
  jsonDocument(usagePath).catch(() => ({ data: {}, pretty: true })),
]);
const emailIndexPayload = emailIndexDocument.data;
const emailQueue = emailQueueDocument.data;
const validationSeed = validationSeedDocument.data;
const existingUsagePayload = usageDocument.data;
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
  const rows = await campaignRows(file);
  const header = (rows[0] || []).map((value) => String(value || "").trim());
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
      row: normalizeImportedRowObject(rowObject(header, row)),
    };
    if (!campaignRecordsByEmail.has(email)) campaignRecordsByEmail.set(email, []);
    campaignRecordsByEmail.get(email).push(record);
  }
  sourceFiles.push({
    file_name: file.file_name,
    path: file.path,
    type: file.type,
    sheet_name: file.sheet_name || null,
    row_count: Math.max(0, rows.length - 1),
    email_count: emails.length,
    unique_email_count: new Set(emails).size,
  });
}

const generatedAt = new Date().toISOString();
const campaignEmails = [...campaignRecordsByEmail.keys()].sort((a, b) => a.localeCompare(b));
const newUsageItems = campaignEmails.map((email) => {
  const records = campaignRecordsByEmail.get(email) || [];
  const campaigns = records.map(makeCampaignSummary);
  const sent = sortedUnique(campaigns.map((campaign) => campaign.sent_at));
  const events = sortedUnique(campaigns.map((campaign) => campaign.last_event_at));
  const reviewed = sortedUnique(campaigns.map((campaign) => campaign.reviewed_at));
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
    first_reviewed_at: reviewed[0] || null,
    last_reviewed_at: reviewed.at(-1) || null,
    campaigns,
  };
});

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

const usageItems = mergedUsageItems(existingUsagePayload.items || [], newUsageItems);
const allCampaignEmails = usageItems.map((item) => item.email);
const usageSourceInputs = sortedUnique([...(existingUsagePayload.source_inputs || []), ...campaignSources]);
const usageSourceFiles = mergedSourceFiles(existingUsagePayload.source_files || [], sourceFiles);
const usagePayload = {
  ...(existingUsagePayload || {}),
  format: "lead-gen-campaign-email-usage",
  schema_version: 1,
  dataset_id: emailQueue.dataset_id,
  dataset_version: emailQueue.dataset_version,
  generated_at: generatedAt,
  source_directory: usageSourceInputs.length === 1 ? usageSourceInputs[0] : null,
  source_inputs: usageSourceInputs,
  source_files: usageSourceFiles,
  counts: {
    source_files: usageSourceFiles.length,
    rows: usageSourceFiles.reduce((sum, file) => sum + Number(file.row_count || 0), 0),
    campaign_email_rows: usageSourceFiles.reduce((sum, file) => sum + Number(file.email_count || 0), 0),
    emails: allCampaignEmails.length,
    indexed_emails: allCampaignEmails.filter((email) => emailIndex.has(email)).length,
    not_in_email_index: allCampaignEmails.filter((email) => !emailIndex.has(email)).length,
    campaign_imported_emails: campaignOnlyEmailCount,
  },
  items: usageItems,
};

const validationsByEmail = new Map(existingValidationByEmail);
for (const item of newUsageItems) {
  const indexed = emailIndex.get(item.email);
  const existing = validationsByEmail.get(item.email) || {};
  const timestamp = existing.updated_at || existing.reviewed_at || item.first_reviewed_at || item.first_sent_at || generatedAt;
  validationsByEmail.set(item.email, {
    ...existing,
    email: item.email,
    display_value: existing.display_value || item.display_value || item.email,
    status: "valid",
    reviewed_by: existing.reviewed_by || "campaign-import",
    reviewed_at: existing.reviewed_at || timestamp,
    updated_at: existing.updated_at || timestamp,
    source: existing.source || "campaign-import",
    source_exports: sortedUnique([...(existing.source_exports || []), "campaign-import"]),
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
    name: "campaign-import",
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
console.log(`Campaign usage now has ${usageItems.length} total used emails from ${usageSourceFiles.length} source files.`);
console.log(`Added ${importedEmailItems.length} campaign-only emails to the email dataset.`);
console.log(`Upserted ${upsertedCampaignOnlyEmailItems.length} campaign-only email dataset rows.`);
console.log(`Validation seed now has ${validations.length} validations (${seedPayload.counts.not_in_email_index} not in email index).`);

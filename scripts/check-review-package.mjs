import { decodeReviewArtifact, parseAccountIndex, validateAccountPackage, decodeAccountEvidence, mergeFieldEvents, mergeContactPreferences, loadAccountEvidence, validateWebpageReviewExport } from "../src/accountEvidence.js";
import { validateAssociationPackage, validateAssociationDecision } from "../src/associations.js";
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
  "email-index.json",
  "email-review-queue.json",
  "email-validation-seed.json",
  "campaign-email-usage.json",
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
    const text=await readFile(path.join(root, relative), "utf8");
    const value=relative.endsWith('account-enrichment.json')?await parseAccountIndex(text):JSON.parse(text);
    if(relative.endsWith('account-enrichment.json'))for(const [name,pattern] of secretPatterns)if(pattern.test(JSON.stringify(value)))fail(name+' detected in decoded research index');
    return value;
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
    const original = /^(?:clinics\/|sources\/(?:review_text|raw_html)\/)/.test(relative)
      ? Buffer.from(await decodeReviewArtifact(await readFile(file,'utf8')),'utf8') : null;
    const size = original ? original.length : (await stat(file)).size;
    const fileHash = original ? `sha256:${createHash('sha256').update(original).digest('hex')}` : await sha256(file);
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
  if (/^(?:clinics\/|sources\/(?:review_text|raw_html)\/)/.test(path.relative(root,file).split(path.sep).join('/'))) {
    const decoded=await decodeReviewArtifact(await readFile(file,'utf8'));
    for(const [name,pattern] of secretPatterns)if(pattern.test(decoded))fail(`${name} detected in decoded review artifact`);
  }
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
const emailIndex = await json("email-index.json");
const emailReviewQueue = await json("email-review-queue.json");
const emailValidationSeed = await json("email-validation-seed.json");
const campaignEmailUsage = await json("campaign-email-usage.json");
const integrity = await json("package-integrity.json");
try {
  await stat(path.join(root,"email-associations.json"));
  validateAssociationPackage(await json("email-associations.json"),manifest);
  await scanSecrets(path.join(root,"email-associations.json"));
} catch(error) { if(error.code !== "ENOENT") throw error; }
try {
  await stat(path.join(root,'account-enrichment.json'));
  const accountPackage=validateAccountPackage(await json('account-enrichment.json'),manifest);
  if(accountPackage.evidence_storage==='account-files-v1') {
    for(const account of accountPackage.accounts) {
      if(!/^account-evidence\/[A-Z0-9]{4}-[a-f0-9]{16}\.json$/.test(account.evidence_path||''))fail('invalid account evidence path');
      const payload=await readFile(path.join(root,account.evidence_path));
      if(createHash('sha256').update(payload).digest('hex')!==account.evidence_sha256)fail('account evidence hash mismatch');
      const decoded=await decodeAccountEvidence(payload.toString('utf8'),account.evidence_encoding);
      for(const [name,pattern] of secretPatterns)if(pattern.test(decoded))fail(`${name} detected in decoded account evidence`);
      const detail=JSON.parse(decoded);
      if(detail.account_key!==account.account_key||JSON.stringify(detail.claims.map(c=>c.claim_id))!==JSON.stringify(account.claims.map(c=>c.claim_id)))fail('account evidence identity mismatch');
      validateAccountPackage({...accountPackage,evidence_storage:undefined,accounts:[detail]},manifest);
      await scanSecrets(path.join(root,account.evidence_path));
    }
  }
  await scanSecrets(path.join(root,'account-enrichment.json'));
} catch(error) {if(error.code!=='ENOENT')throw error;}
const canonical = await json("canonical-review-state.json");
for(const country of ['LV','PL']){
let hasMarket=false;
try{await stat(path.join(root,'markets/'+country));hasMarket=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(hasMarket){
  const prefix='markets/'+country+'/',meta=await json(prefix+'manifest.json'),pkg=validateAccountPackage(await json(prefix+'account-enrichment.json'),meta);
  if(pkg.country!==country)fail('Latvia package country mismatch');
  const status=await json(prefix+'account-research-status.json');
  if(['dataset_id','base_data_hash','research_snapshot_id'].some(k=>pkg[k]!==status[k]))fail('Latvia research status mismatch');
  const accounts=[];
  for(const account of pkg.accounts){
    const detail=await loadAccountEvidence(pkg,account,relative=>readFile(path.join(root,prefix,relative),'utf8'));
    const decoded=JSON.stringify(detail);for(const [name,pattern] of secretPatterns)if(pattern.test(decoded))fail(name+' detected in Latvia evidence');
    accounts.push(detail);
  }
  let state;
  try{state=await json(prefix+'canonical-review-state.json');}catch(error){if(!error.message.includes('ENOENT'))throw error;}
  if(state)validateWebpageReviewExport(state,{...pkg,accounts});
  await scanSecrets(path.join(root,prefix,'account-enrichment.json'));
}
}
mergeFieldEvents([],canonical.field_decisions||[]);
mergeContactPreferences([],canonical.contact_preferences||[]);
for(const event of canonical.association_decisions || []) validateAssociationDecision(event);

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
const emailItems = emailIndex.items || [];
const emailQueueItems = emailReviewQueue.items || [];
const emailValidations = emailValidationSeed.validations || [];
const expectedClinics = Number(manifest.counts?.clinics || 0);
if (queueItems.length !== expectedClinics || indexItems.length < expectedClinics) fail("clinic counts are inconsistent");
if (emailIndex.format !== "lead-gen-email-index" || emailIndex.schema_version !== 1) fail("unsupported email index contract");
if (emailReviewQueue.format !== "lead-gen-email-review-queue" || emailReviewQueue.schema_version !== 1) fail("unsupported email review queue contract");
if (emailValidationSeed.format !== "lead-gen-email-validation-seed" || emailValidationSeed.schema_version !== 1) fail("unsupported email validation seed contract");
if (campaignEmailUsage.format !== "lead-gen-campaign-email-usage" || campaignEmailUsage.schema_version !== 1) fail("unsupported campaign email usage contract");
if (emailIndex.dataset_id !== manifest.dataset_id || emailReviewQueue.dataset_id !== manifest.dataset_id || emailValidationSeed.dataset_id !== manifest.dataset_id) fail("email data dataset mismatch");
if (campaignEmailUsage.dataset_id !== manifest.dataset_id) fail("campaign email usage dataset mismatch");
if (!emailItems.length || Number(emailIndex.counts?.emails || 0) !== emailItems.length) fail("email index counts are inconsistent");
if (emailQueueItems.length !== emailItems.length || Number(emailReviewQueue.counts?.emails || 0) !== emailQueueItems.length) fail("email review queue counts are inconsistent");
if (!emailValidations.length) fail("email validation seed is empty");
const queueIds = queueItems.map((item) => String(item.id || ""));
const indexIds = indexItems.map((item) => String(item.id || ""));
if (new Set(queueIds).size !== queueIds.length || new Set(indexIds).size !== indexIds.length) fail("duplicate clinic IDs");
const indexSet = new Set(indexIds);
if (queueIds.some((id) => !indexSet.has(id))) fail("queue contains clinics absent from the market index");
const emailValues = emailItems.map((item) => String(item.email || ""));
const emailValueSet = new Set(emailValues);
if (emailValueSet.size !== emailValues.length || emailValues.some((email) => !email.includes("@"))) fail("email index contains duplicate or invalid email keys");
const emailQueueValues = emailQueueItems.map((item) => String(item.email || ""));
if (new Set(emailQueueValues).size !== emailQueueValues.length || emailQueueValues.some((email) => !email.includes("@"))) fail("email review queue contains duplicate or invalid email keys");
if (emailQueueValues.some((email) => !emailValueSet.has(email))) fail("email review queue contains emails absent from full email index");
const campaignEmails = (campaignEmailUsage.items || []).map((item) => String(item.email || ""));
if (new Set(campaignEmails).size !== campaignEmails.length || campaignEmails.some((email) => !email.includes("@"))) fail("campaign email usage contains duplicate or invalid emails");
if (campaignEmails.some((email) => !emailValueSet.has(email))) fail("campaign email usage contains emails absent from full email index");
const emailClinicIds = new Set(emailItems.flatMap((item) => (item.occurrences || []).map((occurrence) => String(occurrence.clinic_id || ""))));
if ([...emailClinicIds].some((id) => id && !indexSet.has(id))) fail("email index references unknown clinic IDs");

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
if (JSON.stringify(clinicTree) !== JSON.stringify(integrity.trees?.clinics)) {
  fail(`clinic payload tree drift; expected ${JSON.stringify(integrity.trees?.clinics)}, received ${JSON.stringify(clinicTree)}`);
}
if (JSON.stringify(evidenceTree) !== JSON.stringify(integrity.trees?.evidence)) {
  fail(`evidence artifact tree drift; expected ${JSON.stringify(integrity.trees?.evidence)}, received ${JSON.stringify(evidenceTree)}`);
}

for (const file of [...clinicFiles, ...evidenceFiles, ...requiredFiles.map((name) => path.join(root, name))]) {
  await scanSecrets(file);
}

console.log(`Review package OK: ${manifest.dataset_id} · ${expectedClinics} clinics · ${integrity.package_fingerprint}`);

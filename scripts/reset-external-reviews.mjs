import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeEmailValidations, mergeReviewResets } from '../src/emailValidations.js';

const [repo = '.', backupDirectory, action] = process.argv.slice(2);
if (!backupDirectory || action !== '--apply') throw Error('Usage: node scripts/reset-external-reviews.mjs <repo> <private-backup-directory> --apply');
const directory = path.resolve(repo, 'public/data'), backup = path.resolve(backupDirectory);
if (backup.startsWith(path.resolve(repo) + path.sep)) throw Error('Backups must be outside the published repository.');
const names = ['email-validation-seed.json', 'campaign-email-usage.json', 'package-integrity.json', 'review-export.schema.json'];
const original = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))])));
const seed = JSON.parse(original[names[0]]), usage = JSON.parse(original[names[1]]);
const id = 'external-reviewer-2026-09-21';
if ((seed.review_resets || []).some(reset => reset.id === id)) {
  console.log('External reviewer reset already exists; no files changed.');
  process.exit(0);
}
const used = new Set(usage.items.filter(item => item.used_in_campaign).map(item => item.email));
const targeted = seed.validations.filter(value => value.status === 'valid' && value.reviewed_by === 'external-reviewer' && value.source !== 'manual');
if (targeted.length !== 1343 || targeted.filter(value => !used.has(value.email)).length !== 195) throw Error('The reviewed reset cohort changed; inspect the new counts before resetting.');
const reset = {
  id, dataset_id: seed.dataset_id, created_at: new Date().toISOString(), reviewed_by: 'external-reviewer',
  reason: 'Requested re-review of imported external-reviewer approvals.',
  source_seed_sha256: createHash('sha256').update(original[names[0]]).digest('hex'),
  targets: targeted.map(value => ({email: value.email, decision_ids: value.source_decision_ids || [], recheck: !used.has(value.email)})).sort((a,b) => a.email.localeCompare(b.email)),
};
seed.review_resets = mergeReviewResets(seed.dataset_id, seed.review_resets || [], [reset]);
seed.validations = mergeEmailValidations(seed.review_resets, seed.validations);
seed.generated_at = reset.created_at;
const schema = JSON.parse(original[names[3]]);
schema.properties.email_review_resets = {
  type: 'array', description: 'Immutable approval withdrawals; older imports must preserve existing reset policy.',
  items: {type: 'object', required: ['id','dataset_id','created_at','reviewed_by','targets'], properties: {
    id: {type:'string'}, dataset_id:{type:'string'}, created_at:{type:'string',format:'date-time'}, reviewed_by:{type:'string'},
    targets:{type:'array',items:{type:'object',required:['email','decision_ids','recheck'],properties:{email:{type:'string'},decision_ids:{type:'array',items:{type:'string'}},recheck:{type:'boolean'}}}},
  }},
};
const serialize = value => Buffer.from(JSON.stringify(value,null,2)+'\n');
const output = {'email-validation-seed.json':serialize(seed),'review-export.schema.json':serialize(schema)};
const integrity = JSON.parse(original[names[2]]);
for (const [name,bytes] of Object.entries(output)) integrity.required_files[name] = 'sha256:'+createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']' : value && typeof value === 'object'
  ? '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}' : JSON.stringify(value);
const fingerprint = {...integrity}; delete fingerprint.package_fingerprint;
integrity.package_fingerprint = 'sha256:'+createHash('sha256').update(stable(fingerprint)).digest('hex');
output['package-integrity.json'] = serialize(integrity);
await mkdir(backup,{recursive:true,mode:0o700});
for (const name of Object.keys(output)) {
  await writeFile(path.join(backup,name),original[name],{mode:0o600,flag:'wx'});
  await writeFile(path.join(directory,name+'.tmp'),output[name]);
}
for (const name of Object.keys(output)) await rename(path.join(directory,name+'.tmp'),path.join(directory,name));
console.log(JSON.stringify({reset:id,unreviewed:targeted.length,recheck:reset.targets.filter(target=>target.recheck).length,campaign_usage_changed:false}));

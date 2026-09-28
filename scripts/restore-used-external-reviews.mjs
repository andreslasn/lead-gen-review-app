import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mergeEmailValidations } from '../src/emailValidations.js';

const [repo = '.', backupDirectory, action] = process.argv.slice(2);
if (!backupDirectory || action !== '--apply') throw Error('Usage: node scripts/restore-used-external-reviews.mjs <repo> <private-backup-directory> --apply');
const root = path.resolve(repo), backup = path.resolve(backupDirectory);
if (backup.startsWith(root + path.sep)) throw Error('Backup must be outside the published repository.');
const directory = path.join(root, 'public/data');
const names = ['email-validation-seed.json', 'campaign-email-usage.json', 'package-integrity.json'];
const original = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))])));
const seed = JSON.parse(original[names[0]]), usage = JSON.parse(original[names[1]]), integrity = JSON.parse(original[names[2]]);
const reset = (seed.review_resets || []).find(value => value.id === 'external-reviewer-2026-09-21');
if (!reset || reset.dataset_id !== seed.dataset_id) throw Error('Expected external reviewer reset is missing.');
const targets = reset.targets.filter(value => !value.recheck);
if (reset.targets.length !== 1343 || targets.length !== 1148) throw Error('Reset cohort changed; inspect it before restoring.');
const used = new Set(usage.items.filter(value => value.used_in_campaign).map(value => value.email));
const validations = new Map(seed.validations.map(value => [value.email, value]));
const existing = targets.filter(target => ['review-reset-restoration', 'manual'].includes(validations.get(target.email)?.source));
if (existing.length === targets.length) {
  console.log('Used approval restorations already exist; no files changed.');
  process.exit(0);
}
if (existing.length) throw Error('Partial restoration; inspect the seed before retrying.');
const restoredAt = new Date().toISOString();
const restorations = targets.map(target => {
  const value = validations.get(target.email);
  if (!used.has(target.email) || !target.decision_ids.length || !value
    || value.status !== 'unreviewed' || value.source !== 'review-reset'
    || value.review_reset_id !== reset.id || value.previous_review_status !== 'valid'
    || value.reviewed_by !== reset.reviewed_by
    || !(value.source_decision_ids || []).some(id => target.decision_ids.includes(id))) {
    throw Error('A used address lacks matching withdrawn approval evidence; no files changed.');
  }
  return { ...value, status: 'valid', source: 'review-reset-restoration',
    restored_review_reset_id: reset.id, restored_at: restoredAt };
});
seed.validations = mergeEmailValidations(seed.review_resets, seed.validations, restorations)
  .sort((a, b) => a.email.localeCompare(b.email));
if (restorations.some(value => seed.validations.find(item => item.email === value.email)?.status !== 'valid')) {
  throw Error('Restoration failed resolution; no files changed.');
}
seed.generated_at = restoredAt;
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const seedBytes = serialize(seed);
integrity.required_files['email-validation-seed.json'] = 'sha256:' + createHash('sha256').update(seedBytes).digest('hex');
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  : JSON.stringify(value);
const fingerprint = { ...integrity }; delete fingerprint.package_fingerprint;
integrity.package_fingerprint = 'sha256:' + createHash('sha256').update(stable(fingerprint)).digest('hex');
await mkdir(backup, { recursive: true, mode: 0o700 });
for (const name of names) await writeFile(path.join(backup, name), original[name], { mode: 0o600, flag: 'wx' });
for (const [name, bytes] of [['email-validation-seed.json', seedBytes], ['package-integrity.json', serialize(integrity)]]) {
  await writeFile(path.join(directory, name + '.tmp'), bytes);
  await rename(path.join(directory, name + '.tmp'), path.join(directory, name));
}
console.log(JSON.stringify({ restored_used_approvals: restorations.length, recheck_targets_unchanged: 195, campaign_usage_changed: false }));

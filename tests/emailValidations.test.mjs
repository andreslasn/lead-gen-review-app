import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mergeEmailValidations, mergeReviewResets, reviewResetTargets } from '../src/emailValidations.js';

const email = 'target@example.invalid';
const reset = { id: 'synthetic-reset', dataset_id: 'synthetic', created_at: '2026-09-21T08:00:00Z', reviewed_by: 'external-reviewer',
  targets: [{ email, decision_ids: ['old-approval'], recheck: true }] };
const old = { email, status: 'valid', source: 'legacy-decision', reviewed_by: 'external-reviewer',
  updated_at: '2026-07-30T00:00:00Z', source_decision_ids: ['old-approval'] };
const resolve = (...lists) => mergeEmailValidations([reset], ...lists);
const repo = fileURLToPath(new URL('../', import.meta.url));

test('withdrawn approvals stay pending through old browser migration and repeated imports', () => {
  const [pending] = resolve([old]);
  assert.equal(pending.status, 'unreviewed');
  assert.equal(pending.previous_review_status, 'valid');
  assert.deepEqual(pending.source_decision_ids, old.source_decision_ids);
  assert.equal(resolve([pending], [old])[0].status, 'unreviewed');
  assert.equal(resolve([pending], [{ ...old, updated_at: '2026-10-01T00:00:00Z' }])[0].status, 'unreviewed');
  assert.equal(resolve([{ ...old, source_decision_ids: [] }])[0].status, 'unreviewed');
  assert.equal(reviewResetTargets([reset]).get(email)[0].recheck, true);
});

test('human re-reviews, invalid decisions and unrelated addresses survive reset in either merge order', () => {
  for (const human of [
    { ...old, source: 'manual', reviewed_by: 'reviewer', updated_at: '2026-09-20T00:00:00Z' },
    { ...old, source: 'manual', status: 'invalid', updated_at: '2026-09-22T00:00:00Z' },
    { ...old, source: 'manual', status: 'unreviewed', updated_at: '2026-09-22T00:00:00Z' },
    { ...old, source: 'legacy-decision', reviewed_by: 'reviewer', source_decision_ids: ['independent-review'] },
    { ...old, status: 'invalid' },
  ]) {
    assert.equal(resolve([human], [old])[0].status, human.status);
    assert.equal(resolve([old], [human])[0].status, human.status);
  }
  assert.equal(resolve([{ ...old, email: 'other@example.invalid' }])[0].status, 'valid');
  const later = { ...old, source_decision_ids: ['new-approval'], updated_at: '2026-09-22T00:00:00Z' };
  assert.equal(resolve([old], [later])[0].status, 'valid');
});

test('reset metadata survives older exports; conflicting or malformed policies fail closed', () => {
  assert.deepEqual(mergeReviewResets('synthetic', [reset], [], [structuredClone(reset)]), [reset]);
  assert.throws(() => mergeReviewResets('synthetic', [reset], [{ ...reset, targets: [] }]), /Conflicting/);
  assert.throws(() => mergeReviewResets('other-dataset', [reset]), /identity/);
  assert.throws(() => mergeReviewResets('synthetic', [{ ...reset, targets: [reset.targets[0], reset.targets[0]] }]), /target/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-reset-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'public/data'); await mkdir(data, { recursive: true });
  const save = async (name, value) => writeFile(path.join(data, name), JSON.stringify(value));
  const load = async name => JSON.parse(await readFile(path.join(data, name), 'utf8'));
  const canonical = { format: 'lead-gen-clinic-review', schema_version: 1, dataset_id: 'synthetic',
    base_data_hash: 'hash', exported_at: '2026-09-14T00:00:00Z', decisions: [], clinic_states: [], audit_events: [] };
  await save('canonical-review-state.json', canonical);
  await save('email-validation-seed.json', { format: 'lead-gen-email-validation-seed', schema_version: 1,
    dataset_id: 'synthetic', review_resets: [reset], validations: resolve([old]) });
  await save('email-index.json', { dataset_id: 'synthetic', items: [{ email }] });
  await save('email-review-queue.json', { dataset_id: 'synthetic', items: [{ email }] });
  await save('package-integrity.json', { required_files: {} });
  return { root, data, save, load, canonical };
}

test('review import keeps policy, rejects stale approvals, accepts human review and rejects conflicts before writes', async t => {
  const f = await fixture(t), file = path.join(f.root, 'review.json');
  const run = () => execFileSync(process.execPath, [path.join(repo, 'scripts/import-review-export.mjs'), f.root, file], { stdio: 'pipe' });
  await writeFile(file, JSON.stringify({ ...f.canonical, email_validations: [old], decisions: [{ id: 'old-approval',
    decision: 'confirmed', reviewed_value: email, reviewer_id: 'external-reviewer', created_at: old.updated_at }] }));
  run();
  assert.equal((await f.load('email-validation-seed.json')).validations[0].status, 'unreviewed');
  assert.deepEqual((await f.load('canonical-review-state.json')).email_review_resets, [reset]);
  await writeFile(file, JSON.stringify({ ...f.canonical, email_validations: [{ ...old, source: 'manual', reviewed_by: 'reviewer' }] }));
  run();
  assert.equal((await f.load('email-validation-seed.json')).validations[0].status, 'valid');
  assert.deepEqual((await f.load('email-validation-seed.json')).review_resets, [reset]);
  const before = await readFile(path.join(f.data, 'email-validation-seed.json'), 'utf8');
  await writeFile(file, JSON.stringify({ ...f.canonical, email_review_resets: [{ ...reset, targets: [] }] }));
  assert.throws(run, /Conflicting email review reset/);
  assert.equal(await readFile(path.join(f.data, 'email-validation-seed.json'), 'utf8'), before);
});

test('campaign import records usage without approving pending, invalid or new addresses', async t => {
  const f = await fixture(t), seed = await f.load('email-validation-seed.json');
  seed.validations.push({ email: 'invalid@example.invalid', status: 'invalid', source: 'manual' });
  await f.save('email-validation-seed.json', seed);
  const before = await readFile(path.join(f.data, 'email-validation-seed.json'), 'utf8');
  const csv = path.join(f.root, 'campaign.csv');
  await writeFile(csv, `email\n${email}\ninvalid@example.invalid\nnew@example.invalid\n`);
  execFileSync(process.execPath, [path.join(repo, 'scripts/import-campaign-emails.mjs'), f.root, csv], { stdio: 'pipe' });
  assert.equal(await readFile(path.join(f.data, 'email-validation-seed.json'), 'utf8'), before);
  const usage = await f.load('campaign-email-usage.json');
  assert.equal(usage.items.length, 3);
  assert.ok(usage.items.every(item => item.used_in_campaign));
});

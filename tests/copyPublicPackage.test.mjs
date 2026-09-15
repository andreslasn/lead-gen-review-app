import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decodeAccountEvidence } from '../src/accountEvidence.js';
import { copyPublicPackage } from '../scripts/copy-public-package.mjs';

test('build retains the selected evidence and ordinary assets without copying historical snapshots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'public'), destination = path.join(root, 'dist');
  await mkdir(path.join(source, 'data/account-evidence'), { recursive: true });
  const selected = 'account-evidence/A001-aaaaaaaaaaaaaaaa.json';
  const historical = 'account-evidence/A001-bbbbbbbbbbbbbbbb.json';
  const status = { dataset_id: 'test', base_data_hash: 'hash', research_snapshot_id: 'snapshot' };
  const payload = JSON.stringify({ account_key: 'HU:A001', claims: [{ claim_id: 'unchanged' }] });
  const hash = createHash('sha256').update(payload).digest('hex');
  const index = { ...status, evidence_storage: 'account-files-v1', accounts: [{ evidence_path: selected, evidence_sha256: hash }] };
  for (const [file, value] of Object.entries({
    'data/account-enrichment.json': JSON.stringify(index),
    'data/account-research-status.json': JSON.stringify(status),
    ['data/' + selected]: payload, ['data/' + historical]: 'historical', 'logo.svg': '<svg/>',
  })) await writeFile(path.join(source, file), value);
  await copyPublicPackage(source, destination);
  const built = JSON.parse(await readFile(path.join(destination, 'data/account-enrichment.json'), 'utf8'));
  const account = built.accounts[0];
  assert.equal(built.research_snapshot_id, index.research_snapshot_id);
  assert.equal(account.evidence_encoding, 'gzip-base64-v1');
  const encoded = await readFile(path.join(destination, 'data', account.evidence_path), 'utf8');
  assert.equal(createHash('sha256').update(encoded).digest('hex'), account.evidence_sha256);
  assert.equal(await decodeAccountEvidence(encoded, account.evidence_encoding), payload);
  assert.equal(await readFile(path.join(source, 'data', selected), 'utf8'), payload);
  assert.deepEqual(JSON.parse(await readFile(path.join(source, 'data/account-enrichment.json'), 'utf8')), index);
  assert.equal(await readFile(path.join(destination, 'logo.svg'), 'utf8'), '<svg/>');
  await assert.rejects(readFile(path.join(destination, 'data', historical)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(source, 'data', historical), 'utf8'), 'historical');
  await assert.rejects(copyPublicPackage(source, destination, { maxBytes: 1 }), /publication budget/);
  await writeFile(path.join(source, 'data/account-research-status.json'), JSON.stringify({ ...status, research_snapshot_id: 'changed' }));
  await assert.rejects(copyPublicPackage(source, destination), /publication changed/);
  await writeFile(path.join(source, 'data/account-research-status.json'), JSON.stringify(status));
  await writeFile(path.join(source, 'data', selected), 'corrupt');
  await assert.rejects(copyPublicPackage(source, destination), /evidence changed/);
  await rm(path.join(source, 'data', selected));
  await assert.rejects(copyPublicPackage(source, destination), { code: 'ENOENT' });
});

import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeAccountEvidence } from './copy-public-package.mjs';
import { decodeAccountEvidence, parseAccountIndex, validEvidencePath } from '../src/accountEvidence.js';

const compress = promisify(gzip), decompress = promisify(gunzip);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// The archive must be outside the repository. Raw clinic sources and review
// decisions are untouched. Interrupted runs can repeat every step safely.
export async function compactResearchPackage(root, archive) {
  root = path.resolve(root); archive = path.resolve(archive);
  const repo = path.resolve(root, '../..');
  if (archive === repo || archive.startsWith(repo + path.sep)) throw Error('Use a private archive outside the repository.');
  const indexPath = path.join(root, 'account-enrichment.json');
  const original = await readFile(indexPath), index = await parseAccountIndex(original.toString('utf8'));
  const status = JSON.parse(await readFile(path.join(root, 'account-research-status.json')));
  if (index.evidence_storage !== 'account-files-v1' || ['dataset_id', 'base_data_hash', 'research_snapshot_id'].some(k => !index[k] || index[k] !== status[k])) throw Error('Research publication changed; retry.');
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await writeFile(path.join(archive, `index-${hash(original)}.json.gz`), await compress(original), { mode: 0o600 });
  let originalBytes = 0, currentBytes = 0;
  // Validate everything before changing the index or removing any old file.
  for (const account of index.accounts) {
    if (!validEvidencePath(account.evidence_path)) throw Error('Invalid account evidence reference.');
    const payload = await readFile(path.join(root, account.evidence_path));
    const encoded = await encodeAccountEvidence(payload, account);
    const decoded = await decodeAccountEvidence(encoded.toString('utf8'), 'gzip-base64-v1');
    const detail = JSON.parse(decoded);
    if (detail.account_key !== account.account_key || JSON.stringify(detail.claims.map(c => c.claim_id)) !== JSON.stringify(account.claims.map(c => c.claim_id))) throw Error('Account evidence identity mismatch.');
    const sha = hash(encoded), name = account.evidence_path.replace(/-[a-f0-9]{16}\.json$/,`-${sha.slice(0,16)}.json`);
    const temporary = path.join(root, name + '.compact.tmp');
    await writeFile(temporary, encoded);
    await rename(temporary, path.join(root, name));
    Object.assign(account, { evidence_path: name, evidence_sha256: sha, evidence_encoding: 'gzip-base64-v1' });
    originalBytes += payload.length; currentBytes += encoded.length;
  }
  if (!(await readFile(indexPath)).equals(original)) throw Error('Research publication changed; retry.');
  await writeFile(indexPath + '.compact.tmp', JSON.stringify(index) + '\n');
  await rename(indexPath + '.compact.tmp', indexPath);
  const { archivedFiles, archivedBytes } = await archiveObsoleteEvidence(root, archive, index);
  const report = { accounts: index.accounts.length, originalBytes, currentBytes, archivedFiles, archivedBytes, snapshot: index.research_snapshot_id };
  await writeFile(path.join(archive, `compaction-${hash(original)}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

export async function archiveObsoleteEvidence(root, archive, index) {
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const selected = new Set(index.accounts.map(a => path.basename(a.evidence_path)));
  let archivedFiles = 0, archivedBytes = 0;
  for (const name of await readdir(path.join(root, 'account-evidence'))) {
    if (!/^(?:[A-Z0-9]{4}|(?:LV|PL)-[a-f0-9]{20})-[a-f0-9]{16}\.json$/.test(name) || selected.has(name)) continue;
    const source = path.join(root, 'account-evidence', name), destination = path.join(archive, name + '.gz');
    const bytes = await readFile(source);
    let saved;
    try { saved = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!saved) {
      saved = await compress(bytes, { level: 6 });
      await writeFile(destination + '.tmp', saved, { mode: 0o600 });
      await rename(destination + '.tmp', destination);
    }
    if (!(await decompress(saved)).equals(bytes)) throw Error('Archive verification failed; original preserved.');
    await rm(source);
    archivedFiles++; archivedBytes += bytes.length;
  }
  return { archivedFiles, archivedBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('Usage: npm run compact:research -- /absolute/private/archive [public/data]');
  console.log(JSON.stringify(await compactResearchPackage(process.argv[3] || 'public/data', process.argv[2])));
}

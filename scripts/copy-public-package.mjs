import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const compress = promisify(gzip);

async function directorySize(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await directorySize(file) : (await stat(file)).size;
  }
  return bytes;
}

export async function copyPublicPackage(source, destination, { maxBytes = 1_000_000_000 } = {}) {
  const indexText = await readFile(path.join(source, 'data/account-enrichment.json'), 'utf8');
  const statusText = await readFile(path.join(source, 'data/account-research-status.json'), 'utf8');
  const index = JSON.parse(indexText), status = JSON.parse(statusText);
  for (const key of ['dataset_id', 'base_data_hash', 'research_snapshot_id']) {
    if (!index[key] || index[key] !== status[key]) throw Error('Research publication changed during build; retry.');
  }
  const selected = [];
  if (index.evidence_storage === 'account-files-v1') {
    for (const account of index.accounts) {
      if (!/^account-evidence\/[A-Z0-9]{4}-[a-f0-9]{16}\.json$/.test(account.evidence_path || '')) throw Error('Invalid account evidence reference.');
      selected.push(account);
    }
  }
  await cp(source, destination, {
    recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: file => {
      const relative = path.relative(source, file).split(path.sep).join('/');
      if (['data/account-enrichment.json', 'data/account-research-status.json'].includes(relative)) return false;
      return !relative.startsWith('data/account-evidence/');
    },
  });
  await mkdir(path.join(destination, 'data/account-evidence'), { recursive: true });
  // Keep source JSON untouched; only the Pages artifact uses lossless compression.
  // Bound concurrency so large accounts do not accumulate in memory.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const account = selected[next++];
      const payload = await readFile(path.join(source, 'data', account.evidence_path));
      if (createHash('sha256').update(payload).digest('hex') !== account.evidence_sha256) throw Error('Account evidence changed during build; retry.');
      if (account.evidence_encoding != null) throw Error('Build requires the original JSON evidence package.');
      const data = (await compress(payload, { level: 9 })).toString('base64');
      const encoded = JSON.stringify({ format: 'lead-gen-account-evidence-gzip', schema_version: 1, data }) + '\n';
      const hash = createHash('sha256').update(encoded).digest('hex');
      account.evidence_path = `account-evidence/${account.evidence_path.split('/').at(-1).slice(0, 4)}-${hash.slice(0, 16)}.json`;
      account.evidence_sha256 = hash;
      account.evidence_encoding = 'gzip-base64-v1';
      await writeFile(path.join(destination, 'data', account.evidence_path), encoded);
    }
  }));
  await mkdir(path.join(destination, 'data'), { recursive: true });
  await writeFile(path.join(destination, 'data/account-enrichment.json'), JSON.stringify(index) + '\n');
  await writeFile(path.join(destination, 'data/account-research-status.json'), statusText);
  const size = await directorySize(destination);
  if (size >= maxBytes) throw Error(`Review site is ${size} bytes; exceeds the ${maxBytes}-byte publication budget. Existing deployment is unchanged.`);
  console.log(`Review site size: ${size} bytes (budget ${maxBytes}).`);
}

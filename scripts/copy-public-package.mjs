import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {decodeReviewArtifact,parseAccountIndex,validEvidencePath} from '../src/accountEvidence.js';

const compress = promisify(gzip);

export async function encodeAccountEvidence(payload, account) {
  if (createHash('sha256').update(payload).digest('hex') !== account.evidence_sha256) throw Error('Account evidence changed; retry.');
  if (account.evidence_encoding === 'gzip-base64-v1') return payload;
  if (account.evidence_encoding != null) throw Error('Unsupported account evidence encoding.');
  const data = (await compress(payload, { level: 9 })).toString('base64');
  return Buffer.from(JSON.stringify({ format: 'lead-gen-account-evidence-gzip', schema_version: 1, data }) + '\n');
}

export async function encodeReviewArtifact(payload) {
  const text=payload.toString('utf8'),decoded=await decodeReviewArtifact(text);
  if(decoded!==text)return payload;
  return encodeAccountEvidence(payload,{evidence_sha256:createHash('sha256').update(payload).digest('hex')});
}

async function directorySize(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await directorySize(file) : (await stat(file)).size;
  }
  return bytes;
}

export async function copyPublicPackage(source, destination, { maxBytes = 1_000_000_000 } = {}) {
  const roots=['data'];
  const artifacts=['data/clinics','data/sources/review_text','data/sources/raw_html'];
  for(const country of ['LV','PL','RO'])try {await stat(path.join(source,'data/markets/'+country));roots.push('data/markets/'+country);}catch(error){if(error.code!=='ENOENT')throw error;}
  await cp(source, destination, {
    recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: file => {
      const relative = path.relative(source, file).split(path.sep).join('/');
      return !artifacts.some(root=>relative===root||relative.startsWith(root+'/')) && !roots.some(root=>[root+'/account-enrichment.json',root+'/account-research-status.json'].includes(relative)||relative.startsWith(root+'/account-evidence/'));
    },
  });
  async function copyArtifacts(relative) {
    let entries;
    try { entries=await readdir(path.join(source,relative),{withFileTypes:true}); }
    catch(error) { if(error.code==='ENOENT')return;throw error; }
    await mkdir(path.join(destination,relative),{recursive:true});
    for(const entry of entries) {
      const file=path.join(relative,entry.name);
      if(entry.isDirectory()) { await copyArtifacts(file);continue; }
      const payload=await readFile(path.join(source,file));
      const encoded=await encodeReviewArtifact(payload);
      await writeFile(path.join(destination,file),encoded);
    }
  }
  for(const relative of artifacts)await copyArtifacts(relative);
  for(const root of roots){
  const indexText = await readFile(path.join(source, root,'account-enrichment.json'), 'utf8');
  const statusText = await readFile(path.join(source, root,'account-research-status.json'), 'utf8');
  const index = await parseAccountIndex(indexText), status = JSON.parse(statusText);
  for (const key of ['dataset_id', 'base_data_hash', 'research_snapshot_id']) {
    if (!index[key] || index[key] !== status[key]) throw Error('Research publication changed during build; retry.');
  }
  const selected = [];
  if (index.evidence_storage === 'account-files-v1') {
    for (const account of index.accounts) {
      if (!validEvidencePath(account.evidence_path)) throw Error('Invalid account evidence reference.');
      selected.push(account);
    }
  }
  await mkdir(path.join(destination, root,'account-evidence'), { recursive: true });
  // Keep source JSON untouched; only the Pages artifact uses lossless compression.
  // Bound concurrency so large accounts do not accumulate in memory.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const account = selected[next++];
      const payload = await readFile(path.join(source, root, account.evidence_path));
      const encoded = await encodeAccountEvidence(payload, account);
      const hash = createHash('sha256').update(encoded).digest('hex');
      account.evidence_path = account.evidence_path.replace(/-[a-f0-9]{16}\.json$/,`-${hash.slice(0,16)}.json`);
      account.evidence_sha256 = hash;
      account.evidence_encoding = 'gzip-base64-v1';
      await writeFile(path.join(destination, root, account.evidence_path), encoded);
    }
  }));
  await mkdir(path.join(destination, root), { recursive: true });
  const indexBytes=Buffer.from(JSON.stringify(index)+'\n');
  await writeFile(path.join(destination, root,'account-enrichment.json'),await encodeAccountEvidence(indexBytes,{evidence_sha256:createHash('sha256').update(indexBytes).digest('hex')}));
  await writeFile(path.join(destination, root,'account-research-status.json'), statusText);
  }
  const size = await directorySize(destination);
  if (size >= maxBytes) throw Error(`Review site is ${size} bytes; exceeds the ${maxBytes}-byte publication budget. Existing deployment is unchanged.`);
  console.log(`Review site size: ${size} bytes (budget ${maxBytes}).`);
}

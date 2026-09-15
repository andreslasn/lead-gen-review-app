import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {validateAccountPackage,validateFieldDecision,validateWebpageReviewExport,loadAccountEvidence,fieldState,mergeFieldEvents} from '../src/accountEvidence.js';
import {lvPackage,lvEvent,lvExport} from './lvFixtures.mjs';
import {copyPublicPackage} from '../scripts/copy-public-package.mjs';

test('LV uses dashboard account IDs even when institution codes repeat',()=>{
 const pkg=lvPackage();assert.equal(validateAccountPackage(pkg,pkg),pkg);
 for(const change of [{account_key:'HU:A001'},{dashboard_record_id:'3'.repeat(20)},{account_key:'LV:shared'}]){
  const bad=structuredClone(pkg);Object.assign(bad.accounts[0],change);assert.throws(()=>validateAccountPackage(bad,pkg));
 }
 const bad=structuredClone(pkg);bad.accounts[0].claims[0].website_role='official';assert.throws(()=>validateAccountPackage(bad,pkg));
 validateFieldDecision(lvEvent(),pkg);
 assert.throws(()=>validateFieldDecision({...lvEvent(),observation_ids:['absent']},pkg));
 assert.throws(()=>validateFieldDecision({...lvEvent(),field:'email'}));
});
test('LV imports exclude HU reviews and validate their own dataset and observations',()=>{
 const pkg=lvPackage();validateWebpageReviewExport(lvExport(),pkg);
 for(const bad of [{...lvExport(),dataset_id:'HU'},{...lvExport(),base_data_hash:'other'},{...lvExport(),email_validations:[{email:'x@example.invalid'}]},{...lvExport(),field_decisions:[{...lvEvent(),account_key:'HU:A001'}]}])assert.throws(()=>validateWebpageReviewExport(bad,pkg));
 const events=[lvEvent(),lvEvent('other','rejected')];assert.equal(fieldState(pkg.accounts[0].claims[0],events).status,'conflict');
 assert.equal(fieldState(pkg.accounts[0].claims[0],[...events,{...lvEvent('resolution'),supersedes:events.map(e=>e.id)}]).status,'confirmed');
 assert.throws(()=>mergeFieldEvents(events,[lvEvent('lv-one','rejected')]));
});
test('compressed LV evidence and canonical import preserve event IDs and HU files',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'lv-review-'));
 try{
  const directory=path.join(root,'public/data/markets/LV');await mkdir(path.join(directory,'account-evidence'),{recursive:true});
  const pkg=lvPackage(),full=structuredClone(pkg.accounts[0]);
  const bytes=Buffer.from(JSON.stringify({format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(full)).toString('base64')})),sha=createHash('sha256').update(bytes).digest('hex');
  const evidence_path='account-evidence/LV-'+full.dashboard_record_id+'-'+sha.slice(0,16)+'.json';
  pkg.evidence_storage='account-files-v1';pkg.accounts[0]={...full,claims:full.claims.map(({observations,...c})=>c),evidence_path,evidence_sha256:sha,evidence_encoding:'gzip-base64-v1'};
  // Even accounts without pages keep a verifiable detail file in production; this fixture only loads the reviewed account.
  await writeFile(path.join(directory,evidence_path),bytes);
  const loaded=await loadAccountEvidence(pkg,pkg.accounts[0],relative=>readFile(path.join(directory,relative),'utf8'));assert.deepEqual(loaded.claims,full.claims);
  await assert.rejects(loadAccountEvidence(pkg,pkg.accounts[0],async()=>bytes.toString()+' '),/changed/);
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(pkg));await writeFile(path.join(directory,'account-enrichment.json'),JSON.stringify(pkg));
  const hu=path.join(root,'public/data/canonical-review-state.json');await writeFile(hu,'preserve HU');
  const exported=path.join(root,'review.json');await writeFile(exported,JSON.stringify(lvExport()));
  const run=()=>execFileSync(process.execPath,['scripts/import-review-export.mjs',root,exported]);run();run();
  const state=JSON.parse(await readFile(path.join(directory,'canonical-review-state.json')));assert.deepEqual(state.field_decisions,[lvEvent()]);assert.equal(await readFile(hu,'utf8'),'preserve HU');
  await writeFile(exported,JSON.stringify({...lvExport(),email_validations:[{}]}));assert.throws(run);assert.equal(await readFile(hu,'utf8'),'preserve HU');
  const huPackage={format:'lead-gen-account-enrichment',schema_version:1,dataset_id:'hu',base_data_hash:'hu-hash',research_snapshot_id:'a'.repeat(64),accounts:[]};
  await writeFile(path.join(root,'public/data/account-enrichment.json'),JSON.stringify(huPackage));await writeFile(path.join(root,'public/data/account-research-status.json'),JSON.stringify(huPackage));
  const publication={...pkg,accounts:[pkg.accounts[0]]};await writeFile(path.join(directory,'account-enrichment.json'),JSON.stringify(publication));await writeFile(path.join(directory,'account-research-status.json'),JSON.stringify(publication));
  await writeFile(path.join(directory,'account-evidence/LV-'+full.dashboard_record_id+'-'+'0'.repeat(16)+'.json'),'obsolete');
  await copyPublicPackage(path.join(root,'public'),path.join(root,'dist'));
  const output=JSON.parse(await readFile(path.join(root,'dist/data/markets/LV/account-enrichment.json')));
  assert.equal(output.accounts[0].evidence_path,evidence_path);assert.deepEqual(await readFile(path.join(root,'dist/data/markets/LV',evidence_path)),bytes);
  await assert.rejects(readFile(path.join(root,'dist/data/markets/LV/account-evidence/LV-'+full.dashboard_record_id+'-'+'0'.repeat(16)+'.json')));
 }finally{await rm(root,{recursive:true,force:true});}
});

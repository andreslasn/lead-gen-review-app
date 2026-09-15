import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldState,mergeFieldEvents,validateAccountPackage,validateFieldDecision,loadAccountEvidence,decodeAccountEvidence} from '../src/accountEvidence.js';
import {createHash} from 'node:crypto';
const claim={claim_id:'a'.repeat(64),account_key:'HU:A001',hsz:'001',field:'practice_software',value:'Synthetic software',review_status:'unreviewed',observations:[{observation_id:'b'.repeat(64),source_url:'https://example.invalid/'}]};
const pkg={format:'lead-gen-account-enrichment',schema_version:1,dataset_id:'test',base_data_hash:'hash',accounts:[{account_key:'HU:A001',services:[{hsz:'001'}],claims:[claim]}]};
const event=(id,status,extra={})=>({id,status,claim_id:claim.claim_id,account_key:'HU:A001',field:claim.field,reviewed_by:'tester',reviewed_at:'2026-09-14T00:00:00Z',observation_ids:['b'.repeat(64)],supersedes:[],...extra});
test('refresh retains rejected claim; conflicting heads require explicit resolution',()=>{
 const events=[event('one','rejected')];assert.equal(fieldState(claim,events).status,'rejected');
 events.push(event('two','confirmed'));assert.equal(fieldState(claim,events).status,'conflict');
 events.push(event('three','confirmed',{supersedes:['one','two']}));assert.equal(fieldState(claim,events).status,'confirmed');
});
test('same event ID collision rejects whole merge',()=>{
 const original=[event('one','rejected')];assert.throws(()=>mergeFieldEvents(original,[event('two','confirmed'),event('one','confirmed')]));assert.equal(original.length,1);
});
test('dataset and source ownership checks fail closed',()=>{
 assert.equal(validateAccountPackage(pkg,{dataset_id:'test',base_data_hash:'hash'}),pkg);
 assert.throws(()=>validateAccountPackage(pkg,{dataset_id:'other',base_data_hash:'hash'}));
 assert.equal(validateFieldDecision(event('one','confirmed'),pkg).id,'one');
 assert.throws(()=>validateFieldDecision(event('one','confirmed',{observation_ids:['wrong']}),pkg));
 assert.throws(()=>validateFieldDecision(event('one','confirmed',{field:'email'})));
 assert.throws(()=>validateFieldDecision(event('one','confirmed',{field:'monthly_price'})));
});
test('account evidence loads on demand, checks its digest and retains decision identity',async()=>{
 const text=JSON.stringify(pkg.accounts[0])+'\n',hash=createHash('sha256').update(text).digest('hex');
 const index={...pkg,evidence_storage:'account-files-v1',accounts:[{...pkg.accounts[0],claims:[Object.fromEntries(Object.entries(claim).filter(([k])=>k!=='observations'))],evidence_path:'account-evidence/A001-'+hash.slice(0,16)+'.json',evidence_sha256:hash}]};
 validateAccountPackage(index,index);
 const loaded=await loadAccountEvidence(index,index.accounts[0],async()=>text);
 assert.equal(loaded.evidence_loaded,true);assert.deepEqual(loaded.claims,[claim]);
 validateFieldDecision(event('loaded','confirmed'),{...index,accounts:[loaded]});
 await assert.rejects(loadAccountEvidence(index,index.accounts[0],async()=>text+' '),/changed/);
 await assert.rejects(loadAccountEvidence(index,{...index.accounts[0],evidence_path:'../secret'},async()=>text),/reference/);
});

test('compressed evidence preserves review identity and fails closed for corruption or unsupported encoding',async()=>{
 const {gzipSync}=await import('node:zlib');
 const text=JSON.stringify({format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(pkg.accounts[0])).toString('base64')});
 const hash=createHash('sha256').update(text).digest('hex');
 const account={...pkg.accounts[0],evidence_path:'account-evidence/A001-'+hash.slice(0,16)+'.json',evidence_sha256:hash,evidence_encoding:'gzip-base64-v1'};
 const index={...pkg,evidence_storage:'account-files-v1',accounts:[account]};
 const loaded=await loadAccountEvidence(index,account,async()=>text);
 assert.deepEqual(loaded.claims,[claim]);
 assert.equal(fieldState(loaded.claims[0],[event('previous','rejected')]).status,'rejected');
 await assert.rejects(loadAccountEvidence(index,account,async()=>text+' '),/changed/);
 await assert.rejects(decodeAccountEvidence('{}','gzip-base64-v1'),/Invalid compressed/);
 await assert.rejects(decodeAccountEvidence(text,'unknown'),/Unsupported/);
 await assert.rejects(decodeAccountEvidence(JSON.stringify({format:'lead-gen-account-evidence-gzip',schema_version:1,data:btoa('broken')}),'gzip-base64-v1'));
 assert.throws(()=>validateAccountPackage({...index,accounts:[{...account,evidence_encoding:'unknown'}]},index),/Unsupported/);
 const original=globalThis.DecompressionStream;
 try {globalThis.DecompressionStream=undefined;await assert.rejects(decodeAccountEvidence(text,'gzip-base64-v1'),/saved reviews remain intact/);}
 finally {globalThis.DecompressionStream=original;}
});

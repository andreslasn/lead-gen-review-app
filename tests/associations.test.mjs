import test from 'node:test';
import assert from 'node:assert/strict';
import { associationKey, associationState, mappedEmailRows, validateAssociationDecision, validateAssociationPackage } from '../src/associations.js';
const email='test@example.invalid';
const base={id:associationKey(email,'A001'),email,provider_code:'A001',status:'confirmed',source:'legacy-clinic-review'};
const event=(id,status,extra={})=>({id,association_id:base.id,email,provider_code:'A001',country:'HU',status,contact_role:'unknown',owner_name:'',note:'',evidence_urls:[],reviewed_at:'2026-09-14T12:00:00Z',reviewed_by:id,supersedes:[],...extra});
const pkg={providers:[{code:'A001',name:'Clinic A',services:[]},{code:'B002',name:'Clinic B',services:[]}],associations:[base,{...base,id:associationKey(email,'B002'),provider_code:'B002'}]};
test('shared valid email exports both confirmed providers; rejects only that association',()=>{
 const emails=[{email,status:'valid'}];assert.equal(mappedEmailRows(emails,pkg,[]).length,2);
 assert.deepEqual(mappedEmailRows(emails,pkg,[event('one','rejected')]).map(r=>r.neak_provider_code),['B002']);assert.equal(emails[0].status,'valid');
 assert.equal(mappedEmailRows([{email,status:'invalid'}],pkg,[]).length,0);
 assert.equal(mappedEmailRows([{email,status:'valid',used_in_campaign:true}],pkg,[],{unused:true}).length,0);
});
test('corrected email never inherits the old mailbox associations',()=>{
 assert.equal(mappedEmailRows([{email,status:'valid',display_value:'different@example.invalid'}],pkg,[]).length,0);
});
test('conflicting concurrent reviewers remain unresolved until explicitly superseded',()=>{
 const events=[event('one','rejected'),event('two','confirmed')];assert.equal(associationState(base,events).status,'conflict');
 const resolution=event('three','confirmed',{supersedes:['one','two']});assert.equal(associationState(base,[...events,resolution]).status,'confirmed');
 assert.equal(associationState(base,[event('one','rejected',{supersedes:['two']}),event('two','confirmed',{supersedes:['one']})]).status,'conflict');
});
test('manual unresolved overrides legacy confirmation without altering seed',()=>{
 assert.equal(associationState(base,[event('one','unreviewed')]).status,'unreviewed');assert.equal(base.status,'confirmed');
});
test('invalid identity and unsafe sources are rejected',()=>{
 assert.equal(validateAssociationDecision(event('one','confirmed')).provider_code,'A001');
 for(const extra of [{association_id:'wrong'},{provider_code:'123456789'},{evidence_urls:['javascript:alert(1)']},{status:'valid'},{supersedes:['one']}])assert.throws(()=>validateAssociationDecision(event('one','confirmed',extra)));
});

test('dataset drift and duplicate provider identities fail closed',()=>{
 const fixture={...pkg,format:'lead-gen-email-associations',schema_version:1,country:'HU',dataset_id:'fixture',base_data_hash:'hash',items:[]};
 assert.equal(validateAssociationPackage(fixture,{dataset_id:'fixture',base_data_hash:'hash'}),fixture);
 assert.throws(()=>validateAssociationPackage(fixture,{dataset_id:'other',base_data_hash:'hash'}));
 assert.throws(()=>validateAssociationPackage({...fixture,providers:[...fixture.providers,fixture.providers[0]]},{dataset_id:'fixture',base_data_hash:'hash'}));
});

test('doctor-name suggestions rank evidence without becoming confirmed campaign links', async()=>{
 const {associationRank,associationEvidence,validateIdentityMatch}=await import('../src/associations.js');
 const identity={version:1,tier:'email_name',method:'complete_email_name',human_verified:false,account_key:'HU:A001',doctor_names:['Dr. Synthetic Doctor'],service_ids:['001']};
 const provider={code:'A001',services:[{hsz:'001',doctor:'Dr. Synthetic Doctor'}]};
 validateIdentityMatch(identity,provider);
 assert.throws(()=>validateIdentityMatch({...identity,human_verified:true},provider));
 assert.throws(()=>validateIdentityMatch({...identity,doctor_names:['Another Doctor']},provider));
 assert.ok(associationRank({status:'unreviewed',identity_match:identity})>associationRank({status:'unreviewed'}));
 assert.ok(associationRank({status:'confirmed'})>associationRank({status:'unreviewed',identity_match:identity}));
 assert.ok(associationRank({status:'rejected',identity_match:identity})<associationRank({status:'unreviewed'}));
 assert.equal(associationEvidence({evidence:[{quote:'Legacy suggestion'},{quote:'Doctor match',identity_match:identity}]})[0].quote,'Doctor match');
 const candidate={id:'valid@example.invalid|HU|A001',email:'valid@example.invalid',provider_code:'A001',status:'unreviewed',identity_match:identity};
 assert.equal(mappedEmailRows([{email:candidate.email,status:'valid'}],{providers:[provider],associations:[candidate]},[]).length,0);
});

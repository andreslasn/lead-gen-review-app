import test from 'node:test';
import assert from 'node:assert/strict';
import {lvPackage,lvEvent,lvExport} from './lvFixtures.mjs';
import {validateAccountPackage,validateFieldDecision,validateWebpageReviewExport,validateContactPreference,contactPresentation,mergeFieldEvents} from '../src/accountEvidence.js';
const pl=()=>JSON.parse(JSON.stringify(lvPackage()).replaceAll('LV:','PL:').replaceAll('"LV"','"PL"').replaceAll('synthetic-lv','synthetic-pl').replaceAll('lv-hash','pl-hash'));
test('Poland reviews keep account links separate from HU validity and preserve market boundaries',()=>{
 const pkg=pl(),a=pkg.accounts[0],email={...a.claims[0],claim_id:'d'.repeat(64),field:'email',value:'reception@example.invalid'};
 a.claims.push(email);a.contact_reconciliation={version:1,groups:[{id:'e'.repeat(64),field:'email',value:email.value,role:'practice',strength:'strong',claim_ids:[email.claim_id],proofs:[]}],recommended:{email:'e'.repeat(64)},lanes:[]};
 validateAccountPackage(pkg,pkg);
 const e={...lvEvent('pl-one'),account_key:a.account_key,claim_id:email.claim_id,field:'email',contact_role:'reception'};
 validateFieldDecision(e,pkg);
 const pref={id:'prefer',schema_version:1,account_key:a.account_key,field:'email',candidate_id:'e'.repeat(64),reviewed_by:'test',reviewed_at:e.reviewed_at,supersedes:[]};validateContactPreference(pref,pkg);
 const payload={...lvExport(),dataset_id:pkg.dataset_id,base_data_hash:pkg.base_data_hash,field_decisions:[e],contact_preferences:[pref]};
 validateWebpageReviewExport(payload,pkg);
 const view=contactPresentation(a,[e],new Map(),[pref]);assert.equal(view.preferred.email.status,'confirmed');assert.equal(view.preferred.email.email_validity,'unknown');assert.equal(view.preferred.email.role,'reception');
 assert.throws(()=>validateWebpageReviewExport({...payload,email_validations:[{email:email.value,status:'valid'}]},pkg));
 assert.throws(()=>validateWebpageReviewExport({...payload,field_decisions:[lvEvent()]},pkg));
 assert.throws(()=>validateWebpageReviewExport({...payload,contact_preferences:[{...pref,account_key:'HU:A001'}]},pkg));
 assert.throws(()=>validateFieldDecision({...e,account_key:'HU:A001'}));
 assert.equal(mergeFieldEvents([lvEvent()],[e]).length,2);
});
test('Poland website capabilities can record prescription requests without asserting software',()=>{
 const pkg=pl(),e={...lvEvent(),account_key:pkg.accounts[0].account_key,contact_role:'practice_website',webpage_capabilities:{version:1,actions:['prescription_request'],provider:''}};
 validateFieldDecision(e,pkg);assert.throws(()=>validateFieldDecision({...e,field:'email'},pkg));
});

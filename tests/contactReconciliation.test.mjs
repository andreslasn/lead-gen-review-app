import test from 'node:test';
import assert from 'node:assert/strict';
import { contactPresentation, contactPreferenceState, mergeContactPreferences, validateContactPreference, validateContactReconciliation, validateSoftwareAttribution } from '../src/accountEvidence.js';
import { mappedEmailRows } from '../src/associations.js';
const id='d'.repeat(64),source='e'.repeat(64),cid='a'.repeat(64);
const account={account_key:'HU:A001',provider_code:'A001',services:[{hsz:'001'}],claims:[{claim_id:cid,field:'website',observations:[{observation_id:'b'.repeat(64)}]}],contact_reconciliation:{version:1,lanes:[],recommended:{email:id},groups:[{id,field:'email',value:'contact@example.invalid',association_id:'contact@example.invalid|HU|A001',role:'practice',strength:'strong',claim_ids:[],proofs:[],email_validity:'valid'},{id:source,field:'website',value:'https://directory.invalid/a',role:'source_page',strength:'limited',claim_ids:[cid],proofs:[]}]}};
const preference=(event,candidate=id,extra={})=>({id:event,schema_version:1,account_key:account.account_key,field:'email',candidate_id:candidate,reviewed_by:'tester',reviewed_at:'2026-09-15T00:00:00Z',supersedes:[],...extra});

test('preference does not confirm ownership or email validity; invalid/rejected selection has no fallback',()=>{
 const e=preference('one');validateContactPreference(e,{accounts:[account]});
 let view=contactPresentation(account,[],new Map(),[e]);
 assert.equal(view.preferred.email.status,'unreviewed');assert.equal(view.choices.email.kind,'selected');
 view=contactPresentation(account,[],new Map(),[e],{'contact@example.invalid':{status:'invalid'}});
 assert.equal(view.preferred.email,null);assert.equal(view.choices.email.kind,'unavailable');
 view=contactPresentation(account,[],new Map([[account.contact_reconciliation.groups[0].association_id,{status:'rejected'}]]),[e]);
 assert.equal(view.preferred.email,null);
});
test('conflicting preferences, explicit clear, stale candidate and event-ID collision preserve review intent',()=>{
 const events=[preference('one'),preference('two',null)];assert.equal(contactPreferenceState(account,'email',events).kind,'conflict');
 assert.equal(contactPreferenceState(account,'email',[...events,preference('three',null,{supersedes:['one','two']})]).kind,'cleared');
 const refreshed=structuredClone(account);refreshed.contact_reconciliation.groups=[];
 assert.equal(contactPreferenceState(refreshed,'email',[events[0]]).kind,'stale');
 assert.throws(()=>mergeContactPreferences([events[0]],[preference('one',null)]),/Conflicting/);
 assert.deepEqual(mergeContactPreferences([events[0]],[events[0]]),[events[0]]);
});
test('confirming a supporting source does not turn it into a preferred homepage',()=>{
 validateContactReconciliation(account);
 const fieldEvent={id:'confirmed',claim_id:cid,status:'confirmed',contact_role:'source_page',reviewed_at:'2026-09-15T00:00:00Z',supersedes:[]};
 const selection=preference('source',source,{field:'website'});
 const view=contactPresentation(account,[fieldEvent],new Map(),[selection]);
 assert.equal(view.sources.length,1);assert.equal(view.sources[0].status,'confirmed');assert.equal(view.preferred.website,null);
});
test('non-practice purpose blocks outreach even when association and mailbox are confirmed',()=>{
 const pkg={providers:[{code:'A001',name:'Synthetic'}],associations:[{id:'contact@example.invalid|HU|A001',email:'contact@example.invalid',provider_code:'A001',country:'HU',status:'confirmed',contact_role:'clinic_contact',contact_purpose:'municipal'}]};
 assert.equal(mappedEmailRows([{email:'contact@example.invalid',status:'valid'}],pkg,[]).length,0);
});
test('software attribution cannot silently claim all panels or assign absent services',()=>{
 const c={field:'practice_software',attribution:{version:1,status:'attribution_unresolved',eligible_for_analytics:false,scope:'unresolved',service_ids:[],all_panels_verified:false,current_use_verified:false,reasons:[],proofs:[]}};
 validateSoftwareAttribution(c,account);
 assert.throws(()=>validateSoftwareAttribution({...c,attribution:{...c.attribution,all_panels_verified:true}},account),/Invalid/);
 assert.throws(()=>validateSoftwareAttribution({...c,attribution:{...c.attribution,service_ids:['absent']}},account),/Invalid/);
});

test('malformed legacy website values remain reviewable text and cannot be preferred',()=>{
 const a=structuredClone(account);a.contact_reconciliation.groups[1].value='http://invalid host.invalid';a.contact_reconciliation.groups[1].role='practice_website';a.contact_reconciliation.recommended.website=source;
 validateContactReconciliation(a);
 assert.equal(contactPresentation(a).preferred.website,null);
});

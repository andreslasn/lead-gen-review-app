import { associationState, safeSourceUrl } from './associations.js';
export const researchFields = {website:'Website', email:'Email account link', telephone:'Telephone', practice_software:'Practice software', patient_tools:'Patient tools', opening_hours:'Opening hours', patient_count_clue:'Patient count clue (scope unverified)'};
export const contactRoles = {practice:'Practice contact',doctor:'Doctor',reception:'Reception / assistant',prescriptions:'Prescriptions',shared:'Shared organisation contact',municipal:'Municipal contact',webmaster:'Website / data operator',historical:'Historical contact',unrelated:'Unrelated contact',unresolved:'Purpose unresolved',practice_website:'Practice website',patient_portal:'Patient portal',social_profile:'Social profile',source_page:'Supporting source',directory_profile:'Directory / registry profile',organisation_profile:'Hospital / organisation profile',fax:'Fax',out_of_hours:'Out-of-hours service'};
export const contactFields = ['email','website','telephone'];
const excludedContactRoles = new Set(['municipal','webmaster','historical','unrelated','source_page','fax','out_of_hours']);
export const validAccountKey = key => /^(?:HU:[A-Z0-9]{4}|LV:[a-f0-9]{20})$/.test(key||'');
export const validEvidencePath = path => /^account-evidence\/(?:[A-Z0-9]{4}|LV-[a-f0-9]{20})-[a-f0-9]{16}\.json$/.test(path||'');
export const webpageRoles = {practice_website:'Practice websites',patient_portal:'Patient portals',social_profile:'Social profiles',directory_profile:'Directory / registry profiles',organisation_profile:'Hospital / organisation profiles',source_page:'Supporting sources'};
export const webpageActions = {book_appointment:'Book an appointment',request_appointment:'Request an appointment',general_enquiry:'Send a general enquiry',none_observed:'No capability observed',unclear:'Unclear'};
export function validateWebpageCapabilities(value) {
  if(!value||value.version!==1||!Array.isArray(value.actions)||value.actions.some(a=>typeof a!=='string'||!Object.hasOwn(webpageActions,a))||new Set(value.actions).size!==value.actions.length||value.actions.some(a=>['none_observed','unclear'].includes(a))&&value.actions.length!==1||typeof value.provider!=='string'||value.provider.length>160||value.provider!==value.provider.trim()||value.provider&&(!value.actions.length||value.actions.some(a=>['none_observed','unclear'].includes(a)))||Object.keys(value).some(k=>!['version','actions','provider'].includes(k)))throw Error('Invalid webpage capabilities.');
  return value;
}
export function validateFieldDecision(e, pkg) {
  if (!e || !e.id || !/^[a-f0-9]{64}$/.test(e.claim_id||'') || !validAccountKey(e.account_key) || !researchFields[e.field] || e.field==='email' || e.account_key.startsWith('LV:')&&e.field!=='website' || !['confirmed','rejected','unreviewed'].includes(e.status) || !e.reviewed_by || !Number.isFinite(Date.parse(e.reviewed_at)) || !Array.isArray(e.supersedes) || e.supersedes.includes(e.id) || !Array.isArray(e.observation_ids) || !e.observation_ids.length) throw Error('Invalid account field decision.');
  if (pkg) {
    const c=pkg.accounts.flatMap(a=>a.claims).find(c=>c.claim_id===e.claim_id);
    if (!c || c.account_key!==e.account_key || c.field!==e.field || e.observation_ids.some(id=>!c.observations.some(o=>o.observation_id===id))) throw Error('Decision does not match the current account evidence.');
  }
  if(e.contact_role!=null&&!Object.hasOwn(contactRoles,e.contact_role))throw Error('Invalid contact purpose.');
  if(e.account_key.startsWith('LV:')&&e.contact_role!=null&&!Object.hasOwn(webpageRoles,e.contact_role))throw Error('Invalid webpage role.');
  if(Object.hasOwn(e,'webpage_capabilities')){
    if(!e.account_key.startsWith('LV:')||e.field!=='website')throw Error('Patient capabilities require a Latvia webpage.');
    validateWebpageCapabilities(e.webpage_capabilities);
  }
  return e;
}
export function fieldState(claim, events=[]) {
  const matching=events.filter(e=>e.claim_id===claim.claim_id&&e.account_key===claim.account_key);
  return associationState({...claim,id:claim.claim_id,status:'unreviewed'},matching.map(e=>({...e,association_id:e.claim_id,contact_role:e.contact_role||'',owner_name:''})));
}
export function validateAccountPackage(pkg, manifest) {
  if (pkg?.format!=='lead-gen-account-enrichment' || pkg.schema_version!==1 || pkg.dataset_id!==manifest.dataset_id || pkg.base_data_hash!==manifest.base_data_hash || !Array.isArray(pkg.accounts)) throw Error('Account evidence does not match this dataset.');
  const ids=new Set(), codes=new Set();
  const country=pkg.country||'HU';
  if(!['HU','LV'].includes(country))throw Error('Unsupported account market.');
  for (const a of pkg.accounts) {
    if (!validAccountKey(a.account_key) || !a.account_key.startsWith(country+':') || codes.has(a.account_key) || !Array.isArray(a.claims) || !Array.isArray(a.services)) throw Error('Invalid account identity.');
    if(country==='LV'&&(a.country!=='LV'||a.account_key!=='LV:'+a.dashboard_record_id||typeof a.provider_code!=='string'||typeof a.name!=='string'))throw Error('Invalid Latvia account identity.');
    codes.add(a.account_key);
    if(a.contact_reconciliation)validateContactReconciliation(a);
    for (const c of a.claims) {
      const indexed=pkg.evidence_storage==='account-files-v1'&&!a.evidence_loaded;
      if(indexed&&a.evidence_encoding!=null&&a.evidence_encoding!=='gzip-base64-v1')throw Error('Unsupported account evidence encoding.');
      if(indexed&&(!validEvidencePath(a.evidence_path)||!/^[a-f0-9]{64}$/.test(a.evidence_sha256||'')))throw Error('Invalid account evidence reference.');
      if (!/^[a-f0-9]{64}$/.test(c.claim_id) || ids.has(c.claim_id) || c.account_key!==a.account_key || !researchFields[c.field] || c.review_status!=='unreviewed' || !indexed&&(!Array.isArray(c.observations) || !c.observations.length) || (country==='LV'?c.hsz!==''||c.field!=='website'||!safeSourceUrl(c.value)||!Object.hasOwn(webpageRoles,c.website_role):!a.services.some(s=>s.hsz===c.hsz))) throw Error('Invalid account claim.');
      if(c.observations?.some(o=>!o.observation_id || o.source_url&&!safeSourceUrl(o.source_url)))throw Error('Invalid account evidence source.');
      if(pkg.software_attribution_version===1&&['practice_software','patient_tools'].includes(c.field)&&!c.attribution)throw Error('Software attribution is missing.');
      if(c.attribution)validateSoftwareAttribution(c,a);
      ids.add(c.claim_id);
    }
  }
  return pkg;
}

export function validateContactReconciliation(account) {
  const value=account.contact_reconciliation;
  if(value?.version!==1||!Array.isArray(value.groups)||!value.recommended||!Array.isArray(value.lanes))throw Error('Unsupported contact reconciliation.');
  const claims=new Map(account.claims.map(c=>[c.claim_id,c])),ids=new Set();
  for(const g of value.groups){
    if(!/^[a-f0-9]{64}$/.test(g.id||'')||ids.has(g.id)||!contactFields.includes(g.field)||!Object.hasOwn(contactRoles,g.role)||typeof g.value!=='string'||!Array.isArray(g.claim_ids)||!Array.isArray(g.proofs)||!['strong','limited'].includes(g.strength))throw Error('Invalid contact candidate.');
    if(g.claim_ids.some(id=>!claims.has(id)||claims.get(id).field!==g.field))throw Error('Contact candidate claim mismatch.');
    if(g.field==='email'&&g.association_id!=null&&g.association_id!==g.value.trim().toLowerCase()+'|HU|'+account.provider_code)throw Error('Contact association mismatch.');
    if(g.proofs.some(p=>p.source_url&&!safeSourceUrl(p.source_url)))throw Error('Invalid contact source.');
    ids.add(g.id);
  }
  for(const field of contactFields){const id=value.recommended[field];if(id!=null&&!value.groups.some(g=>g.id===id&&g.field===field))throw Error('Invalid contact recommendation.');}
}

export function validateContactPreference(e,pkg) {
  if(!e?.id||e.schema_version!==1||!/^HU:[A-Z0-9]{4}$/.test(e.account_key||'')||!contactFields.includes(e.field)||(e.candidate_id!==null&&!/^[a-f0-9]{64}$/.test(e.candidate_id||''))||!e.reviewed_by||!Number.isFinite(Date.parse(e.reviewed_at))||!Array.isArray(e.supersedes)||e.supersedes.some(id=>typeof id!=='string'||id===e.id))throw Error('Invalid preferred-contact decision.');
  if(pkg){const a=pkg.accounts.find(a=>a.account_key===e.account_key);if(!a||e.candidate_id!==null&&!a.contact_reconciliation?.groups.some(g=>g.id===e.candidate_id&&g.field===e.field))throw Error('Preferred contact is absent from this account.');}
  return e;
}

export function mergeContactPreferences(existing=[],incoming=[]) {
  const events=new Map();
  for(const e of [...existing,...incoming]){validateContactPreference(e);if(events.has(e.id)&&JSON.stringify(events.get(e.id))!==JSON.stringify(e))throw Error('Conflicting preferred-contact event ID; original decisions preserved.');events.set(e.id,e);}
  return [...events.values()];
}

export function contactPreferenceState(account,field,events=[]) {
  const selected=events.filter(e=>e.account_key===account.account_key&&e.field===field);
  if(!selected.length)return {kind:account.contact_reconciliation?.recommended[field]?'suggested':'none',candidate_id:account.contact_reconciliation?.recommended[field]||null,heads:[]};
  const superseded=new Set(selected.flatMap(e=>e.supersedes)),heads=selected.filter(e=>!superseded.has(e.id));
  if(!heads.length||new Set(heads.map(e=>e.candidate_id)).size!==1)return {kind:'conflict',candidate_id:null,heads:(heads.length?heads:selected).map(e=>e.id)};
  const id=heads[0].candidate_id;
  return {kind:id===null?'cleared':account.contact_reconciliation?.groups.some(g=>g.id===id&&g.field===field)?'selected':'stale',candidate_id:id,heads:heads.map(e=>e.id)};
}

export function contactPresentation(account,fieldEvents=[],associations=new Map(),preferences=[],validity={}) {
  const resolution=account.contact_reconciliation;if(!resolution)return null;
  const claimMap=new Map(account.claims.map(c=>[c.claim_id,c]));
  const groups=resolution.groups.map(g=>{
    const states=g.field==='email'?[associations.get(g.association_id)||{status:g.recorded_ownership||'unreviewed'}]:g.claim_ids.map(id=>fieldState(claimMap.get(id),fieldEvents));
    const statuses=new Set(states.map(s=>s.status)),roles=new Set(states.filter(s=>s.status==='confirmed').map(s=>g.field==='email'?s.contact_purpose:s.contact_role).filter(Boolean));
    const status=statuses.has('conflict')||roles.size>1?'conflict':statuses.size===1?[...statuses][0]:'unreviewed';
    const role=roles.size===1?[...roles][0]:g.role;
    const emailValidity=validity[g.value]?.status||validity[g.value]||g.email_validity||'unknown';
    const eligible=status!=='rejected'&&status!=='conflict'&&!excludedContactRoles.has(role)&&emailValidity!=='invalid'&&(g.field!=='website'||role==='practice_website'&&!!safeSourceUrl(g.value));
    const original_observations=g.field==='email'?[...g.claim_ids.flatMap(id=>claimMap.get(id).observations||[]),...(associations.get(g.association_id)?.evidence||[])]:g.claim_ids.flatMap(id=>claimMap.get(id).observations||[]);
    return {...g,original_observations,status:status||'unreviewed',role,email_validity:emailValidity,eligible,needs_review:status!=='confirmed',claim_states:states};
  });
  const preferred={},choices={};
  for(const field of contactFields){
    const choice=contactPreferenceState(account,field,preferences),group=groups.find(g=>g.id===choice.candidate_id&&g.field===field);
    if(group&&!group.eligible){choice.kind='unavailable';choice.candidate_id=null;}
    choices[field]=choice;preferred[field]=choice.candidate_id&&group?.eligible?group:null;
  }
  return {groups,preferred,choices,sources:groups.filter(g=>g.field==='website'&&g.role==='source_page'),alternatives:groups.filter(g=>!(g.field==='website'&&g.role==='source_page')&&!Object.values(preferred).some(p=>p?.id===g.id))};
}
export async function loadAccountEvidence(pkg, account, fetchText) {
  if(pkg.evidence_storage!=='account-files-v1'||account.evidence_loaded)return account;
  if(!validEvidencePath(account.evidence_path))throw Error('Invalid account evidence reference.');
  const text=await fetchText(account.evidence_path);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==account.evidence_sha256)throw Error('Account evidence changed; reload the research index.');
  const detail=JSON.parse(await decodeAccountEvidence(text,account.evidence_encoding));
  if(detail.account_key!==account.account_key||JSON.stringify(detail.claims.map(c=>c.claim_id))!==JSON.stringify(account.claims.map(c=>c.claim_id)))throw Error('Account evidence identity mismatch.');
  validateAccountPackage({...pkg,evidence_storage:undefined,accounts:[detail]},pkg);
  return {...detail,evidence_loaded:true,evidence_path:account.evidence_path,evidence_sha256:account.evidence_sha256};
}
// Compression changes only the transport; claim IDs and reviewer decisions stay unchanged.
export async function decodeAccountEvidence(text, encoding) {
  if (encoding == null) return text;
  if (encoding !== 'gzip-base64-v1') throw Error('Unsupported account evidence encoding.');
  const envelope = JSON.parse(text);
  if (envelope.format !== 'lead-gen-account-evidence-gzip' || envelope.schema_version !== 1 || typeof envelope.data !== 'string') throw Error('Invalid compressed account evidence.');
  if (typeof DecompressionStream === 'undefined') throw Error('This browser cannot open compressed account evidence. Update your browser; saved reviews remain intact.');
  const bytes = Uint8Array.from(atob(envelope.data), char => char.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
export function mergeFieldEvents(existing=[], incoming=[]) {
  const events=new Map();
  for (const e of [...existing,...incoming]) {
    validateFieldDecision(e);
    if (events.has(e.id) && JSON.stringify(events.get(e.id))!==JSON.stringify(e)) throw Error('Conflicting account field event ID; original decisions preserved.');
    events.set(e.id,e);
  }
  return [...events.values()];
}

export function validateWebpageReviewExport(payload,pkg) {
  if(payload?.format!=='lead-gen-clinic-review'||payload.schema_version!==1||pkg?.country!=='LV'||payload.dataset_id!==pkg.dataset_id||payload.base_data_hash!==pkg.base_data_hash)throw Error('Latvia review dataset mismatch.');
  for(const key of ['decisions','clinic_states','email_validations','association_decisions','contact_preferences','role_overrides','audit_events'])if(payload[key]!=null&&(!Array.isArray(payload[key])||payload[key].length))throw Error('Latvia webpage reviews cannot contain other review data.');
  if(!Array.isArray(payload.field_decisions)||payload.field_decisions.some(e=>!e.account_key?.startsWith('LV:')))throw Error('Invalid Latvia webpage reviews.');
  mergeFieldEvents([],payload.field_decisions);
  for(const e of payload.field_decisions)validateFieldDecision(e,pkg);
  return payload;
}

export function validateSoftwareAttribution(claim,account){
 const a=claim.attribution;
 if(!['practice_software','patient_tools'].includes(claim.field)||a.version!==1||!['attributable_candidate','attribution_unresolved','reference_only'].includes(a.status)||a.eligible_for_analytics!==(a.status==='attributable_candidate')||!['account','service','unresolved'].includes(a.scope)||!Array.isArray(a.service_ids)||a.service_ids.some(id=>!account.services.some(s=>s.hsz===id))||a.all_panels_verified!==false||a.current_use_verified!==false||!Array.isArray(a.reasons)||!Array.isArray(a.proofs)||a.proofs.some(p=>p.source_url&&!safeSourceUrl(p.source_url)))throw Error('Invalid software attribution.');
}

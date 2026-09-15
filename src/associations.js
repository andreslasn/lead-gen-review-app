// Email validity and provider ownership are independent review decisions.
export const associationKey = (email, code) => `${String(email).trim().toLowerCase()}|HU|${code}`;
export function associationState(base, events = []) {
  const pairEvents = events.filter(e => e.association_id === base.id);
  const superseded = new Set(pairEvents.flatMap(e => e.supersedes || []));
  const heads = pairEvents.filter(e => !superseded.has(e.id));
  if (!heads.length) return { ...base, status: pairEvents.length ? 'conflict' : base.status, heads: pairEvents.map(e=>e.id) };
  const signatures = new Set(heads.map(e => JSON.stringify([e.status, e.contact_role, e.owner_name, e.contact_purpose||'',e.webpage_capabilities?.actions.length?[e.webpage_capabilities.version,[...e.webpage_capabilities.actions].sort(),e.webpage_capabilities.provider]:null])));
  if (signatures.size > 1) return { ...base, status: 'conflict', heads: heads.map(e => e.id), reason: 'Reviewers disagree. Review the evidence and save a decision to resolve the conflict.' };
  const newest = [...heads].sort((a,b) => a.reviewed_at.localeCompare(b.reviewed_at) || a.id.localeCompare(b.id)).at(-1);
  return { ...base, ...newest, id: base.id, heads: heads.map(e => e.id) };
}
export function validateAssociationDecision(e) {
  if(e&&Object.hasOwn(e,'webpage_capabilities'))throw Error('Patient capabilities require a Latvia webpage.');
  if (!e || typeof e.id !== 'string' || !e.id || !/^[^\s@]+@[^\s@]+$/.test(e.email || '') || !/^[A-Z0-9]{4}$/.test(e.provider_code || '') || e.country !== 'HU') throw Error('Invalid email-to-provider identity.');
  if (e.association_id !== associationKey(e.email, e.provider_code)) throw Error('Email-to-provider key mismatch.');
  if (!['confirmed','rejected','unreviewed'].includes(e.status) || !['unknown','clinic_contact','doctor_staff','shared_contact'].includes(e.contact_role)) throw Error('Invalid association decision.');
  if(e.contact_purpose!=null&&!['practice','doctor','reception','prescriptions','shared','municipal','webmaster','historical','unrelated','unresolved'].includes(e.contact_purpose))throw Error('Invalid email purpose.');
  if (!Number.isFinite(Date.parse(e.reviewed_at)) || typeof e.reviewed_by !== 'string' || !Array.isArray(e.supersedes) || e.supersedes.some(id => typeof id !== 'string' || id === e.id)) throw Error('Invalid association audit record.');
  if (typeof e.owner_name !== 'string' || typeof e.note !== 'string' || !Array.isArray(e.evidence_urls) || e.evidence_urls.some(url => !safeSourceUrl(url))) throw Error('Invalid association evidence.');
  return e;
}
export function safeSourceUrl(value) {
  try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export function resolvedAssociations(pkg, events) {
  const bases = new Map((pkg?.associations || []).map(a => [a.id,a]));
  for (const e of events) if (!bases.has(e.association_id)) bases.set(e.association_id, {id:e.association_id,email:e.email,provider_code:e.provider_code,country:'HU',status:'unreviewed',evidence:[],clinic_ids:[],service_ids:[]});
  const byPair = new Map();
  for (const e of events) { if (!byPair.has(e.association_id)) byPair.set(e.association_id,[]); byPair.get(e.association_id).push(e); }
  return [...bases.values()].map(base => associationState(base,byPair.get(base.id) || []));
}
export function mappingEmails(emails) {
  return emails.map(e=>({...e,email:String(e.display_value || e.email).trim().toLowerCase()}));
}
export function mappedEmailRows(emails, pkg, events, {unused = false} = {}) {
  const byEmail = new Map(mappingEmails(emails).filter(e => e.status === 'valid' && (!unused || !e.used_in_campaign)).map(e => [e.email,e]));
  const providers = new Map((pkg?.providers || []).map(p => [p.code,p]));
  return resolvedAssociations(pkg,events).filter(a => a.status === 'confirmed' && !['municipal','webmaster','historical','unrelated'].includes(a.contact_purpose) && byEmail.has(a.email) && providers.has(a.provider_code)).map(a => ({
    email:a.email,neak_provider_code:a.provider_code,clinic_name:providers.get(a.provider_code).name,
    hsz_service_codes:(a.service_ids || []).join('; '),county:[...new Set(providers.get(a.provider_code).services.map(s=>s.county))].join('; '),city:[...new Set(providers.get(a.provider_code).services.map(s=>s.city))].join('; '),address:[...new Set(providers.get(a.provider_code).services.map(s=>s.address))].join('; '),contact_role:a.contact_role || 'unknown',owner_name:a.owner_name || '',
    source_urls:[...new Set([...(a.evidence || []).map(e => e.source_url),...(a.evidence_urls || [])].filter(safeSourceUrl))].join('; '),
    association_reviewed_at:a.reviewed_at || '',association_reviewed_by:a.reviewed_by || '',association_source:a.source || 'manual',contact_purpose:a.contact_purpose||'',
  }));
}
export function validateAssociationPackage(pkg, manifest) {
  if (pkg?.format !== 'lead-gen-email-associations' || pkg.schema_version !== 1 || pkg.country !== 'HU' || pkg.dataset_id !== manifest.dataset_id || pkg.base_data_hash !== manifest.base_data_hash) throw Error('Clinic mapping package does not match this dataset.');
  if (![pkg.providers,pkg.associations,pkg.items].every(Array.isArray)) throw Error('Incomplete clinic mapping package.');
  const codes=new Set();for(const p of pkg.providers){if(!/^[A-Z0-9]{4}$/.test(p.code)||codes.has(p.code)||!Array.isArray(p.services))throw Error('Invalid or duplicate provider.');codes.add(p.code);}
  const ids=new Set();for(const a of pkg.associations){if(a.id!==associationKey(a.email,a.provider_code)||ids.has(a.id)||!codes.has(a.provider_code)||!['confirmed','rejected','unreviewed'].includes(a.status))throw Error('Invalid or duplicate clinic association.');if(a.identity_match)validateIdentityMatch(a.identity_match,pkg.providers.find(p=>p.code===a.provider_code));ids.add(a.id);}
  return pkg;
}

export const identityTiers = {corroborated:90,reviewed_record:85,source_name:70,email_name:60,profile_name:30,ambiguous:10,historical:0};
export function associationRank(a) {
  if(a.status==='confirmed')return 1000;
  if(a.status==='rejected')return -1000;
  return identityTiers[a.identity_match?.tier] ?? (a.confidence==='corroborated'?80:0);
}
export function associationEvidence(a) {
  return [...(a?.evidence||[])].sort((a,b)=>(identityTiers[b.identity_match?.tier]??-1)-(identityTiers[a.identity_match?.tier]??-1));
}
export function validateIdentityMatch(value,provider) {
  if(value.version!==1||!Object.hasOwn(identityTiers,value.tier)||value.human_verified!==false||value.account_key!=='HU:'+provider.code||!Array.isArray(value.doctor_names)||!value.doctor_names.length||value.doctor_names.some(name=>!provider.services.some(s=>s.doctor===name))||!Array.isArray(value.service_ids)||value.service_ids.some(id=>!provider.services.some(s=>s.hsz===id)))throw Error('Invalid doctor-to-account inference.');
}

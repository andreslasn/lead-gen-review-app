"""Build email-to-NEAK association candidates without changing email validity.

Run with --package, --board and --output. Optional --research JSON supplies
reviewed public evidence. Generated data is local review material, not code.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import unicodedata


def normalized(value):
    return re.sub(r'[^a-z0-9]+', ' ', unicodedata.normalize('NFKD', str(value or '')).encode('ascii', 'ignore').decode().lower()).strip()


def email_key(value):
    return str(value or '').strip().lower()


def pair_key(email, code):
    return email_key(email)+'|HU|'+code


def build(package, board, research=None):
    manifest=json.loads((package/'manifest.json').read_text())
    index=json.loads((package/'email-index.json').read_text())['items']
    clinic_index={r['id']:r for r in json.loads((package/'clinic-index.json').read_text())['items']}
    providers={};services=defaultdict(set);identities=defaultdict(set)
    for record in board['records']:
        if record['fields'].get('country')!='HU':continue
        code=record['fields']['institution_code'];rows=record.get('source_services',[])
        # Export only public directory identity, never private dashboard sales fields.
        p=dict(code=code,name=rows[0]['values'].get('Szolgáltató neve','') if rows else '',services=[])
        for row in rows:
            v=row['values'];hsz=str(v.get('Szervezti egység kódja (HSZ kód)','')).strip()
            s=dict(hsz=hsz,doctor=v.get('Háziorvos neve',''),city=v.get('Háziorvosi rendelő székhelye (település)',''),address=v.get('Háziorvosi rendelő címe',''),county=v.get('Vármegye',''))
            p['services'].append(s);services[hsz].add(code)
            doctor=normalized(s['doctor']).removeprefix('dr ')
            if doctor and doctor!='betoltetlen':identities[(doctor,normalized(s['city']))].add(code)
        providers[code]=p
    rows_by_email={};pairs={}
    def candidate(email,code):
        key=pair_key(email,code)
        if key not in pairs:pairs[key]=dict(id=key,email=email,provider_code=code,country='HU',clinic_ids=[],service_ids=[],evidence=[],status='unreviewed',reason='Registry-linked occurrence; email ownership still needs review.',confidence='candidate',contact_role='unknown')
        return pairs[key]
    payload_cache={}
    def clinic_payload(cid):
        if cid not in payload_cache:
            p=package/'clinics'/f'{cid}.json'
            payload_cache[cid]=json.loads(p.read_text()) if p.exists() else {}
        return payload_cache[cid]
    for row in index:
        email=email_key(row['email']);rows_by_email[email]=dict(email=email,unlinked_occurrences=[],candidate_ids=[])
        for occurrence in row.get('occurrences',[]):
            cid=occurrence.get('clinic_id');hsz=str(occurrence.get('registry_id') or '')
            codes=services.get(hsz,set());basis='HSZ service → September NEAK provider'
            if not codes:
                doctor=normalized(occurrence.get('clinic_name')).removeprefix('dr ')
                codes=identities.get((doctor,normalized(occurrence.get('city'))),set())
                basis='Exact doctor name and town in September directory; identity needs review'
            if len(codes)!=1:
                rows_by_email[email]['unlinked_occurrences'].append(occurrence);continue
            code=next(iter(codes));c=candidate(email,code)
            if cid and cid not in c['clinic_ids']:c['clinic_ids'].append(cid)
            if hsz and hsz not in c['service_ids']:c['service_ids'].append(hsz)
            detail=clinic_payload(cid)
            contacts=[v for v in detail.get('candidates',[]) if email_key(v.get('value'))==email]
            contact=next((v for v in contacts if v.get('id')==occurrence.get('contact_point_id')),contacts[0] if contacts else {})
            quotes=[e.get('exact_quote','') for e in contact.get('evidence_links',[]) if e.get('exact_quote')]
            context=' '.join(quotes+[str(contact.get('evidence') or ''),str(contact.get('owner_name') or '')])
            direct=contact.get('association_type') in {'direct','practice_contact_for_person','clinic_contact'} and contact.get('verification_status') in {'corroborated','verified'}
            if direct:c.update(confidence='corroborated',reason='Clinic-specific contact evidence supports this registry association; reviewer confirmation required.')
            evidence=dict(clinic_id=cid,service_id=hsz,source_url=contact.get('source_url') or occurrence.get('source_url') or '',basis=basis,quote=context[:1200],owner_name=contact.get('owner_name') or '',contact_role=contact.get('contact_role') or '',association_type=contact.get('association_type') or '',observed_at=contact.get('observed_at') or '',verification_status=contact.get('verification_status') or '')
            if evidence not in c['evidence']:c['evidence'].append(evidence)
    # Preserve explicit clinic-level legacy decisions, not global email-valid buttons.
    decisions=json.loads((package/'canonical-review-state.json').read_text()).get('decisions',[])
    service_decisions={}
    for d in sorted(decisions,key=lambda d:(d.get('created_at') or '',d.get('id') or '')):
        email=email_key(d.get('reviewed_value') or d.get('original_value'))
        if email not in rows_by_email:continue
        origin=d.get('clinic_id');target=d.get('target_clinic_id')
        links=[(origin,'confirmed')] if d.get('decision') in {'confirmed','edited_confirmed'} else [(origin,'rejected'),(target,'confirmed')] if d.get('decision')=='reassigned' else []
        for cid,status in links:
            codes=services.get(str(clinic_index.get(cid,{}).get('registry_id') or ''),set())
            if len(codes)==1:service_decisions[(email,cid)]=(next(iter(codes)),status,d)
    provider_decisions=defaultdict(list)
    for (email,cid),(code,status,d) in service_decisions.items():provider_decisions[(email,code)].append((cid,status,d))
    for (email,code),entries in provider_decisions.items():
        c=candidate(email,code)
        confirmed=[e for e in entries if e[1]=='confirmed']
        cid,status,d=max(confirmed or entries,key=lambda e:(e[2].get('created_at') or '',e[2].get('id') or ''))
        # A wrong service does not rule out other services under the same provider.
        # Keep negative legacy decisions as evidence unless all candidate services were rejected.
        rejected_ids={e[0] for e in entries if e[1]=='rejected'}
        if not confirmed and (not c['clinic_ids'] or not set(c['clinic_ids'])<=rejected_ids):status='unreviewed'
        reviewer=d.get('reviewer_id') or ''
        human=bool(reviewer) and not reviewer.startswith(('machine-', 'external-'))
        if not human:status='unreviewed'
        c.update(status=status,confidence='human_reviewed' if status!='unreviewed' else 'candidate',reason='Existing explicit clinic-level '+d['decision']+' decision; provider includes all its services.',reviewed_at=d.get('created_at'),reviewed_by=d.get('reviewer_id'),source='legacy-clinic-review',source_decision_id=d.get('id'),note=d.get('note') or '')
        if not human:c.update(confidence='legacy_suggestion',reason='Earlier email validation or automated reassignment; clinic ownership requires reviewer confirmation.',source='legacy-mapping-suggestion')
        if cid and cid not in c['clinic_ids']:c['clinic_ids'].append(cid)
        hsz=str(clinic_index.get(cid,{}).get('registry_id') or '')
        if hsz and hsz not in c['service_ids']:c['service_ids'].append(hsz)
    for key,c in pairs.items():rows_by_email[c['email']]['candidate_ids'].append(key)
    result = dict(format='lead-gen-email-associations',schema_version=1,country='HU',dataset_id=manifest['dataset_id'],base_data_hash=manifest['base_data_hash'],generated_at=datetime.now(timezone.utc).isoformat(),registry_snapshot='2026-09',providers=list(providers.values()),items=list(rows_by_email.values()),associations=list(pairs.values()))

    return merge_research(result, research or {})


def compact_observation_evidence(evidence):
    """Share identical source payloads while preserving every observation ID."""
    result=[]
    grouped={}
    for entry in evidence:
        if not entry.get('observation_id'):
            if entry not in result: result.append(entry)
            continue
        payload={k:v for k,v in entry.items() if k not in ('observation_id','additional_observation_ids')}
        key=json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':'))
        ids={entry['observation_id'],*entry.get('additional_observation_ids',[])}
        if key not in grouped:
            grouped[key]=dict(entry)
            result.append(grouped[key])
        target=grouped[key]
        ids.update([target['observation_id'],*target.get('additional_observation_ids',[])])
        additional=sorted(ids-{target['observation_id']})
        if additional: target['additional_observation_ids']=additional
    return result


IDENTITY_TIERS = {"corroborated":90,"reviewed_record":85,"source_name":70,"email_name":60,"profile_name":30,"ambiguous":10,"historical":0}


def merge_research(result, research):
    """Append evidence by stable pair ID; never replace a reviewed base or event."""
    import copy
    result=copy.deepcopy(result)
    rows={r['email']:r for r in result['items']}
    pairs={r['id']:r for r in result['associations']}
    providers={p['code']:p for p in result['providers']}
    for finding in research.get('findings',[]):
        email=email_key(finding['email']);code=finding['provider_code']
        if code not in providers or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):continue
        row=rows.setdefault(email,dict(email=email,unlinked_occurrences=[],candidate_ids=[],email_validity='unknown',research_intake=True))
        key=pair_key(email,code)
        c=pairs.setdefault(key,dict(id=key,email=email,provider_code=code,country='HU',clinic_ids=[],service_ids=[],evidence=[],status='unreviewed',confidence='researched',contact_role='unknown',reason=finding.get('reason','Public contact evidence; account ownership needs review.')))
        e=finding['evidence']
        if e not in c['evidence']:c['evidence'].append(e)
        identity=e.get('identity_match')
        if identity and identity.get('version')==1 and identity.get('account_key')=='HU:'+code and identity.get('human_verified') is False and identity.get('tier') in IDENTITY_TIERS:
            previous=c.get('identity_match',{})
            if not previous or IDENTITY_TIERS[identity['tier']]>IDENTITY_TIERS.get(previous.get('tier'),-1):c['identity_match']=copy.deepcopy(identity)
        if e.get('clinic_id') and e['clinic_id'] not in c['clinic_ids']:c['clinic_ids'].append(e['clinic_id'])
        for hsz in [e.get('service_id')]+e.get('service_ids',[]):
            if hsz and hsz not in c['service_ids']:c['service_ids'].append(hsz)
        if c['status']=='unreviewed' and c.get('confidence')!='human_reviewed':
            c.update(confidence='researched',reason=finding.get('reason',c.get('reason','')))
        if key not in row['candidate_ids']:row['candidate_ids'].append(key)
    for candidate in pairs.values():
        candidate['evidence']=compact_observation_evidence(candidate['evidence'])
    result.update(items=list(rows.values()),associations=list(pairs.values()))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['package','board','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--research',type=Path)
    parser.add_argument('--existing',type=Path,help='Preserve an existing association package and append research evidence')
    args=parser.parse_args();research=json.loads(args.research.read_text()) if args.research else {}
    result=merge_research(json.loads(args.existing.read_text()),research) if args.existing else build(args.package,json.loads(args.board.read_text()),research)
    manifest=json.loads((args.package/'manifest.json').read_text())
    if any(result[k]!=manifest[k] for k in ('dataset_id','base_data_hash')):raise ValueError('Existing package belongs to a different dataset')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temporary=args.output.with_suffix('.tmp');temporary.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n');temporary.chmod(0o600);temporary.replace(args.output)
    print(json.dumps(dict(emails=len(result['items']),associations=len(result['associations']),providers=len(result['providers']),human_confirmed=sum(c['status']=='confirmed' for c in result['associations']),unlinked_emails=sum(not e['candidate_ids'] for e in result['items']))))

if __name__=='__main__':main()

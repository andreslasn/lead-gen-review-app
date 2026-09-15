import json
from pathlib import Path
import tempfile
import unittest
import importlib.util
spec=importlib.util.spec_from_file_location("email_associations",Path(__file__).parents[1]/"scripts"/"email_associations.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
build=module.build

class AssociationTests(unittest.TestCase):
 def test_registry_crosswalk_legacy_reassignment_and_suggestions(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp);(p/'clinics').mkdir()
   def write(name,value):(p/name).write_text(json.dumps(value))
   write('manifest.json',dict(dataset_id='synthetic',base_data_hash='hash'))
   write('clinic-index.json',dict(items=[dict(id='c1',registry_id='000000001'),dict(id='c2',registry_id='000000002')]))
   email='shared@example.invalid';unreviewed='candidate@example.invalid'
   occ=[dict(clinic_id='c1',registry_id='000000001'),dict(clinic_id='c2',registry_id='000000002')]
   write('email-index.json',dict(items=[dict(email=email,occurrences=occ),dict(email=unreviewed,occurrences=occ[:1])]))
   write('canonical-review-state.json',dict(decisions=[dict(id='d1',reviewer_id='human-reviewer',clinic_id='c1',target_clinic_id='c2',decision='reassigned',reviewed_value=email,created_at='2026-01-01')]))
   def service(hsz):return dict(values={'Szervezti egység kódja (HSZ kód)':hsz,'Szolgáltató neve':'Synthetic provider','Háziorvos neve':'Doctor Synthetic','Háziorvosi rendelő székhelye (település)':'Town'})
   board=dict(records=[dict(fields=dict(country='HU',institution_code='A001',sales_comments='PRIVATE MUST NOT EXPORT'),source_services=[service('000000001'),service('000000002')])])
   result=build(p,board);pairs={r['email']:r for r in result['associations']}
   self.assertEqual('confirmed',pairs[email]['status'])
   self.assertEqual('unreviewed',pairs[unreviewed]['status'])
   self.assertEqual('A001',pairs[email]['provider_code']);self.assertEqual(1,len(result['providers']))
   self.assertNotIn('PRIVATE MUST NOT EXPORT',json.dumps(result))
   for reviewer in ['machine-cross-clinic-reconcile-v1','external-reviewer','']:
    write('canonical-review-state.json',dict(decisions=[dict(id='d1',reviewer_id=reviewer,clinic_id='c1',target_clinic_id='c2',decision='reassigned',reviewed_value=email,created_at='2026-01-01')]))
    suggested=build(p,board)
    self.assertEqual('unreviewed',next(r for r in suggested['associations'] if r['email']==email)['status'])
   researched=build(p,board,dict(findings=[dict(email=unreviewed,provider_code='A001',evidence=dict(source_url='https://example.invalid/',quote='Evidence'))]))
   match=next(r for r in researched['associations'] if r['email']==unreviewed)
   self.assertEqual('researched',match['confidence']);self.assertEqual('unreviewed',match['status'])
   # Missing source IDs remain reviewable without assigning a provider.
   write('email-index.json',dict(items=[dict(email=unreviewed,occurrences=[dict(clinic_id='missing',registry_id='999999999')])]))
   missing=build(p,board)
   self.assertEqual([],missing['associations']);self.assertEqual(1,len(missing['items'][0]['unlinked_occurrences']))

class ResearchMergeTests(unittest.TestCase):
 def test_refresh_preserves_decisions_and_accepts_new_emails_without_validity(self):
  email='existing@example.invalid';key=email+'|HU|A001'
  original=dict(providers=[dict(code='A001')],items=[dict(email=email,candidate_ids=[key])],associations=[dict(id=key,email=email,provider_code='A001',status='rejected',confidence='human_reviewed',clinic_ids=[],service_ids=[],evidence=[])])
  finding=lambda value:dict(email=value,provider_code='A001',evidence=dict(source_url='https://example.invalid/',service_id='001',quote='Synthetic'))
  result=module.merge_research(original,dict(findings=[finding(email),finding('new@example.invalid')]))
  self.assertEqual('rejected',result['associations'][0]['status']);self.assertEqual([],original['associations'][0]['evidence'])
  self.assertEqual('unknown',result['items'][1]['email_validity']);self.assertEqual('unreviewed',result['associations'][1]['status'])
  again=module.merge_research(result,dict(findings=[finding(email)]));self.assertEqual(result,again)

class EvidenceCompactionTests(unittest.TestCase):
 def test_exact_payloads_keep_all_observation_ids_and_distinct_scope(self):
  first=dict(source_url='https://example.invalid/',quote='Synthetic contact',service_id='001',observation_id='old')
  second={**first,'observation_id':'new'}
  other={**second,'service_id':'002','observation_id':'other'}
  compact=module.compact_observation_evidence([first,second,other])
  self.assertEqual(2,len(compact))
  self.assertEqual('old',compact[0]['observation_id'])
  self.assertEqual(['new'],compact[0]['additional_observation_ids'])
  self.assertNotIn('additional_observation_ids',first)
  self.assertEqual(compact,module.compact_observation_evidence(compact+[second]))
  changed={**second,'observed_at':'2026-09-15'}
  self.assertEqual(3,len(module.compact_observation_evidence(compact+[changed])))


if __name__=='__main__':unittest.main()

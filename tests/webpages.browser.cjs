const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gzipSync}=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const market=process.env.REVIEW_TEST_MARKET||'LV',marketLabel=market==='PL'?'Poland':'Latvia';
const origin=process.env.REVIEW_TEST_URL||'http://127.0.0.1:5173/lead-gen-review-app/';

(async()=>{
 const {lvPackage}=await import('./lvFixtures.mjs'),full=market==='PL'?JSON.parse(JSON.stringify(lvPackage()).replaceAll('LV:','PL:').replaceAll('\"LV\"','\"PL\"').replaceAll('synthetic-lv','synthetic-pl').replaceAll('lv-hash','pl-hash')):lvPackage();
 if(market==='PL'){const a=full.accounts[0];a.business_entity_code='1234563218';a.locations=[];a.claims.push({...a.claims[0],claim_id:'d'.repeat(64),field:'email',value:'practice@example.invalid'}, {...a.claims[0],claim_id:'f'.repeat(64),field:'practice_software',value:'Synthetic PL booking',attribution:{version:1,status:'attributable_candidate',eligible_for_analytics:true,scope:'account',service_ids:[],current_use_verified:false,all_panels_verified:false,reasons:['Named account'],proofs:[]}});a.contact_reconciliation={version:1,groups:[{id:'8'.repeat(64),field:'email',value:'practice@example.invalid',role:'practice',strength:'strong',claim_ids:['d'.repeat(64)],proofs:[]}],recommended:{email:null,website:null,telephone:null},lanes:[]};}
 const pkg=structuredClone(full),details={};
 pkg.evidence_storage='account-files-v1';
 pkg.accounts=pkg.accounts.map(a=>{const raw=JSON.stringify({format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(a)).toString('base64')}),hash=createHash('sha256').update(raw).digest('hex'),relative='account-evidence/'+market+'-'+a.dashboard_record_id+'-'+hash.slice(0,16)+'.json';details[relative]=raw;return {...a,claims:a.claims.map(({observations,...c})=>c),evidence_path:relative,evidence_sha256:hash,evidence_encoding:'gzip-base64-v1'};});
 const email='reviewed@example.invalid',occurrence={clinic_id:'synthetic',contact_point_id:'contact',clinic_name:'Hungary Clinic',city:'Budapest',region:'Budapest',source_url:'https://example.invalid/'};
 const hu={
  'manifest.json':{format:'lead-gen-review-package',schema_version:1,country:'HU',dataset_id:'synthetic-hu',base_data_hash:'hu-hash'},
  'package-integrity.json':{dataset_id:'synthetic-hu',country:'HU'},
  'email-review-queue.json':{items:[{email,display_value:email,clinic_id:'synthetic',contact_point_id:'contact',name:'Hungary Clinic',occurrences:[occurrence]}]},
  'email-validation-seed.json':{format:'lead-gen-email-validation-seed',schema_version:1,validations:[{email,status:'valid',reviewed_by:'original',reviewed_at:'2026-09-14T00:00:00Z',updated_at:'2026-09-14T00:00:00Z',note:'Keep this validation'}]},
  'campaign-email-usage.json':{format:'lead-gen-campaign-email-usage',schema_version:1,items:[{email,campaign_count:1,source_files:['synthetic.csv']}]},
  'canonical-review-state.json':{format:'lead-gen-clinic-review',schema_version:1,dataset_id:'synthetic-hu',base_data_hash:'hu-hash',decisions:[],clinic_states:[],field_decisions:[],audit_events:[]},
  'synthetic.json':{clinic:{id:'synthetic',name:'Hungary Clinic'},state:{status:'confirmed'},candidates:[{id:'contact',value:email,usable_contact:true,classification:'clinic_contact',evidence_links:[]}],documents:[]}
 };
 const browser=await chromium.launch(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'webpage-browser-'));
 try{
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();let failEvidence=true,failPackage=false;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(!url.href.startsWith(origin))return route.abort();
   if(url.pathname.includes('/data/markets/'+market+'/')){
    const relative=url.pathname.split('/data/markets/'+market+'/')[1];
    if(relative==='manifest.json')return route.fulfill({json:{...full,accounts:undefined}});
    if(relative==='account-enrichment.json')return route.fulfill(failPackage?{status:503,body:'Unavailable'}:{json:{format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(pkg)).toString('base64')}});
    if(details[relative])return route.fulfill(failEvidence?{status:503,body:'Unavailable'}:{contentType:'application/json',body:details[relative]});
    return route.fulfill({status:404,body:'{}'});
   }
   if(url.pathname.includes('/data/')){const item=hu[url.pathname.split('/').at(-1)];return route.fulfill(item?{json:item}:{status:404,body:'{}'});}
   if(url.pathname.endsWith('review-sync.json'))return route.fulfill({status:404,body:'{}'});
   return route.continue();
  });
  page.setDefaultTimeout(15000);await page.goto(origin);
  await page.getByRole('button',{name:/^Valid 1$/}).waitFor();await page.getByRole('button',{name:/^Valid 1$/}).click();await page.getByRole('button',{name:/^Used 1$/}).click();
  await page.getByText('Used in campaign',{exact:true}).waitFor();
  const saved=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('lead-gen-clinic-review');r.onsuccess=()=>resolve(r.result);});return new Promise(resolve=>{const r=db.transaction('email_validations').objectStore('email_validations').get('reviewed@example.invalid');r.onsuccess=()=>{db.close();resolve(r.result);};});});
  await page.getByLabel('Market',{exact:true}).selectOption(market);await page.getByRole('heading',{name:'Webpages · '+marketLabel}).waitFor();
  await page.getByRole('button',{name:'Retry evidence',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).isDisabled(),true);
  failEvidence=false;await page.getByRole('button',{name:'Retry evidence',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.webpage-identity .valid-btn')?.disabled);
  assert.match(await page.locator('.webpage-evidence blockquote').innerText(),/<script>unsafe\(\)<\/script>/);assert.equal(await page.locator('.webpage-evidence script').count(),0);
  const nav=page.getByRole('navigation',{name:'Webpage navigation'}),title=page.locator('.webpage-identity .email-title-row h2');
  const blur=()=>page.evaluate(()=>document.activeElement.blur());
  assert.equal(await nav.getByRole('button',{name:'Previous webpage'}).isDisabled(),true);
  assert.equal(await nav.getByRole('button',{name:'Next webpage'}).isDisabled(),true);
  await page.getByLabel('Page type',{exact:true}).selectOption('all');await blur();
  await page.keyboard.press('ArrowLeft');assert.equal(await title.innerText(),'https://example.invalid/a');
  await page.keyboard.press('1');assert.equal(await page.getByRole('button',{name:'Right clinic',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.webpage-state').innerText(),'unreviewed*');
  await page.getByLabel('Book an appointment',{exact:true}).check();await page.getByLabel('Booking / service provider',{exact:true}).fill('Unsaved provider');await blur();
  await page.keyboard.press('ArrowRight');assert.equal(await title.innerText(),'https://example.invalid/c');
  assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('Book an appointment',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('Booking / service provider',{exact:true}).count(),0);
  await page.keyboard.press('ArrowRight');assert.equal(await title.innerText(),'https://example.invalid/c');
  await nav.getByRole('button',{name:'Previous webpage'}).focus();await page.keyboard.press('Enter');
  assert.equal(await title.innerText(),'https://example.invalid/a');assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).isDisabled(),true);
  await nav.getByRole('button',{name:'Next webpage'}).click();assert.equal(await title.innerText(),'https://example.invalid/c');
  await blur();await page.keyboard.press('Control+ArrowLeft');assert.equal(await title.innerText(),'https://example.invalid/c');
  await page.keyboard.press('ArrowLeft');assert.equal(await title.innerText(),'https://example.invalid/a');
  await page.getByRole('searchbox').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
  assert.equal(await title.innerText(),'https://example.invalid/a');assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).isDisabled(),true);
  await page.getByLabel('Page role',{exact:true}).focus();await page.keyboard.press('1');assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).isDisabled(),true);
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(el=>el.scrollWidth<=innerWidth));}
  const layout=await page.locator('.webpage-review .review-layout').evaluate(el=>{const a=el.querySelector('.decision-pane').getBoundingClientRect(),b=el.querySelector('.evidence-pane').getBoundingClientRect();return {sideBySide:b.left>=a.right,aligned:Math.abs(a.top-b.top)<1};});
  assert.deepEqual(layout,{sideBySide:true,aligned:true});
  await page.setViewportSize({width:375,height:900});await page.screenshot({path:'/tmp/latvia-webpage-mobile-synthetic.png',fullPage:true});await page.setViewportSize({width:1440,height:900});
  await page.getByLabel('Page type',{exact:true}).selectOption('practice_website');
  await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 1',exact:true}).click();
  await page.getByLabel('Book an appointment',{exact:true}).check();await page.getByLabel('Send a general enquiry',{exact:true}).check();await page.getByLabel('Booking / service provider',{exact:true}).fill('Synthetic booking');
  await blur();await page.keyboard.press('1');
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true})));
  assert.equal(await page.locator('.webpage-state').innerText(),'unreviewed*');
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='confirmed');
  let download=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();const exported=await download;await exported.saveAs(path.join(temp,'lv.json'));const payload=JSON.parse(fs.readFileSync(path.join(temp,'lv.json')));
  assert.equal(payload.dataset_id,'synthetic-'+market.toLowerCase());assert.equal(payload.field_decisions.length,1);assert.deepEqual(payload.field_decisions[0].webpage_capabilities,{version:1,actions:['book_appointment','general_enquiry'],provider:'Synthetic booking'});assert.equal(payload.email_validations.length,0);assert.equal(payload.association_decisions.length,0);
  await page.reload();await page.getByRole('heading',{name:'Webpages · '+marketLabel}).waitFor();await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='confirmed');
  assert.equal(await page.getByLabel('Book an appointment',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('Booking / service provider',{exact:true}).inputValue(),'Synthetic booking');
  await page.getByRole('button',{name:'Wrong clinic',exact:true}).focus();await page.keyboard.press('2');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Rejected 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='rejected');
  await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(path.join(temp,'lv.json'));await page.waitForTimeout(150);assert.equal(await page.locator('.webpage-state').innerText(),'rejected');
  const bad={...payload,email_validations:[{email,status:'invalid'}]};fs.writeFileSync(path.join(temp,'bad.json'),JSON.stringify(bad));await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(path.join(temp,'bad.json'));await page.getByRole('alert').filter({hasText:'cannot contain other review data'}).waitFor();
  await page.getByLabel('Page type',{exact:true}).selectOption('source_page');await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 1',exact:true}).click();await page.getByText('Confirming verifies this source’s relevance to the account. It does not designate an official website.',{exact:true}).waitFor();
  await page.getByLabel('Page role',{exact:true}).selectOption('practice_website');await page.getByRole('button',{name:'Right clinic',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.getByLabel('Page type',{exact:true}).selectOption('practice_website');await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 2',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/latvia-webpage-candidate-synthetic.png',fullPage:true});
  await page.getByRole('button',{name:'Leave unresolved',exact:true}).click();assert.equal(await page.locator('.webpage-state').innerText(),'rejected');
  await page.getByRole('button',{name:'Confirm unresolved',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='unreviewed*');
  await page.getByLabel('Page role',{exact:true}).selectOption('directory_profile');
  await page.getByLabel('No capability observed',{exact:true}).check();assert.equal(await page.getByLabel('Book an appointment',{exact:true}).isChecked(),false);assert.equal(await page.getByLabel('Booking / service provider',{exact:true}).count(),0);
  await page.getByLabel('Unclear',{exact:true}).check();assert.equal(await page.getByLabel('No capability observed',{exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'Right clinic',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByLabel('Page type',{exact:true}).selectOption('directory_profile');await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();assert.equal(await page.getByLabel('Page role',{exact:true}).inputValue(),'directory_profile');
  await page.getByLabel('Page role',{exact:true}).selectOption('organisation_profile');await page.getByLabel('Request an appointment',{exact:true}).check();assert.equal(await page.getByLabel('Unclear',{exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.getByLabel('Page type',{exact:true}).selectOption('organisation_profile');await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();
  download=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();const classified=await download;await classified.saveAs(path.join(temp,'classified.json'));
  const latest=JSON.parse(fs.readFileSync(path.join(temp,'classified.json'))).field_decisions.find(e=>e.contact_role==='organisation_profile');assert.equal(latest.contact_role,'organisation_profile');assert.deepEqual(latest.webpage_capabilities,{version:1,actions:['request_appointment'],provider:''});
  await page.reload();await page.getByLabel('Page type',{exact:true}).selectOption('organisation_profile');await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();assert.equal(await page.getByLabel('Request an appointment',{exact:true}).isChecked(),true);
  if(market==='LV'){
   await page.getByRole('button',{name:'Not ICP',exact:true}).click();
   assert.equal(await page.getByLabel('Page role',{exact:true}).inputValue(),'not_icp');
   await page.getByRole('button',{name:'Right clinic',exact:true}).click();assert.equal(await page.getByLabel('Page role',{exact:true}).inputValue(),'practice_website');
   await page.getByRole('button',{name:'Not ICP',exact:true}).click();await page.getByRole('button',{name:'Confirm',exact:true}).click();
   await page.getByLabel('Page type',{exact:true}).selectOption('not_icp');await page.getByRole('button',{name:'Confirmed 1',exact:true}).waitFor();
   await page.getByText('The linked organisation is outside our target profile. This keeps the account in the market list.',{exact:true}).waitFor();
   download=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();
   const file=path.join(temp,'not-icp.json');await (await download).saveAs(file);
   const exported=JSON.parse(fs.readFileSync(file));assert.ok(exported.field_decisions.some(e=>e.contact_role==='not_icp'&&e.status==='confirmed'));
   await page.reload();await page.getByLabel('Page type',{exact:true}).selectOption('not_icp');await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Not ICP',exact:true}).getAttribute('aria-pressed'),'true');
   await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(file);
   assert.equal(await page.getByLabel('Page role',{exact:true}).inputValue(),'not_icp');
  }else assert.equal(await page.getByRole('button',{name:'Not ICP',exact:true}).count(),0);
  await page.getByLabel('Page type',{exact:true}).selectOption('missing');await page.getByText('Website not yet identified. This does not establish that the practice has no website.',{exact:true}).waitFor();
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(el=>el.scrollWidth<=innerWidth));}
  await page.screenshot({path:'/tmp/latvia-webpage-review-synthetic.png',fullPage:true});
  if(market==='PL'){
   await page.getByRole('button',{name:'Account data',exact:true}).click();
   await page.getByRole('button',{name:'Synthetic Latvia Practice · PL:'+ '1'.repeat(20),exact:false}).click();
   await page.getByText('Other contacts and alternatives (1)',{exact:true}).click();
   const card=page.locator('.contact-review-card').filter({hasText:'practice@example.invalid'});
   await card.getByRole('button',{name:'Confirm clinic link',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.contact-review-card .contact-review-meta')?.textContent.includes('confirmed'));
   await card.getByRole('button',{name:'Use as preferred',exact:true}).click();
   await page.getByLabel('Account review section',{exact:true}).selectOption('other');
   await page.getByRole('button',{name:'Confirm account attribution',exact:true}).click();
   const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();await (await downloaded).saveAs(path.join(temp,'pl-account.json'));
   const accountExport=JSON.parse(fs.readFileSync(path.join(temp,'pl-account.json')));assert.equal(accountExport.contact_preferences.length,1);assert.ok(accountExport.field_decisions.some(e=>e.field==='email'&&e.status==='confirmed'));assert.ok(accountExport.field_decisions.some(e=>e.field==='practice_software'&&e.status==='confirmed'));assert.deepEqual(accountExport.email_validations,[]);
   await page.getByRole('button',{name:'Webpages',exact:true}).click();await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(path.join(temp,'pl-account.json'));await page.waitForTimeout(100);
  }

  await page.getByLabel('Market',{exact:true}).selectOption('HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  download=page.waitForEvent('download');await page.getByRole('button',{name:'Export .json',exact:true}).click();const huDownload=await download;await huDownload.saveAs(path.join(temp,'hu.json'));const huExport=JSON.parse(fs.readFileSync(path.join(temp,'hu.json')));
  assert.equal(huExport.dataset_id,'synthetic-hu');assert.equal(huExport.field_decisions.length,0);assert.equal(huExport.email_validations[0].status,'valid');assert.equal(huExport.email_validations[0].note,saved.note);
  await page.getByRole('button',{name:'Account data',exact:true}).click();
  await page.getByLabel('Market',{exact:true}).selectOption(market);await page.getByLabel('Page type',{exact:true}).selectOption('all');await page.getByRole('button',{name:'All 2',exact:true}).click();
  await blur();await page.keyboard.press('ArrowRight');assert.equal(await title.innerText(),'https://example.invalid/c');
  await page.goto(origin+'#/clinics/synthetic');await page.reload();assert.equal(await page.getByLabel('Market',{exact:true}).inputValue(),'HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  failPackage=true;await page.goto(origin+'#market='+market);await page.reload();await page.getByRole('button',{name:'Retry '+marketLabel+' data',exact:true}).waitFor();await page.getByLabel('Market',{exact:true}).selectOption('HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log(market+' webpage browser checks passed: shared HU layout, arrow buttons/keys, guarded shortcuts, choice/confirmation, market isolation, saved evidence, failure/retry, decisions, reload, JSON round trip, protected HU validation/usage, legacy links and mobile layout.');
 }finally{await browser.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gzipSync}=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.REVIEW_TEST_URL||'http://127.0.0.1:5173/lead-gen-review-app/';

(async()=>{
 const {lvPackage}=await import('./lvFixtures.mjs'),full=lvPackage(),pkg=structuredClone(full),details={};
 pkg.evidence_storage='account-files-v1';
 pkg.accounts=pkg.accounts.map(a=>{const raw=JSON.stringify({format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(a)).toString('base64')}),hash=createHash('sha256').update(raw).digest('hex'),relative='account-evidence/LV-'+a.dashboard_record_id+'-'+hash.slice(0,16)+'.json';details[relative]=raw;return {...a,claims:a.claims.map(({observations,...c})=>c),evidence_path:relative,evidence_sha256:hash,evidence_encoding:'gzip-base64-v1'};});
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
   if(url.pathname.includes('/data/markets/LV/')){
    const relative=url.pathname.split('/data/markets/LV/')[1];
    if(relative==='manifest.json')return route.fulfill({json:{...full,accounts:undefined}});
    if(relative==='account-enrichment.json')return route.fulfill(failPackage?{status:503,body:'Unavailable'}:{json:pkg});
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
  await page.getByLabel('Market',{exact:true}).selectOption('LV');await page.getByRole('heading',{name:'Webpages · Latvia'}).waitFor();
  await page.getByRole('button',{name:'Retry evidence',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Confirm association',exact:true}).isDisabled(),true);
  failEvidence=false;await page.getByRole('button',{name:'Retry evidence',exact:true}).click();await page.getByRole('button',{name:'Confirm association',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.webpage-identity .mapping-actions button')?.disabled);
  assert.match(await page.locator('.webpage-evidence blockquote').innerText(),/<script>unsafe\(\)<\/script>/);assert.equal(await page.locator('.webpage-evidence script').count(),0);
  await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 1',exact:true}).click();
  await page.getByRole('button',{name:'Confirm association',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='confirmed');
  let download=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();const exported=await download;await exported.saveAs(path.join(temp,'lv.json'));const payload=JSON.parse(fs.readFileSync(path.join(temp,'lv.json')));
  assert.equal(payload.dataset_id,'synthetic-lv');assert.equal(payload.field_decisions.length,1);assert.equal(payload.email_validations.length,0);assert.equal(payload.association_decisions.length,0);
  await page.reload();await page.getByRole('heading',{name:'Webpages · Latvia'}).waitFor();await page.getByRole('button',{name:'Confirmed 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='confirmed');
  await page.getByRole('button',{name:'Reject association',exact:true}).click();await page.getByRole('button',{name:'Rejected 1',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.webpage-state')?.textContent==='rejected');
  await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(path.join(temp,'lv.json'));await page.waitForTimeout(150);assert.equal(await page.locator('.webpage-state').innerText(),'rejected');
  const bad={...payload,email_validations:[{email,status:'invalid'}]};fs.writeFileSync(path.join(temp,'bad.json'),JSON.stringify(bad));await page.getByLabel('Import review JSON',{exact:true}).setInputFiles(path.join(temp,'bad.json'));await page.getByRole('alert').filter({hasText:'cannot contain other review data'}).waitFor();
  await page.getByLabel('Page type',{exact:true}).selectOption('source_page');await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 1',exact:true}).click();await page.getByText('Confirming verifies this source’s relevance to the account. It does not designate an official website.',{exact:true}).waitFor();
  await page.getByLabel('Page role',{exact:true}).selectOption('practice_website');await page.getByRole('button',{name:'Confirm association',exact:true}).click();await page.getByLabel('Page type',{exact:true}).selectOption('practice_website');await page.getByRole('group',{name:'Webpage review status'}).getByRole('button',{name:'All 2',exact:true}).waitFor();
  await page.screenshot({path:'/tmp/latvia-webpage-candidate-synthetic.png',fullPage:true});
  await page.getByLabel('Page type',{exact:true}).selectOption('missing');await page.getByText('Website not yet identified. This does not establish that the practice has no website.',{exact:true}).waitFor();
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(el=>el.scrollWidth<=innerWidth));}
  await page.screenshot({path:'/tmp/latvia-webpage-review-synthetic.png',fullPage:true});
  await page.getByLabel('Market',{exact:true}).selectOption('HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  download=page.waitForEvent('download');await page.getByRole('button',{name:'Export .json',exact:true}).click();const huDownload=await download;await huDownload.saveAs(path.join(temp,'hu.json'));const huExport=JSON.parse(fs.readFileSync(path.join(temp,'hu.json')));
  assert.equal(huExport.dataset_id,'synthetic-hu');assert.equal(huExport.field_decisions.length,0);assert.equal(huExport.email_validations[0].status,'valid');assert.equal(huExport.email_validations[0].note,saved.note);
  await page.getByLabel('Market',{exact:true}).selectOption('LV');await page.goto(origin+'#/clinics/synthetic');await page.reload();assert.equal(await page.getByLabel('Market',{exact:true}).inputValue(),'HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  failPackage=true;await page.goto(origin+'#market=LV');await page.reload();await page.getByRole('button',{name:'Retry Latvia data',exact:true}).waitFor();await page.getByLabel('Market',{exact:true}).selectOption('HU');await page.getByText('Used in campaign',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('LV webpage browser checks passed: market isolation, saved evidence, failure/retry, decisions, reload, JSON round trip, protected HU validation/usage, legacy links and mobile layout.');
 }finally{await browser.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});

const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {gzipSync}=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/andreslasn/.npm/_npx/420ff84f11983ee5/node_modules/playwright');
const origin=process.env.REVIEW_TEST_URL || 'http://127.0.0.1:5173/lead-gen-review-app/';
const email='shared@example.invalid',key=email+'|HU|A001';
const occurrence={clinic_id:'synthetic',contact_point_id:'contact',clinic_name:'Synthetic Clinic',registry_id:'000000001',city:'Town',region:'Test',address:'Example 1',source_url:'https://example.invalid/'};
const item={email,display_value:email,clinic_id:'synthetic',contact_point_id:'contact',name:'Synthetic Clinic',occurrence_count:1,occurrences:[occurrence]};
const pkg={format:'lead-gen-email-associations',schema_version:1,country:'HU',dataset_id:'synthetic',base_data_hash:'hash',registry_snapshot:'2026-09',providers:[{code:'A001',name:'Synthetic Clinic A',services:[{hsz:'000000001',doctor:'Synthetic Doctor',city:'Town',address:'Example 1',county:'Test'}]},{code:'B002',name:'Synthetic Clinic B',services:[{hsz:'000000002',doctor:'Second Doctor',city:'Other Town',address:'Example 2',county:'Test'}]}],items:[{email,unlinked_occurrences:[],candidate_ids:[key]}],associations:[{id:key,email,provider_code:'A001',country:'HU',status:'unreviewed',confidence:'candidate',contact_role:'shared_contact',contact_purpose:'shared',owner_name:'Synthetic Reception',note:'Retained note',clinic_ids:['synthetic'],service_ids:['000000001'],evidence:[{clinic_id:'synthetic',source_url:'https://example.invalid/',quote:'Synthetic contact evidence',basis:'Synthetic source'}]}]};
const canonical={format:'lead-gen-clinic-review',schema_version:1,dataset_id:'synthetic',dataset_version:'1',base_data_hash:'hash',reviewer:{id:'test'},exported_at:'2026-09-14T10:00:00Z',decisions:[],clinic_states:[],audit_events:[]};
const payloads={
 'manifest.json':{format:'lead-gen-review-package',schema_version:1,country:'HU',dataset_id:'synthetic',dataset_version:'1',base_data_hash:'hash'},
 'package-integrity.json':{dataset_id:'synthetic',country:'HU'},
 'email-review-queue.json':{items:[item,{...item,email:'unmatched@example.invalid',display_value:'unmatched@example.invalid',clinic_id:null,contact_point_id:null,occurrences:[]}]},
 'email-validation-seed.json':{format:'lead-gen-email-validation-seed',schema_version:1,validations:[{email:'unmatched@example.invalid',display_value:'unmatched@example.invalid',status:'valid',updated_at:'2026-09-14T10:00:00Z'},{email,display_value:email,status:'valid',updated_at:'2026-09-14T10:00:00Z',reviewed_at:'2026-09-14T10:00:00Z'}]},
 'campaign-email-usage.json':{format:'lead-gen-campaign-email-usage',schema_version:1,items:[]},
 'canonical-review-state.json':canonical,
 'email-associations.json':pkg,
 'account-enrichment.json':{format:'lead-gen-account-enrichment',schema_version:1,dataset_id:'synthetic',base_data_hash:'hash',registry_snapshot:'2026-09',accounts:[{account_key:'HU:A001',provider_code:'A001',name:'Synthetic Clinic A',services:pkg.providers[0].services,coverage:'Synthetic saved source',claims:[{claim_id:'a'.repeat(64),account_key:'HU:A001',hsz:'000000001',field:'practice_software',value:'Synthetic software',review_status:'unreviewed',observations:[{observation_id:'b'.repeat(64),source_url:'https://example.invalid/',evidence:'Synthetic software source',retrieved_at:'2026-09-14',method:'synthetic'}]}]}]},
 'synthetic.json':{clinic:{id:'synthetic',name:'Synthetic Clinic',registry_id:'000000001'},state:{status:'confirmed'},candidates:[{id:'contact',value:email,usable_contact:true,classification:'clinic_contact',evidence_links:[]}],documents:[]}
};
function indexAccountEvidence(full,snapshot){
 payloads['account-enrichment.json']={...full,research_snapshot_id:snapshot,evidence_storage:'account-files-v1',accounts:full.accounts.map(a=>{const encoded={format:'lead-gen-account-evidence-gzip',schema_version:1,data:gzipSync(JSON.stringify(a)).toString('base64')},text=JSON.stringify(encoded),hash=createHash('sha256').update(text).digest('hex'),name=a.provider_code+'-'+hash.slice(0,16)+'.json';payloads[name]=encoded;return {...a,claims:a.claims.map(({observations,...c})=>c),evidence_path:'account-evidence/'+name,evidence_sha256:hash,evidence_encoding:'gzip-base64-v1'};})};
 payloads['account-research-status.json']={dataset_id:full.dataset_id,base_data_hash:full.base_data_hash,research_snapshot_id:snapshot};
}
const fullAccountEvidence=structuredClone(payloads['account-enrichment.json']);
indexAccountEvidence(fullAccountEvidence,'c'.repeat(64));
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||undefined});try{
const context=await browser.newContext({acceptDownloads:true});
// Start with the old database schema and a reviewer record to verify non-destructive migration.
await context.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','yes');const r=indexedDB.open('lead-gen-clinic-review',2);r.onupgradeneeded=()=>{for(const [name,key] of [['decisions','id'],['clinic_states','clinic_id'],['audit_events','id'],['meta','key'],['backups','id'],['email_validations','email']])r.result.createObjectStore(name,{keyPath:key});r.transaction.objectStore('email_validations').put({email:'shared@example.invalid',display_value:'shared@example.invalid',status:'valid',updated_at:'2026-09-15T10:00:00Z',reviewed_at:'2026-09-15T10:00:00Z',reviewed_by:'existing-reviewer',note:'Preserve my existing validation'});};r.onsuccess=()=>r.result.close();}});
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());if(!url.href.startsWith(origin)){return route.abort();}
 if(url.pathname.endsWith('/proof.html'))return route.fulfill({status:200,contentType:'text/html',body:'<html><body><p>Other provider shared@example.invalid</p>'+Array.from({length:180},(_,i)=>'<p>Unrelated source section '+i+'</p>').join('')+'<p>Synthetic Clinic A</p><p>Synthetic Doctor</p><p>shared@example.invalid</p><script>window.unsafeExecuted=true</script></body></html>'});
 if(url.pathname.includes('/data/')){const name=url.pathname.split('/').at(-1);return route.fulfill({status:payloads[name]?200:404,contentType:'application/json',body:JSON.stringify(payloads[name]||{})});}
 if(url.pathname.endsWith('review-sync.json'))return route.fulfill({status:404,body:'{}'});
 return route.continue();
});
const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.getByRole('button',{name:'Clinic mapping',exact:true}).click();await page.waitForSelector('.mapping-card');
assert.deepEqual(await page.getByRole('navigation',{name:'Review mode'}).locator('button').allTextContents(),['Email validity','Clinic mapping','Account data']);
assert.equal(await page.locator('input[type=file]').count(),0);
const statusTabs=page.getByRole('group',{name:'Clinic review status'});
assert.deepEqual(await statusTabs.locator('button').allTextContents(),['Unreviewed 2','Reviewed 0','Right clinic 0','Wrong clinic 0','All 2']);
await page.getByRole('group',{name:'Clinic review status'}).getByRole('button',{name:/^All /}).click();
assert.equal(await page.getByRole('button',{name:/^Export/}).count(),1);
await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedEmail=value;}}}));
await page.getByRole('button',{name:'Copy email',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedEmail),email);
assert.equal(await page.getByRole('navigation',{name:'Email navigation'}).count(),1);
assert.deepEqual(await page.locator('.mapping-card .validation-buttons button').allTextContents(),['Right clinic','Wrong clinic']);
assert.equal(await page.getByRole('button',{name:'Not sure',exact:true}).count(),0);
assert.equal(await page.locator('.mapping-review .confirm-btn').isDisabled(),true);
const card=page.locator('.mapping-card').first();
assert.equal(await page.getByText('Valid email',{exact:true}).count(),0);
assert.equal(await page.getByText('Clinic association',{exact:true}).count(),0);
assert.equal(await page.getByText('Contact details & notes',{exact:true}).count(),0);
assert.equal(await page.getByLabel('Find the right clinic',{exact:true}).count(),0);
await card.locator('h3').click();await page.keyboard.press('1');assert.equal(await card.getByRole('button',{name:'Right clinic',exact:true}).getAttribute('aria-pressed'),'true');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.mapping-status')?.classList.contains('confirmed'));
await page.reload();await page.getByRole('button',{name:'Clinic mapping',exact:true}).click();await page.getByRole('group',{name:'Clinic review status'}).getByRole('button',{name:/^All /}).click();assert.equal(await page.locator('.mapping-status.confirmed').count(),1);
// Wrong clinic opens directory search; selecting a replacement does not save until confirmation.
await page.locator('.mapping-card h3').click();await page.keyboard.press('2');
const providerSearch=page.getByLabel('Find the right clinic',{exact:true});await providerSearch.fill('no-such-clinic');await page.getByText('No clinics found. Try another name or NEAK code.',{exact:true}).waitFor();
await providerSearch.fill('Synthetic Clinic B');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.mapping-review h2').innerText(),email);
await page.locator('.mapping-provider-results button').click();assert.equal(await page.locator('.mapping-status.confirmed').count(),1);
await page.getByRole('button',{name:'Confirm & assign',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mapping-status')?.classList.contains('rejected'));
await page.locator('.mapping-review h2').click();await page.keyboard.press('k');assert.equal(await page.locator('.mapping-card').getAttribute('data-association'),email+'|HU|B002');
assert.equal(await page.locator('.mapping-status.confirmed').count(),1);
await page.keyboard.press('j');assert.equal(await page.locator('.mapping-card').getAttribute('data-association'),key);
assert.deepEqual(await statusTabs.locator('button').allTextContents(),['Unreviewed 1','Reviewed 1','Right clinic 1','Wrong clinic 1','All 2']);
await statusTabs.getByRole('button',{name:'Right clinic 1',exact:true}).click();assert.equal(await page.locator('.mapping-card').getAttribute('data-association'),email+'|HU|B002');
await statusTabs.getByRole('button',{name:'Wrong clinic 1',exact:true}).click();assert.equal(await page.locator('.mapping-card').getAttribute('data-association'),key);
await statusTabs.getByRole('button',{name:'Unreviewed 1',exact:true}).click();assert.equal(await page.locator('.mapping-review h2').innerText(),'unmatched@example.invalid');
await statusTabs.getByRole('button',{name:'Reviewed 1',exact:true}).click();assert.equal(await page.locator('.mapping-review h2').innerText(),email);
await statusTabs.getByRole('button',{name:'All 2',exact:true}).click();await page.getByLabel('Clinic to review',{exact:true}).selectOption(key);
let downloaded=page.waitForEvent('download');await page.getByRole('button',{name:/Export confirmed mappings/}).click();let dl=await downloaded;const fs=require('node:fs');const csv=fs.readFileSync(await dl.path(),'utf8');assert.ok(!csv.includes('A001')&&csv.includes('B002')&&csv.includes('neak_provider_code'));
const dbData=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('lead-gen-clinic-review');r.onsuccess=()=>resolve(r.result);});const read=name=>new Promise(resolve=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);});const result={events:await read('association_decisions'),validations:await read('email_validations'),version:db.version};db.close();return result;});
assert.equal(dbData.version,5);assert.equal(dbData.validations.find(v=>v.email===email).note,'Preserve my existing validation');assert.equal(dbData.validations.find(v=>v.email==='shared@example.invalid').status,'valid');assert.equal(dbData.events.length,3);assert.ok(dbData.events.filter(e=>e.provider_code==='A001').every(e=>e.contact_role==='shared_contact'&&e.contact_purpose==='shared'&&e.owner_name==='Synthetic Reception'&&e.note==='Retained note'));
for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.mapping-workspace').evaluate(e=>e.scrollWidth<=innerWidth));}
// Export still includes mapping audit events and leaves the global Valid state intact.
await page.getByRole('button',{name:'Email validity',exact:true}).click();await page.getByRole('button',{name:/^Valid /}).click();await page.getByRole('navigation',{name:'Email navigation'}).waitFor();assert.equal(await page.getByRole('navigation',{name:'Email navigation'}).count(),1);
assert.equal(await page.locator('.review-identity').count(),1);
assert.deepEqual(await page.getByRole('navigation',{name:'Review mode'}).locator('button').allTextContents(),['Email validity','Clinic mapping','Account data']);
await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedEmail=value;}}}));
await page.getByRole('button',{name:'Copy email',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedEmail),email);
for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(e=>e.scrollWidth<=innerWidth));}
if(process.env.MAPPING_SCREENSHOT_PATH)await page.screenshot({path:'/tmp/email-review-aligned.png',fullPage:true});
downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export .json',exact:true}).click();dl=await downloaded;const exported=JSON.parse(fs.readFileSync(await dl.path(),'utf8'));assert.equal(exported.association_decisions.length,3);assert.equal(exported.email_validations[0].status,'valid');
// Reload retains the exported local review decisions.
await page.reload();
await page.getByRole('button',{name:'Clinic mapping',exact:true}).click();await page.getByRole('group',{name:'Clinic review status'}).getByRole('button',{name:/^All /}).click();await page.getByLabel('Clinic to review',{exact:true}).selectOption(key);await page.waitForFunction(()=>document.querySelectorAll('.mapping-status.rejected').length===1).catch(async e=>{console.log(await page.locator('body').innerText());throw e;});
assert.equal(await page.locator('.mapping-card').count(),1);
assert.equal(await page.locator('.mapping-email-list').count(),0);
assert.equal(await page.locator('.mapping-contact-details').count(),0);
await page.locator('.mapping-review .evidence-pane').getByText('Synthetic contact evidence',{exact:true}).waitFor();
await page.setViewportSize({width:1440,height:1000});
const layout=await page.locator('.mapping-review').evaluate(el=>{const a=el.querySelector('.decision-pane').getBoundingClientRect(),b=el.querySelector('.evidence-pane').getBoundingClientRect();return {sideBySide:b.left>=a.right,aligned:Math.abs(a.top-b.top)<1};});assert.deepEqual(layout,{sideBySide:true,aligned:true});
if(process.env.MAPPING_SCREENSHOT_PATH)await page.screenshot({path:process.env.MAPPING_SCREENSHOT_PATH,fullPage:true});
await page.locator('.mapping-review h2').click();await page.keyboard.press('ArrowRight');
assert.equal(await page.locator('.mapping-card').count(),0);
assert.equal(await page.getByLabel('Find the right clinic',{exact:true}).isVisible(),true);
assert.ok((await page.locator('.mapping-review .evidence-pane').innerText()).includes('No saved evidence'));
await page.getByLabel('Find the right clinic',{exact:true}).fill('B002');await page.locator('.mapping-provider-results button').click();await page.getByRole('button',{name:'Confirm & assign',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mapping-status')?.classList.contains('confirmed'));
await page.locator('.mapping-review h2').click();await page.keyboard.press('ArrowLeft');
await page.getByLabel('Clinic to review',{exact:true}).selectOption(key);
await page.locator('.mapping-review .evidence-pane').getByText('Synthetic contact evidence',{exact:true}).waitFor();
// A synchronous failure on the second write must roll back the entire reassignment.
await page.getByLabel('Find the right clinic',{exact:true}).fill('B002');await page.locator('.mapping-provider-results button').click();
await page.evaluate(()=>{const original=window.IDBObjectStore.prototype.add;let calls=0;window.IDBObjectStore.prototype.add=function(...args){if(this.name==='association_decisions'&&++calls===2)throw Error('Synthetic storage failure');return original.apply(this,args);};});
await page.getByRole('button',{name:'Confirm & assign',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic storage failure'}).waitFor();assert.equal(await page.locator('.mapping-status.rejected').count(),1);
const count=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('lead-gen-clinic-review');r.onsuccess=()=>resolve(r.result);});return new Promise(resolve=>{const r=db.transaction('association_decisions').objectStore('association_decisions').count();r.onsuccess=()=>{db.close();resolve(r.result);};});});assert.equal(count,4);
// A remaining pending link keeps an otherwise-reviewed email in Unreviewed.
pkg.providers.push({code:'C003',name:'Synthetic Clinic C',services:[]});
pkg.associations.push({id:email+'|HU|C003',email,provider_code:'C003',country:'HU',status:'unreviewed',evidence:[]});
pkg.associations[0].evidence[0].observed_at='2026-07-29';
pkg.associations[0].evidence.push({source_url:'https://example.invalid/another/source-page',quote:'Second source evidence'});
payloads['synthetic.json'].documents=[{source_url:'https://example.invalid/',raw_html_path:'sources/raw_html/proof.html'}];
await page.reload();await page.getByRole('button',{name:'Clinic mapping',exact:true}).click();
await statusTabs.waitFor();
assert.deepEqual(await statusTabs.locator('button').allTextContents(),['Unreviewed 1','Reviewed 1','Right clinic 2','Wrong clinic 1','All 2']);
await page.getByLabel('Clinic to review',{exact:true}).selectOption(key);
const proof=page.frameLocator('.archive-frame');await proof.locator('[data-review-email-highlight]').waitFor();
assert.equal(await proof.locator('[data-review-email-highlight]').innerText(),email);
assert.ok(await page.locator('.archive-frame').evaluate(frame=>frame.contentWindow.scrollY>500));
assert.equal(await page.locator('.archive-frame').evaluate(frame=>!!frame.contentWindow.unsafeExecuted),false);
assert.equal(await page.getByLabel('Evidence source',{exact:true}).getAttribute('title'),'https://example.invalid/');
assert.equal(await page.getByLabel('Evidence source',{exact:true}).locator('option').nth(1).innerText(),'2 · example.invalid / source-page');
const evidenceLayout=await page.locator('.evidence-pane').evaluate(pane=>{const header=pane.querySelector('.evidence-toolbar').getBoundingClientRect(),picker=pane.querySelector('.mapping-source-picker').getBoundingClientRect(),archive=pane.querySelector('.archive-pane').getBoundingClientRect();return {gap:archive.top-picker.bottom,pickerHeight:picker.height,headerHeight:header.height};});assert.ok(evidenceLayout.gap<20&&evidenceLayout.pickerHeight<60&&evidenceLayout.headerHeight<70);
const centered=await page.locator('.archive-frame').evaluate(frame=>{const r=frame.contentDocument.querySelector('[data-review-email-highlight]').getBoundingClientRect();return Math.abs(r.top+r.height/2-frame.clientHeight/2)<40;});assert.equal(centered,true);
const box=await proof.locator('[data-review-email-highlight]').boundingBox();assert.ok(box&&box.height>0);
if(process.env.MAPPING_SCREENSHOT_PATH)await page.screenshot({path:process.env.MAPPING_SCREENSHOT_PATH,fullPage:true});
await page.getByRole('button',{name:'Account data',exact:true}).click();
await page.getByRole('heading',{name:'Account data',exact:true}).waitFor();
await page.getByLabel('Show',{exact:true}).selectOption('all').catch(async error=>{console.log(await page.locator('.account-evidence-workspace').innerText());throw error;});
await page.getByRole('button',{name:'Confirm value',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.account-evidence-workspace .mapping-card')?.textContent.includes('confirmed'));
let fieldDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();
const fieldExport=JSON.parse(fs.readFileSync(await (await fieldDownload).path(),'utf8'));
assert.equal(fieldExport.field_decisions.length,1);assert.equal(fieldExport.field_decisions[0].status,'confirmed');assert.ok(fieldExport.association_decisions.length>=4);
await page.reload();await page.getByRole('button',{name:'Account data',exact:true}).click();await page.getByLabel('Show',{exact:true}).selectOption('all').catch(async error=>{console.log(await page.locator('.account-evidence-workspace').innerText());throw error;});
await page.waitForFunction(()=>document.querySelector('.account-evidence-workspace .mapping-card')?.textContent.includes('confirmed'));
await page.getByRole('button',{name:'Reject',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.account-evidence-workspace .mapping-card')?.textContent.includes('rejected'));
const next=structuredClone(fullAccountEvidence);next.accounts[0].claims.push({...next.accounts[0].claims[0],claim_id:'d'.repeat(64),field:'telephone',value:'+3612345678'});indexAccountEvidence(next,'e'.repeat(64));
await page.getByRole('heading',{name:/Telephone: \+3612345678/}).waitFor({timeout:45000});
assert.ok((await page.locator('.account-evidence-workspace .mapping-card').first().innerText()).includes('rejected'));
for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(e=>e.scrollWidth<=innerWidth));}
await page.screenshot({path:'/tmp/hu-account-review-synthetic.png',fullPage:true});
// Reconciled account preferences remain separate from field ownership.
const contactNext=structuredClone(next),a=contactNext.accounts[0],phoneId='8'.repeat(64),sourceId='9'.repeat(64);
a.claims.push({...a.claims[0],claim_id:'f'.repeat(64),field:'website',value:'https://directory.example.invalid/clinic'});
const group=(id,field,value,claim,role)=>({id,field,value,role,strength:'strong',score:10,claim_ids:[claim],proofs:[],reasons:['Synthetic identity match'],cautions:[],variants:[value],service_ids:['000000001'],independent_source_families:1,proof_count:0});
a.contact_reconciliation={version:1,lanes:['recommended_contacts'],review_sample:true,recommended:{telephone:phoneId},recommendation_reasons:{email:'Insufficient evidence',website:'No attributable homepage'},groups:[group(phoneId,'telephone','+3612345678','d'.repeat(64),'practice'),group(sourceId,'website','https://directory.example.invalid/clinic','f'.repeat(64),'source_page')]};
indexAccountEvidence(contactNext,'f'.repeat(64));
await page.getByRole('heading',{name:'Preferred telephone',exact:true}).waitFor({timeout:45000});
assert.match(await page.locator('.contact-review-card').first().innerText(),/unreviewed/);
await page.getByRole('button',{name:'Use as preferred',exact:true}).click();
await page.getByRole('button',{name:'Preferred',exact:true}).waitFor();
assert.match(await page.locator('.contact-review-card').first().innerText(),/unreviewed/);
fieldDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export review JSON',exact:true}).click();
const contactExport=JSON.parse(fs.readFileSync(await (await fieldDownload).path(),'utf8'));
assert.equal(contactExport.contact_preferences.length,1);assert.equal(contactExport.contact_preferences[0].candidate_id,phoneId);
assert.equal(contactExport.field_decisions.some(e=>e.claim_id==='d'.repeat(64)),false);
await page.reload();await page.getByRole('button',{name:'Account data',exact:true}).click();await page.getByLabel('Show',{exact:true}).selectOption('all');
await page.getByRole('button',{name:'Preferred',exact:true}).waitFor();
await page.getByLabel('Account review section',{exact:true}).selectOption('sources');
await page.getByRole('button',{name:'Confirm source relevance',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.contact-review-card')?.textContent.includes('confirmed'));
assert.equal(await page.getByRole('button',{name:'Use as preferred',exact:true}).isDisabled(),true);
await page.getByLabel('Account review section',{exact:true}).selectOption('contacts');
await page.getByRole('button',{name:'Leave preferred telephone unset',exact:true}).click();
await page.getByText('Reviewer left the preferred contact unset.',{exact:true}).waitFor();
for(const width of [375,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.locator('.app-shell').evaluate(e=>e.scrollWidth<=innerWidth));}
await page.screenshot({path:'/tmp/hu-contact-review-reconciled-synthetic.png',fullPage:true});

// Publishing the campaign file must retain validity and the Used status after reload.
payloads['campaign-email-usage.json'].items=[{email,campaign_count:1,campaign_files:['synthetic-campaign.csv']}];
await page.reload();await page.getByRole('button',{name:'Email validity',exact:true}).click();
await page.getByRole('button',{name:/^Valid /}).click();await page.getByRole('button',{name:/^Used 1$/}).click();
await page.getByText('Used in campaign',{exact:true}).waitFor();
await page.reload();await page.getByText('Used in campaign',{exact:true}).waitFor();
assert.equal(await page.getByRole('heading',{name:email,exact:true}).count(),1);
const validation=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('lead-gen-clinic-review');r.onsuccess=()=>resolve(r.result);});return new Promise(resolve=>{const r=db.transaction('email_validations').objectStore('email_validations').get('shared@example.invalid');r.onsuccess=()=>{db.close();resolve(r.result);};});});
assert.equal(validation.status,'valid');assert.equal(validation.note,'Preserve my existing validation');
assert.deepEqual(errors,[]);
await context.close();console.log('Synthetic browser checks passed: IndexedDB migration, save/reload, atomic reassignment and rollback, rejection independent of validity, CSV/JSON exports, account-field confirmation/rejection and persistence, responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});

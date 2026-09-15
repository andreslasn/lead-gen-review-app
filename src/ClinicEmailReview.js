import { computed, nextTick, ref, watch } from 'vue';
import { associationKey, resolvedAssociations, safeSourceUrl, mappedEmailRows, associationRank, associationEvidence } from './associations.js';
import { focusArchivedEvidence, findEvidenceMatch } from './evidence.js';
import ReviewHeader from './ReviewHeader.js';
export default {
  components:{ReviewHeader},
  props: { pkg:Object, emails:Array, decisions:Array, reviewer:String, saving:Boolean, saveError:String },
  emits:['decision','export','copy'],
  setup(props,{emit}) {
    const search=ref(''), selectedEmail=ref(''), filter=ref('unreviewed'), providerSearch=ref(''), target=ref(null), selectedEvidence=ref(null), activeId=ref(''), evidenceIndex=ref(0), choice=ref(''), archiveFrame=ref(null), evidencePane=ref(null), evidenceLocated=ref(null);
    let evidenceRequest=0;
    const providers=computed(()=>new Map((props.pkg?.providers || []).map(p=>[p.code,p])));
    const states=computed(()=>resolvedAssociations(props.pkg,props.decisions));
    const byEmail=computed(()=>{const map=new Map();for(const a of states.value){if(!map.has(a.email))map.set(a.email,[]);map.get(a.email).push(a);}return map;});
    const validEmails=computed(()=>props.emails.filter(e=>e.status==='valid'));
    const lanes=[{id:'unreviewed',label:'Unreviewed',title:'Emails with missing, pending or conflicting clinic links'},{id:'reviewed',label:'Reviewed',title:'Emails with all clinic links reviewed'},{id:'confirmed',label:'Right clinic',title:'Emails with at least one confirmed clinic link'},{id:'rejected',label:'Wrong clinic',title:'Emails with at least one rejected clinic link'},{id:'all',label:'All',title:'All valid emails'}];
    const emailLanes=computed(()=>new Map(validEmails.value.map(e=>{
      const matches=byEmail.value.get(e.email)||[];
      const pending=!matches.length||matches.some(a=>['unreviewed','conflict'].includes(a.status));
      return [e.email,new Set(['all',pending?'unreviewed':'reviewed',...matches.map(a=>a.status).filter(s=>['confirmed','rejected'].includes(s))])];
    })));
    const laneCounts=computed(()=>Object.fromEntries(lanes.map(l=>[l.id,validEmails.value.filter(e=>emailLanes.value.get(e.email).has(l.id)).length])));
    const rows=computed(()=>validEmails.value.filter(e=>{
      const matches=byEmail.value.get(e.email)||[];
      const needle=search.value.trim().toLowerCase();
      return emailLanes.value.get(e.email).has(filter.value) && (!needle || [e.email,e.name,...matches.flatMap(a=>[a.provider_code,providers.value.get(a.provider_code)?.name,...(providers.value.get(a.provider_code)?.services||[]).map(s=>s.doctor)])].some(v=>String(v||'').toLowerCase().includes(needle)));
    }));
    const current=computed(()=>rows.value.find(e=>e.email===selectedEmail.value)||rows.value[0]);
    const candidates=computed(()=>{
      if(!current.value)return [];
      const stored=byEmail.value.get(current.value.email)||[];
      return [...stored].sort((a,b)=>associationRank(b)-associationRank(a)||a.provider_code.localeCompare(b.provider_code));
    });
    const active=computed(()=>candidates.value.find(a=>a.id===activeId.value)||candidates.value.find(a=>filter.value==='unreviewed'?['unreviewed','conflict'].includes(a.status):a.status===filter.value)||candidates.value[0]);
    const provider=computed(()=>providers.value.get(active.value?.provider_code));
    const currentIndex=computed(()=>rows.value.findIndex(e=>e.email===current.value?.email));
    const orderedEvidence=computed(()=>associationEvidence(active.value));
    const evidence=computed(()=>orderedEvidence.value[evidenceIndex.value]||orderedEvidence.value[0]);
    const stateLabels={unreviewed:'Needs review',confirmed:'Confirmed',rejected:'Wrong clinic',conflict:'Conflicting reviews'};
    function moveEmail(offset){if(props.saving)return;const row=rows.value[currentIndex.value+offset];if(row)select(row.email);}
    function choose(status){if(active.value&&!props.saving){choice.value=status;target.value=null;providerSearch.value='';}}
    function confirm(){
      if(props.saving)return;
      const events=[];
      if(active.value&&['confirmed','rejected'].includes(choice.value))events.push(decision(active.value,choice.value));
      if(target.value&&(!active.value||choice.value==='rejected')){
        const id=associationKey(current.value.email,target.value.code);
        const existing=candidates.value.find(a=>a.id===id);
        events.push(decision(existing||{id,email:current.value.email,provider_code:target.value.code},'confirmed'));
      }
      if(events.length){if(active.value)activeId.value=active.value.id;emit('decision',events);}
    }
    function moveClinic(offset){const index=candidates.value.findIndex(a=>a.id===active.value?.id);const next=candidates.value[index+offset];if(next&&!props.saving)activeId.value=next.id;}
    const suggestions=computed(()=>{
      const needle=providerSearch.value.trim().toLowerCase();if(needle.length<2)return [];
      return (props.pkg?.providers||[]).filter(p=>p.code!==active.value?.provider_code).filter(p=>[p.code,p.name,...p.services.flatMap(s=>[s.doctor,s.city,s.address,s.hsz])].some(v=>String(v||'').toLowerCase().includes(needle))).slice(0,20);
    });
    const exportCount=computed(()=>mappedEmailRows(props.emails,props.pkg,props.decisions).length);
    function decision(a,status){
      return {id:crypto.randomUUID(),association_id:a.id,email:a.email,provider_code:a.provider_code,country:'HU',status,
        contact_role:a.contact_role||'unknown',...(a.contact_purpose?{contact_purpose:a.contact_purpose}:{}),owner_name:a.owner_name||'',note:a.note||'',evidence_urls:[...new Set([...(a.evidence||[]).map(e=>e.source_url),...(a.evidence_urls||[])].filter(safeSourceUrl))],
        reviewed_at:new Date().toISOString(),reviewed_by:props.reviewer||'reviewer',supersedes:a.heads||[],source:'manual-clinic-mapping'};
    }
    function selectTarget(p){if(!props.saving)target.value=p;}
    function sourceLabel(e,index){
      const url=safeSourceUrl(e.source_url);
      if(!url)return `${index+1} · ${e.basis||'Saved source'}`;
      const parsed=new URL(url), path=parsed.pathname.split('/').filter(Boolean).at(-1);
      return `${index+1} · ${parsed.hostname}${path?' / '+path:''}`;
    }
    function proofOptions(){return {quote:evidence.value?.quote,context:[provider.value?.name,...(provider.value?.services||[]).flatMap(s=>[s.doctor,s.address])]};}
    function focusProof(event){
      const frame=event?.target||archiveFrame.value;
      if(!frame||frame!==archiveFrame.value)return;
      try{evidenceLocated.value=focusArchivedEvidence(frame,current.value?.email,proofOptions());}
      catch{evidenceLocated.value=false;}
    }
    const excerptParts=computed(()=>{
      const text=selectedEvidence.value?.quote||'';
      const match=findEvidenceMatch(text,current.value?.email,proofOptions());
      return match?{before:text.slice(0,match.start),match:text.slice(match.start,match.end),after:text.slice(match.end)}:{before:text,match:'',after:''};
    });
    async function loadEvidence(e) {
      const request=++evidenceRequest;
      evidenceLocated.value=null;
      selectedEvidence.value={loading:!!e?.clinic_id,quote:e?.quote||'No saved evidence for this clinic link.'};
      if(!e?.clinic_id)return;
      try {
        const response=await fetch('data/clinics/'+encodeURIComponent(e.clinic_id)+'.json');
        if(!response.ok)throw Error('Saved page unavailable. Review the excerpt or open the source.');
        const payload=await response.json();
        const doc=(payload.documents||[]).find(d=>d.source_url===e.source_url||d.final_url===e.source_url);
        const path=doc?.raw_html_path||'';
        const safePath=path.startsWith('sources/raw_html/')&&!path.includes('..')&&!path.includes(':')&&path.endsWith('.html');
        const textPath=doc?.review_text_path||'';
        if(!safePath&&/^sources\/review_text\/[a-zA-Z0-9_-]+\.txt$/.test(textPath)){
          const textResponse=await fetch('data/'+textPath);
          if(!textResponse.ok)throw Error('Saved text unavailable. Review the excerpt or open the source.');
          const text=await textResponse.text();
          if(request!==evidenceRequest)return;
          selectedEvidence.value={textPath:'data/'+textPath,quote:text};
          return;
        }
        if(request!==evidenceRequest)return;
        selectedEvidence.value={path:safePath?'data/'+path:'',quote:e.quote||'No matching HTML page retained for this source.'};
      } catch(err){if(request===evidenceRequest)selectedEvidence.value={quote:e.quote||'',error:err.message};}
    }
    function select(email){selectedEmail.value=email;selectedEvidence.value=null;}
    watch(()=>current.value?.email,()=>{providerSearch.value='';activeId.value='';});
    watch(()=>active.value?.id,()=>{target.value=null;providerSearch.value='';evidenceIndex.value=0;choice.value=active.value?.status==='unreviewed'?'':active.value?.status==='conflict'?'':active.value?.status||'';},{immediate:true});
    watch(filter,()=>{activeId.value='';});
    watch(providerSearch,()=>{target.value=null;});
    watch(()=>props.saving,(saving,wasSaving)=>{if(wasSaving&&!saving&&!props.saveError){target.value=null;providerSearch.value='';}});
    watch(evidence,loadEvidence,{immediate:true});
    watch([selectedEvidence,()=>active.value?.id],async()=>{
      await nextTick();
      if(archiveFrame.value)focusProof();
      else {const mark=evidencePane.value?.querySelector('mark');if(mark)mark.scrollIntoView({block:'center',inline:'nearest'});}
    });
    return {sourceLabel,archiveFrame,evidencePane,evidenceLocated,focusProof,excerptParts,search,filter,lanes,laneCounts,rows,current,candidates,providers,active,activeId,provider,currentIndex,moveEmail,evidence,orderedEvidence,evidenceIndex,choice,choose,confirm,moveClinic,stateLabels,suggestions,providerSearch,target,selectTarget,select,loadEvidence,selectedEvidence,safeSourceUrl,exportCount};
  },
  template:`<section class="mapping-workspace">
    <p v-if="!pkg" class="empty-state" role="status">Clinic mapping data is unavailable. You can still review email validity.</p>
    <template v-else>
      <div class="queue-bar mapping-controls">
        <input v-model="search" class="search" aria-label="Find email or clinic" type="search" placeholder="Search email, clinic or NEAK code…" />
        <button class="export-unused-btn" @click="$emit('export')">Export confirmed mappings <strong>{{exportCount}}</strong></button>
        <div class="lane-tabs" role="group" aria-label="Clinic review status"><button v-for="lane in lanes" :key="lane.id" :class="{active:filter===lane.id}" :aria-pressed="filter===lane.id" :title="lane.title" :disabled="saving" @click="filter=lane.id">{{lane.label}} <strong>{{laneCounts[lane.id]}}</strong></button></div>
      </div>
      <main v-if="current" class="review-layout mapping-review">
        <section :key="current.email" class="decision-pane">
          <ReviewHeader :email="current.display_value||current.email" :index="currentIndex" :total="rows.length" :disabled="saving" @move="moveEmail" @copy="$emit('copy',$event)" />
          <article v-if="active" :key="active.id" class="candidate-card mapping-card" :data-association="active.id">
            <div class="review-identity">
            <select v-if="candidates.length>1" :value="active.id" :disabled="saving" @change="activeId=$event.target.value" class="region-filter mapping-clinic-picker" aria-label="Clinic to review"><option v-for="a in candidates" :key="a.id" :value="a.id">{{providers.get(a.provider_code)?.name}}</option></select>
            <h3 v-else>{{provider?.name||'Unknown provider'}}</h3>
            <p class="clinic-address">NEAK {{active.provider_code}} · {{provider?.services[0]?.city}}<span v-if="provider?.services[0]?.address">, {{provider.services[0].address}}</span></p>
            <p v-if="provider?.services[0]?.doctor" class="mapping-doctor">{{provider.services[0].doctor}}</p>
            <details v-if="provider?.services.length>1" class="mapping-details"><summary>All doctors & locations</summary><p v-for="s in provider.services" :key="s.hsz">{{s.doctor}} · {{s.city}}, {{s.address}}</p></details>
            </div>
            <p v-if="active.identity_match" class="review-note doctor-account-match"><b>{{active.identity_match.tier==='ambiguous'?'Same-name alternatives *':active.status==='confirmed'?'Doctor evidence':'Doctor-to-account suggestion *'}}</b><br>{{active.identity_match.doctor_names.join(', ')}}<br>{{active.identity_match.tier==='reviewed_record'?'Validated doctor/email record matches the NEAK service':active.identity_match.tier==='corroborated'?'Name and location match in saved source':active.identity_match.tier==='email_name'?'Full name matches the email address':active.identity_match.tier==='profile_name'?'Name matches the saved clinic profile':active.identity_match.tier==='historical'?'Historical context; current association needs review':'Recorded doctor name matches; check the source and location'}}</p>
            <span v-if="active.status!=='unreviewed'" class="mapping-status" :class="active.status">{{stateLabels[active.status]}}</span>
            <p v-if="active.status==='conflict'" class="review-note">Reviews disagree. Choose a decision to resolve this clinic link.</p>
            <div class="validation-buttons"><button class="validation-btn valid-btn" :disabled="saving" :class="{active:choice==='confirmed'}" :aria-pressed="choice==='confirmed'" @click="choose('confirmed')" title="Right clinic (1)">Right clinic</button><button class="validation-btn invalid-btn" :disabled="saving" :class="{active:choice==='rejected'}" :aria-pressed="choice==='rejected'" @click="choose('rejected')" title="Wrong clinic (2)">Wrong clinic</button></div>
          </article>
          <div v-if="choice==='rejected'||!active" class="mapping-provider-search">
            <label>Find the right clinic<input v-model="providerSearch" :disabled="saving" type="search" placeholder="Clinic name, doctor, NEAK code or town…" /></label>
            <ul v-if="!target" class="mapping-provider-results"><li v-for="p in suggestions" :key="p.code"><button :disabled="saving" @click="selectTarget(p)">{{p.name}} · {{p.code}} · {{p.services[0]?.city}}</button></li></ul>
            <p v-if="providerSearch.trim().length>=2&&!suggestions.length" class="muted">No clinics found. Try another name or NEAK code.</p>
            <p v-if="target" class="mapping-selected-target">Assign to <strong>{{target.name}}</strong> · NEAK {{target.code}} <button :disabled="saving" @click="target=null" aria-label="Clear selected clinic">×</button></p>
          </div>
          <button class="confirm-btn" :disabled="saving||(!active&&!target)||(active&&!choice)" @click="confirm()" title="Confirm (Enter)">{{saving?'Saving…':target?'Confirm & assign':'Confirm'}}</button>
          <p v-if="saveError" class="review-note" role="alert">{{saveError}}</p>
          <div class="decision-footer-actions"><span class="muted">← → Emails · J/K Clinics · 1/2 Choose · Enter Confirm</span></div>
        </section>
        <section ref="evidencePane" class="evidence-pane" aria-label="Clinic association evidence">
          <div class="evidence-toolbar"><div class="evidence-provenance"><strong>{{selectedEvidence?.path?'Saved page':selectedEvidence?.textPath?'Saved text':'Source evidence'}}</strong><span v-if="evidence?.observed_at">{{evidence.observed_at.slice(0,10)}}</span></div><a v-if="safeSourceUrl(evidence?.source_url)" :href="safeSourceUrl(evidence.source_url)" target="_blank" rel="noopener noreferrer">Open live page ↗</a></div>
          <select v-if="orderedEvidence.length>1" v-model="evidenceIndex" class="region-filter mapping-source-picker" :title="evidence?.source_url" aria-label="Evidence source"><option v-for="(e,i) in orderedEvidence" :key="i" :value="i" :title="e.source_url">{{sourceLabel(e,i)}}</option></select>
          <p v-if="selectedEvidence?.path&&evidenceLocated===false" class="review-note">No matching passage found in this saved page.</p>
          <div v-if="selectedEvidence?.path" class="archive-pane"><iframe ref="archiveFrame" @load="focusProof" :key="selectedEvidence.path + active.id" class="archive-frame" :src="selectedEvidence.path" title="Saved clinic source HTML" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe></div>
          <div v-else class="snapshot-pane text-fallback-pane"><p v-if="selectedEvidence?.loading" class="muted" role="status">Loading saved page…</p><p v-if="selectedEvidence?.error" class="review-note">{{selectedEvidence.error}}</p><p v-if="evidence?.basis" class="muted">{{evidence.basis}}</p><blockquote class="snapshot-text">{{excerptParts.before}}<mark v-if="excerptParts.match">{{excerptParts.match}}</mark>{{excerptParts.after}}</blockquote></div>
        </section>
      </main>
      <main v-else class="empty-state"><h2>No emails in this view.</h2><p>Change the filter or search query.</p></main>
    </template>
  </section>`
};

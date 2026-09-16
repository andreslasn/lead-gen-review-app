import {computed,ref,watch} from 'vue';
import {fieldState,webpageRoles,webpageActions} from './accountEvidence.js';
import {safeSourceUrl} from './associations.js';
import ReviewHeader from './ReviewHeader.js';

export default {
  components:{ReviewHeader},
  props:{market:{type:String,default:'LV'},pkg:Object,decisions:Array,reviewer:String,saving:Boolean,error:String},
  emits:['decision','load-account','retry','export','import'],
  setup(props,{emit}) {
    const availableRoles=computed(()=>Object.fromEntries(Object.entries(webpageRoles).filter(([role])=>['LV','RO'].includes(props.market)||role!=='not_icp')));
    const search=ref(new URLSearchParams(location.hash.slice(1)).get('account')||''),kind=ref(new URLSearchParams(location.hash.slice(1)).has('account')?'all':'practice_website'),status=ref('unreviewed'),selected=ref(''),copied=ref(''),reviewRole=ref('practice_website'),choice=ref(''),capabilityActions=ref([]),capabilityProvider=ref('');
    const state=claim=>fieldState(claim,props.decisions);
    const role=claim=>{const value=state(claim);return value.status==='confirmed'&&value.contact_role||claim.website_role;};
    const all=computed(()=>(props.pkg?.accounts||[]).flatMap(account=>account.claims.filter(c=>c.field==='website').map(claim=>({account,claim,id:claim.claim_id}))));
    const counts=computed(()=>Object.fromEntries(Object.keys(webpageRoles).map(type=>[type,all.value.filter(row=>role(row.claim)===type).length])));
    const missing=computed(()=>(props.pkg?.accounts||[]).filter(a=>!a.claims.some(c=>role(c)==='practice_website'&&state(c).status!=='rejected')));
    const matches=account=>[account.account_key,account.provider_code,account.name,account.doctor,account.address,account.county,...account.claims.map(c=>c.value)].join(' ').toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
    const scoped=computed(()=>all.value.filter(row=>(kind.value==='all'||role(row.claim)===kind.value)&&matches(row.account)));
    const statuses=computed(()=>Object.fromEntries(['unreviewed','confirmed','rejected','all'].map(s=>[s,scoped.value.filter(r=>s==='all'||(s==='unreviewed'?['unreviewed','conflict'].includes(state(r.claim).status):state(r.claim).status===s)).length])));
    const rows=computed(()=>kind.value==='missing'?missing.value.filter(matches).map(account=>({account,id:account.account_key})):scoped.value.filter(r=>status.value==='all'||(status.value==='unreviewed'?['unreviewed','conflict'].includes(state(r.claim).status):state(r.claim).status===status.value)));
    watch(()=>props.pkg,pkg=>{const account=pkg?.accounts.find(a=>a.account_key===search.value);if(account&&!account.claims.length)kind.value='missing';});
    const index=computed(()=>Math.max(0,rows.value.findIndex(r=>r.id===selected.value)));
    const current=computed(()=>rows.value[index.value]);
    watch(()=>JSON.stringify([current.value?.id,current.value?.claim&&state(current.value.claim).status,current.value?.claim&&state(current.value.claim).contact_role,current.value?.claim&&state(current.value.claim).webpage_capabilities]),()=>{
      const claim=current.value?.claim;
      reviewRole.value=claim?role(claim):'practice_website';
      choice.value=claim&&['confirmed','rejected'].includes(state(claim).status)?state(claim).status:'';
      const capabilities=claim&&state(claim).webpage_capabilities;
      capabilityActions.value=[...(capabilities?.actions||[])];
      capabilityProvider.value=capabilities?.provider||'';
      copied.value='';
    },{immediate:true});
    const ready=computed(()=>props.pkg?.evidence_storage!=='account-files-v1'||current.value?.account.evidence_loaded);
    watch(()=>[current.value?.account.account_key,props.pkg?.research_snapshot_id],()=>{copied.value='';if(current.value&&!ready.value)emit('load-account',current.value.account.account_key);},{immediate:true});
    function move(offset){if(!props.saving)selected.value=rows.value[index.value+offset]?.id||selected.value;}
    function choose(status){if(current.value?.claim&&ready.value&&!props.saving&&['confirmed','rejected','unreviewed'].includes(status)){if(status==='confirmed'&&reviewRole.value==='not_icp')reviewRole.value=current.value.claim.website_role;choice.value=status;}}
    function chooseNotIcp(){if(['LV','RO'].includes(props.market)&&current.value?.claim&&ready.value&&!props.saving){choice.value='confirmed';reviewRole.value='not_icp';}}
    const hasPatientAction=computed(()=>capabilityActions.value.some(a=>!['none_observed','unclear'].includes(a)));
    function toggleCapability(action,checked){
      if(props.saving||!ready.value)return;
      const exclusive=['none_observed','unclear'].includes(action);
      capabilityActions.value=checked?(exclusive?[action]:[...capabilityActions.value.filter(a=>!['none_observed','unclear',action].includes(a)),action]):capabilityActions.value.filter(a=>a!==action);
      if(!hasPatientAction.value)capabilityProvider.value='';
    }
    function confirm(){const c=current.value?.claim;if(!c||!choice.value||!ready.value||props.saving)return;emit('decision',{id:crypto.randomUUID(),claim_id:c.claim_id,account_key:c.account_key,field:'website',status:choice.value,contact_role:reviewRole.value,webpage_capabilities:{version:1,actions:[...capabilityActions.value].sort(),provider:hasPatientAction.value?capabilityProvider.value.trim():''},reviewed_by:props.reviewer||'reviewer',reviewed_at:new Date().toISOString(),observation_ids:c.observations.map(o=>o.observation_id),supersedes:state(c).heads||[],source:'webpage-review'});}
    async function copy(){try{await navigator.clipboard.writeText(current.value.claim.value);copied.value='Copied';}catch{copied.value='Copy unavailable; select the link text to copy.';}}
    return {search,kind,status,reviewRole,role,counts,statuses,missing,rows,index,current,ready,move,choose,chooseNotIcp,confirm,choice,capabilityActions,capabilityProvider,hasPatientAction,toggleCapability,webpageActions,state,copy,copied,webpageRoles:availableRoles,safeSourceUrl};
  },
  template:`<section class="webpage-review mapping-workspace">
    <div class="webpage-summary"><h1>Webpages · {{({PL:'Poland',RO:'Romania',LV:'Latvia'})[market]}}</h1><span v-if="pkg">{{pkg.accounts.length}} accounts · {{rows.length}} {{kind==='missing'?'accounts without a practice website candidate':'webpages in this view'}}</span></div>
    <div class="queue-bar webpage-controls">
      <input v-model="search" :disabled="saving" class="search" aria-label="Find account, doctor, address or webpage" placeholder="Account, doctor, address or webpage…" type="search">
      <select v-model="kind" :disabled="saving" class="region-filter" aria-label="Page type"><option value="all">All webpages</option><option v-for="(label,key) in webpageRoles" :value="key">{{label}} ({{counts[key]||0}})</option><option value="missing">Website not yet identified ({{missing.length}})</option></select>
      <button class="export-unused-btn" :disabled="saving||!pkg" @click="$emit('export')">Export review JSON</button>
      <label class="webpage-import">Import review JSON<input type="file" accept=".json,application/json" @change="$emit('import',$event);$event.target.value=''" :disabled="saving||!pkg"></label>
      <div v-if="pkg&&kind!=='missing'" class="lane-tabs" role="group" aria-label="Webpage review status"><button v-for="s in ['unreviewed','confirmed','rejected','all']" :class="{active:status===s}" :aria-pressed="status===s" :disabled="saving" @click="status=s">{{s==='unreviewed'?'Needs review':s==='confirmed'?'Confirmed':s==='rejected'?'Rejected':'All'}} <strong>{{statuses[s]}}</strong></button></div>
    </div>
    <main v-if="!pkg" class="empty-state"><p role="status">{{({PL:'Poland',RO:'Romania',LV:'Latvia'})[market]}} evidence is unavailable. <button @click="$emit('retry')">Retry {{({PL:'Poland',RO:'Romania',LV:'Latvia'})[market]}} data</button></p></main>
    <main v-else-if="current" class="review-layout mapping-review">
      <section class="decision-pane webpage-identity">
        <ReviewHeader :email="current.claim?.value||current.account.name" :index="index" :total="rows.length" :disabled="saving" :item-label="current.claim?'webpage':'account'" :copyable="!!current.claim" @move="move" @copy="copy" />
        <span v-if="copied" class="muted" role="status">{{copied}}</span>
        <article class="candidate-card mapping-card">
          <div class="review-identity">
            <h3 v-if="current.claim">{{current.account.name}}</h3>
            <p class="clinic-address">{{current.account.address}}</p>
            <p class="mapping-doctor">{{current.account.doctor}}</p>
          </div>
          <template v-if="current.claim">
            <span class="webpage-state mapping-status" :class="state(current.claim).status">{{state(current.claim).status}}<sup v-if="['unreviewed','conflict'].includes(state(current.claim).status)">*</sup></span>
            <label class="mapping-clinic-picker">Page role<select v-model="reviewRole" class="region-filter" aria-label="Page role" :disabled="saving||!ready"><option v-for="(label,key) in webpageRoles" :value="key">{{label}}</option></select></label>
            <p class="review-note">{{reviewRole==='not_icp'?'The linked organisation is outside our target profile. This keeps the account in the market list.':['source_page','directory_profile','organisation_profile'].includes(reviewRole)?'Confirming verifies this source’s relevance to the account. It does not designate an official website.':'Confirming verifies this webpage’s association with the account.'}}</p>
            <fieldset class="webpage-capabilities" :disabled="saving||!ready">
              <legend>What can patients do on this page?</legend>
              <div class="webpage-capability-options"><label v-for="(label,action) in webpageActions" :key="action"><input type="checkbox" :checked="capabilityActions.includes(action)" @change="toggleCapability(action,$event.target.checked)">{{label}}</label></div>
              <small v-if="!capabilityActions.length" class="muted">Not reviewed</small>
              <small class="muted">Check functions for this practice. A general portal link or directory listing is not proof of booking.</small>
              <label v-if="hasPatientAction" class="mapping-clinic-picker">Booking / service provider (optional)<input v-model="capabilityProvider" maxlength="160" placeholder="Provider name, if identifiable" aria-label="Booking / service provider"></label>
            </fieldset>
            <div class="validation-buttons">
              <button class="validation-btn valid-btn" :disabled="saving||!ready" :class="{active:choice==='confirmed'&&reviewRole!=='not_icp'}" :aria-pressed="choice==='confirmed'&&reviewRole!=='not_icp'" @click="choose('confirmed')" title="Right clinic (1)">Right clinic</button>
              <button class="validation-btn invalid-btn" :disabled="saving||!ready" :class="{active:choice==='rejected'}" :aria-pressed="choice==='rejected'" @click="choose('rejected')" title="Wrong clinic (2)">Wrong clinic</button>
              <button v-if="['LV','RO'].includes(market)" class="validation-btn" :disabled="saving||!ready" :class="{active:choice==='confirmed'&&reviewRole==='not_icp'}" :aria-pressed="choice==='confirmed'&&reviewRole==='not_icp'" @click="chooseNotIcp">Not ICP</button>
            </div>
          </template>
          <p v-else class="review-note">Website not yet identified. This does not establish that the practice has no website.</p>
        </article>
        <button v-if="current.claim" class="confirm-btn" :disabled="saving||!ready||!choice" @click="confirm" title="Confirm (Enter)">{{saving?'Saving…':choice==='unreviewed'?'Confirm unresolved':'Confirm'}}</button>
        <div class="decision-footer-actions"><button v-if="current.claim" :disabled="saving||!ready" :aria-pressed="choice==='unreviewed'" @click="choose('unreviewed')">Leave unresolved</button><span class="muted">← → {{current.claim?'Webpages':'Accounts'}}<template v-if="current.claim"> · 1/2 Choose · Enter Confirm</template></span></div>
        <details class="mapping-details"><summary>Account details</summary><p>Institution code: {{current.account.provider_code||'Not recorded'}}</p><p>{{current.account.account_key}}</p><p>{{current.account.coverage}}</p></details>
      </section>
      <section class="evidence-pane webpage-evidence" aria-label="Webpage association evidence">
        <div class="evidence-toolbar"><div class="evidence-provenance evidence-excerpt"><strong>Saved evidence</strong><span v-if="ready&&current.claim">{{current.claim.observations.length}} {{current.claim.observations.length===1?'source':'sources'}}</span></div><a v-if="safeSourceUrl(current.claim?.value)" :href="safeSourceUrl(current.claim.value)" target="_blank" rel="noopener noreferrer">Open live page ↗</a></div>
        <div class="snapshot-pane text-fallback-pane" :key="current.id">
          <p v-if="!ready" class="review-note" role="status">Loading saved evidence… <button v-if="error" @click="$emit('load-account',current.account.account_key)">Retry evidence</button></p>
          <template v-else-if="current.claim"><article v-for="o in current.claim.observations" :key="o.observation_id"><p class="muted">{{o.retrieved_at||'Capture date unavailable'}}</p><blockquote class="snapshot-text">{{o.evidence||'No excerpt retained. Open the source to inspect the page.'}}</blockquote><p class="review-note"><b>Matching clues:</b> {{o.identity_basis||'Not supplied'}}</p><a v-if="safeSourceUrl(o.source_url)" :href="safeSourceUrl(o.source_url)" target="_blank" rel="noopener noreferrer">Open source ↗</a></article></template>
          <p v-else class="review-note">No practice website candidate to validate. Other public pages may be available under the other page types.</p>
        </div>
      </section>
    </main>
    <main v-else class="empty-state"><h2>No webpages match these filters.</h2><p>Change the filter or search query.</p></main>
    <p v-if="error" class="review-note" role="alert">{{error}}</p><p class="webpage-backup muted">Reviews are saved in this browser. Export review JSON to back them up and import them into the market-data dashboard.</p>
  </section>`
};

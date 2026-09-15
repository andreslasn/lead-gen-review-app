import {computed,ref,watch} from 'vue';
import {fieldState,webpageRoles} from './accountEvidence.js';
import {safeSourceUrl} from './associations.js';

export default {
  props:{pkg:Object,decisions:Array,reviewer:String,saving:Boolean,error:String},
  emits:['decision','load-account','retry','export','import'],
  setup(props,{emit}) {
    const search=ref(new URLSearchParams(location.hash.slice(1)).get('account')||''),kind=ref(new URLSearchParams(location.hash.slice(1)).has('account')?'all':'practice_website'),status=ref('unreviewed'),selected=ref(''),copied=ref(''),reviewRole=ref('practice_website');
    const state=claim=>fieldState(claim,props.decisions);
    const role=claim=>{const value=state(claim);return value.status==='confirmed'&&value.contact_role||claim.website_role;};
    const all=computed(()=>(props.pkg?.accounts||[]).flatMap(account=>account.claims.map(claim=>({account,claim,id:claim.claim_id}))));
    const counts=computed(()=>Object.fromEntries(Object.keys(webpageRoles).map(type=>[type,all.value.filter(row=>role(row.claim)===type).length])));
    const missing=computed(()=>(props.pkg?.accounts||[]).filter(a=>!a.claims.some(c=>role(c)==='practice_website'&&state(c).status!=='rejected')));
    const matches=account=>[account.account_key,account.provider_code,account.name,account.doctor,account.address,account.county,...account.claims.map(c=>c.value)].join(' ').toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
    const scoped=computed(()=>all.value.filter(row=>(kind.value==='all'||role(row.claim)===kind.value)&&matches(row.account)));
    const statuses=computed(()=>Object.fromEntries(['unreviewed','confirmed','rejected','all'].map(s=>[s,scoped.value.filter(r=>s==='all'||(s==='unreviewed'?['unreviewed','conflict'].includes(state(r.claim).status):state(r.claim).status===s)).length])));
    const rows=computed(()=>kind.value==='missing'?missing.value.filter(matches).map(account=>({account,id:account.account_key})):scoped.value.filter(r=>status.value==='all'||(status.value==='unreviewed'?['unreviewed','conflict'].includes(state(r.claim).status):state(r.claim).status===status.value)));
    watch(()=>props.pkg,pkg=>{const account=pkg?.accounts.find(a=>a.account_key===search.value);if(account&&!account.claims.length)kind.value='missing';});
    const index=computed(()=>Math.max(0,rows.value.findIndex(r=>r.id===selected.value)));
    const current=computed(()=>rows.value[index.value]);
    watch(()=>[current.value?.id,current.value?.claim&&state(current.value.claim).contact_role],()=>{if(current.value?.claim)reviewRole.value=role(current.value.claim);},{immediate:true});
    const ready=computed(()=>props.pkg?.evidence_storage!=='account-files-v1'||current.value?.account.evidence_loaded);
    watch(()=>[current.value?.account.account_key,props.pkg?.research_snapshot_id],()=>{copied.value='';if(current.value&&!ready.value)emit('load-account',current.value.account.account_key);},{immediate:true});
    function move(offset){selected.value=rows.value[index.value+offset]?.id||selected.value;}
    function save(status){const c=current.value?.claim;if(!c||!ready.value||props.saving)return;emit('decision',{id:crypto.randomUUID(),claim_id:c.claim_id,account_key:c.account_key,field:'website',status,contact_role:reviewRole.value,reviewed_by:props.reviewer||'reviewer',reviewed_at:new Date().toISOString(),observation_ids:c.observations.map(o=>o.observation_id),supersedes:state(c).heads||[],source:'webpage-review'});}
    async function copy(){try{await navigator.clipboard.writeText(current.value.claim.value);copied.value='Copied';}catch{copied.value='Copy unavailable; select the link text to copy.';}}
    return {search,kind,status,reviewRole,role,counts,statuses,missing,rows,index,current,ready,move,save,state,copy,copied,webpageRoles,safeSourceUrl};
  },
  template:`<section class="webpage-review account-evidence-workspace">
    <h1>Webpages · Latvia</h1><p>Check whether each page belongs to, or provides relevant information about, the account shown. <b>* Needs review.</b></p>
    <div class="mapping-controls"><label>Find account, doctor, address or webpage<input v-model="search" type="search"></label><label>Page type<select v-model="kind" aria-label="Page type"><option value="all">All webpages</option><option v-for="(label,key) in webpageRoles" :value="key">{{label}} ({{counts[key]||0}})</option><option value="missing">Website not yet identified ({{missing.length}})</option></select></label><button @click="$emit('export')">Export review JSON</button><label class="webpage-import">Import review JSON<input type="file" accept=".json,application/json" @change="$emit('import',$event);$event.target.value=''" :disabled="saving"></label></div>
    <p v-if="!pkg" role="status">Latvia evidence is unavailable. <button @click="$emit('retry')">Retry Latvia data</button></p>
    <template v-else><div v-if="kind!=='missing'" class="lane-tabs" role="group" aria-label="Webpage review status"><button v-for="s in ['unreviewed','confirmed','rejected','all']" :class="{active:status===s}" :aria-pressed="status===s" @click="status=s">{{s==='unreviewed'?'Needs review':s==='confirmed'?'Confirmed':s==='rejected'?'Rejected':'All'}} {{statuses[s]}}</button></div>
    <p>{{pkg.accounts.length}} accounts · {{rows.length}} {{kind==='missing'?'accounts without a practice website candidate':'webpages in this view'}}</p>
    <div v-if="current" class="webpage-navigation"><button @click="move(-1)" :disabled="index===0||saving" aria-label="Previous webpage">← Previous</button><span>{{index+1}} / {{rows.length}}</span><button @click="move(1)" :disabled="index+1>=rows.length||saving" aria-label="Next webpage">Next →</button></div>
    <div v-if="current" class="webpage-layout"><section class="mapping-card webpage-identity"><h2>{{current.account.name}}</h2><p>{{current.account.doctor}}</p><p>{{current.account.address}}</p><p>Institution code: {{current.account.provider_code||'Not recorded'}}</p><p class="webpage-account-key">{{current.account.account_key}}</p>
      <template v-if="current.claim"><h3>{{webpageRoles[role(current.claim)]}}</h3><a :href="safeSourceUrl(current.claim.value)" target="_blank" rel="noopener noreferrer">{{current.claim.value}}</a><button @click="copy" aria-label="Copy webpage URL" title="Copy webpage URL">⧉</button><span role="status">{{copied}}</span><p class="webpage-state">{{state(current.claim).status}}<sup v-if="['unreviewed','conflict'].includes(state(current.claim).status)">*</sup></p>
        <label>Page role<select v-model="reviewRole" aria-label="Page role" :disabled="saving||!ready"><option v-for="(label,key) in webpageRoles" :value="key">{{label}}</option></select></label><p>{{reviewRole==='source_page'?'Confirming verifies this source’s relevance to the account. It does not designate an official website.':'Confirming verifies this webpage’s association with the account.'}}</p>
        <div class="mapping-actions"><button :disabled="saving||!ready" @click="save('confirmed')">Confirm association</button><button :disabled="saving||!ready" @click="save('rejected')">Reject association</button><button :disabled="saving||!ready" @click="save('unreviewed')">Leave unresolved</button></div>
      </template><p v-else>Website not yet identified. This does not establish that the practice has no website.</p><p>{{current.account.coverage}}</p></section>
      <section class="mapping-card webpage-evidence"><h2>Saved evidence</h2><p v-if="!ready" role="status">Loading saved evidence… <button v-if="error" @click="$emit('load-account',current.account.account_key)">Retry evidence</button></p><template v-else-if="current.claim"><article v-for="o in current.claim.observations" :key="o.observation_id"><p>{{o.retrieved_at||'Capture date unavailable'}}</p><blockquote>{{o.evidence||'No excerpt retained. Open the source to inspect the page.'}}</blockquote><p><b>Matching clues:</b> {{o.identity_basis||'Not supplied'}}</p><a v-if="safeSourceUrl(o.source_url)" :href="safeSourceUrl(o.source_url)" target="_blank" rel="noopener noreferrer">Open source ↗</a></article></template><p v-else>No practice website candidate to validate. Other public pages may be available under the other page types.</p></section></div>
    <p v-else role="status">No webpages match these filters.</p></template><p v-if="saving" role="status">Saving…</p><p v-if="error" role="alert">{{error}}</p><p>Reviews are saved in this browser. Export review JSON to back them up and import them into the market-data dashboard.</p>
  </section>`
};

import { computed, ref, watch } from 'vue';
import { contactRoles } from './accountEvidence.js';
import { safeSourceUrl } from './associations.js';

export default {
  props:{group:Object,saving:Boolean,preferred:Boolean},
  emits:['review','prefer'],
  setup(props,{emit}){
    const role=ref(props.group.role),copyStatus=ref('');
    watch(()=>[props.group.id,props.group.role],()=>{role.value=props.group.role;copyStatus.value='';});
    const roles=computed(()=>Object.entries(contactRoles).filter(([key])=>props.group.field==='website'?['practice_website','patient_portal','social_profile','source_page','historical','unrelated','unresolved'].includes(key):props.group.field==='email'?!['practice_website','patient_portal','social_profile','source_page','fax','out_of_hours'].includes(key):!['practice_website','patient_portal','social_profile','source_page'].includes(key)));
    async function copy(value){try{await navigator.clipboard.writeText(value);copyStatus.value='Copied';}catch{copyStatus.value='Copy failed. Select the value to copy it manually.';}}
    return {role,roles,copyStatus,copy,safeSourceUrl,contactRoles,review:status=>emit('review',{group:props.group,status,role:role.value})};
  },
  template:`<article class="mapping-card contact-review-card" :data-contact-id="group.id">
    <div class="contact-review-value"><h3>{{group.value}}<sup v-if="group.needs_review">*</sup></h3><button type="button" class="contact-copy-button" :aria-label="'Copy '+group.value" @click="copy(group.value)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></svg></button></div>
    <p class="contact-review-meta">{{contactRoles[group.role]}} · {{group.status}}<span v-if="group.field==='email'"> · Email validity: {{group.email_validity}}</span><span v-if="preferred"> · Preferred by reviewer</span></p>
    <p><b>{{group.strength==='strong'?'Strong identity evidence':'Limited identity evidence'}} — still requires human validation.</b></p>
    <ul v-if="group.reasons.length"><li v-for="reason in group.reasons" :key="reason">{{reason}}</li></ul>
    <ul v-if="group.cautions.length" class="contact-review-cautions"><li v-for="reason in group.cautions" :key="reason">{{reason}}</li></ul>
    <p class="contact-review-meta">HSZ {{group.service_ids.join(', ')||'Service not established'}} · {{group.independent_source_families}} distinct source families · {{group.proof_count}} assessed excerpts</p>
    <details><summary>Evidence and original values</summary><div v-for="(proof,i) in group.proofs" :key="i"><blockquote>{{proof.excerpt}}</blockquote><p>{{proof.source_date?'Source date: '+proof.source_date:'Source date unavailable'}} · Retrieved {{proof.retrieved_at||'date unavailable'}}</p><a v-if="safeSourceUrl(proof.source_url)" :href="safeSourceUrl(proof.source_url)" target="_blank" rel="noopener noreferrer">{{proof.source_url}}</a></div><p v-if="!group.proofs.length">No retained excerpt supports this association. Review ownership before using it.</p><details v-if="group.original_observations?.length"><summary>All original observations ({{group.original_observations.length}})</summary><div v-for="(o,i) in group.original_observations" :key="i"><blockquote>{{o.evidence||o.quote||o.excerpt}}</blockquote><p>{{o.retrieved_at||o.observed_at||'Retrieval date unavailable'}} · {{o.temporal_status}}</p><a v-if="safeSourceUrl(o.source_url)" :href="safeSourceUrl(o.source_url)" target="_blank" rel="noopener noreferrer">Open original source</a></div></details><div v-if="group.variants.length>1"><p>Equivalent recorded values:</p><p v-for="value in group.variants" :key="value">{{value}} <button type="button" @click="copy(value)" :aria-label="'Copy original '+value">Copy</button></p></div></details>
    <label>Contact purpose<select v-model="role" :aria-label="'Purpose for '+group.value"><option v-for="[key,label] in roles" :key="key" :value="key">{{label}}</option></select></label>
    <div class="mapping-actions"><button :disabled="saving" @click="review('confirmed')">{{group.field==='email'?'Confirm clinic link':group.field==='website'&&role==='source_page'?'Confirm source relevance':'Confirm value and purpose'}}</button><button :disabled="saving" @click="review('rejected')">Reject</button><button :disabled="saving" @click="review('unreviewed')">Leave unresolved</button><button :disabled="saving||!group.eligible||preferred" @click="$emit('prefer',group)">{{preferred?'Preferred':'Use as preferred'}}</button></div>
    <p v-if="group.field==='email'"><a :href="'#email='+encodeURIComponent(group.value)" target="_blank" rel="noopener noreferrer">Review email validity separately</a></p><p role="status">{{copyStatus}}</p>
  </article>`
};

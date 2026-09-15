export default {
  props:{email:String,index:Number,total:Number,disabled:Boolean,editable:Boolean,itemLabel:{type:String,default:'email'},copyable:{type:Boolean,default:true}},
  emits:['move','copy','edit'],
  template:`
    <nav class="review-navigation" :aria-label="itemLabel.charAt(0).toUpperCase()+itemLabel.slice(1)+' navigation'">
      <button :disabled="index<=0||disabled" @click="$emit('move',-1)" :aria-label="'Previous '+itemLabel" :title="'Previous '+itemLabel+' (←)'">←</button>
      <span>{{index+1}} / {{total}}</span>
      <button :disabled="index>=total-1||disabled" @click="$emit('move',1)" :aria-label="'Next '+itemLabel" :title="'Next '+itemLabel+' (→)'">→</button>
    </nav>
    <div class="email-title-row">
      <h2>{{email}}</h2>
      <button v-if="copyable" class="copy-btn" @click="$emit('copy',email)" :title="'Copy '+itemLabel" :aria-label="'Copy '+itemLabel"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.5"/></svg></button>
      <button v-if="editable" class="edit-email-btn" @click="$emit('edit')" title="Edit email" aria-label="Edit email"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9.9 3.1l3 3M2.5 13.5l3.35-.7 6.7-6.7a2.12 2.12 0 00-3-3l-6.7 6.7-.35 3.7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
    </div>`
};

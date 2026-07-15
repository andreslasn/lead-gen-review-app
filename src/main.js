import { createApp, computed, onMounted, ref, watch } from "vue";
import "./styles.css";

const DB_NAME = "lead-gen-clinic-review";
const DB_VERSION = 1;
const REVIEW_FORMAT = "lead-gen-clinic-review";
const SCHEMA_VERSION = 1;
const STATES = ["needs_review", "confirmed", "no_email", "not_processed", "excluded"];
const REASON_CODES = ["wrong_clinic", "third_party", "invalid", "outdated", "duplicate", "other"];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("decisions")) db.createObjectStore("decisions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("clinic_states")) db.createObjectStore("clinic_states", { keyPath: "clinic_id" });
      if (!db.objectStoreNames.contains("audit_events")) db.createObjectStore("audit_events", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function txStore(db, storeName, mode = "readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || []);
  });
}

function put(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName, "readwrite").put(value);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(value);
  });
}

function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stateLabel(value) {
  return {
    needs_review: "Needs review",
    confirmed: "Confirmed",
    no_email: "No email",
    not_processed: "Not processed",
    excluded: "Excluded",
  }[value] || value;
}

function safeText(value) {
  return value == null || value === "" ? "—" : String(value);
}

function routeFromHash() {
  const hash = window.location.hash || "#/";
  const match = hash.match(/^#\/clinics\/([^/?]+)/);
  return match ? { page: "clinic", clinicId: decodeURIComponent(match[1]) } : { page: "queue" };
}

function highlightEvidence(link) {
  if (!link) return "";
  const prefix = escapeHtml(link.prefix_text || "");
  const quote = escapeHtml(link.exact_quote || "");
  const suffix = escapeHtml(link.suffix_text || "");
  return `${prefix}<mark>${quote}</mark>${suffix}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const App = {
  setup() {
    const db = ref(null);
    const route = ref(routeFromHash());
    const manifest = ref(null);
    const queue = ref([]);
    const clinic = ref(null);
    const decisions = ref([]);
    const localStates = ref([]);
    const selectedState = ref(localStorage.getItem("review.filter.state") || "needs_review");
    const search = ref(localStorage.getItem("review.filter.search") || "");
    const reviewer = ref(localStorage.getItem("review.reviewer") || "reviewer");
    const selectedCandidateId = ref(null);
    const reasonCode = ref("");
    const note = ref("");
    const editValue = ref("");
    const saveStatus = ref("Loading");
    const error = ref("");
    const lastExportAt = ref(localStorage.getItem("review.lastExportAt") || "");

    const localStateByClinic = computed(() => Object.fromEntries(localStates.value.map((item) => [item.clinic_id, item])));
    const decisionsByClinic = computed(() => {
      const grouped = {};
      for (const decision of decisions.value) {
        (grouped[decision.clinic_id] ||= []).push(decision);
      }
      return grouped;
    });
    const queueWithLocalState = computed(() => queue.value.map((item) => ({
      ...item,
      status: localStateByClinic.value[item.id]?.status || item.status,
      reviewed_at: localStateByClinic.value[item.id]?.reviewed_at || item.reviewed_at,
      local_decision_count: (decisionsByClinic.value[item.id] || []).length,
    })));
    const counts = computed(() => {
      const output = Object.fromEntries(STATES.map((state) => [state, 0]));
      for (const item of queueWithLocalState.value) output[item.status] = (output[item.status] || 0) + 1;
      return output;
    });
    const filteredQueue = computed(() => {
      const needle = search.value.trim().toLowerCase();
      return queueWithLocalState.value
        .filter((item) => selectedState.value === "all" || item.status === selectedState.value)
        .filter((item) => {
          if (!needle) return true;
          return [
            item.name,
            item.registry_id,
            item.city,
            item.region,
            item.domain,
            item.website,
            item.best_candidate?.value,
          ].some((value) => String(value || "").toLowerCase().includes(needle));
        })
        .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name));
    });
    const selectedCandidate = computed(() => {
      const candidates = clinic.value?.candidates || [];
      return candidates.find((item) => item.id === selectedCandidateId.value) || candidates[0] || null;
    });
    const selectedEvidence = computed(() => selectedCandidate.value?.evidence_links?.[0] || null);
    const currentClinicState = computed(() => clinic.value ? localStateByClinic.value[clinic.value.clinic.id] || clinic.value.state : null);
    const currentClinicDecisions = computed(() => clinic.value ? decisionsByClinic.value[clinic.value.clinic.id] || [] : []);

    async function init() {
      try {
        db.value = await openDb();
        await loadStaticData();
        await hydrateLocal();
        await mergeCanonicalState();
        await loadRoute();
        saveStatus.value = "Ready";
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      } catch (err) {
        error.value = err?.message || String(err);
      }
    }

    async function loadStaticData() {
      const [manifestResponse, queueResponse] = await Promise.all([
        fetch("data/manifest.json", { cache: "no-cache" }),
        fetch("data/queue.json", { cache: "no-cache" }),
      ]);
      if (!manifestResponse.ok || !queueResponse.ok) throw new Error("Review dataset is missing. Run lead-gen review package first.");
      manifest.value = await manifestResponse.json();
      const payload = await queueResponse.json();
      queue.value = payload.items || [];
    }

    async function hydrateLocal() {
      decisions.value = await getAll(db.value, "decisions");
      localStates.value = await getAll(db.value, "clinic_states");
    }

    async function mergeCanonicalState() {
      try {
        const response = await fetch("data/canonical-review-state.json", { cache: "no-cache" });
        if (!response.ok) return;
        const payload = await response.json();
        await mergeImport(payload, { silent: true });
      } catch (_) {
        return;
      }
    }

    async function loadRoute() {
      route.value = routeFromHash();
      if (route.value.page !== "clinic") {
        clinic.value = null;
        return;
      }
      const response = await fetch(`data/clinics/${encodeURIComponent(route.value.clinicId)}.json`, { cache: "no-cache" });
      if (!response.ok) throw new Error("Clinic review file not found.");
      clinic.value = await response.json();
      selectedCandidateId.value = clinic.value.candidates?.[0]?.id || null;
      editValue.value = selectedCandidate.value?.value || "";
      reasonCode.value = "";
      note.value = "";
    }

    function openClinic(id) {
      localStorage.setItem("review.lastQueueScroll", String(window.scrollY));
      window.location.hash = `#/clinics/${encodeURIComponent(id)}`;
    }

    function backToQueue() {
      window.location.hash = "#/";
      requestAnimationFrame(() => window.scrollTo(0, Number(localStorage.getItem("review.lastQueueScroll") || 0)));
    }

    function selectCandidate(candidate) {
      selectedCandidateId.value = candidate.id;
      editValue.value = candidate.value;
    }

    function moveCandidate(delta) {
      const candidates = clinic.value?.candidates || [];
      if (!candidates.length) return;
      const current = Math.max(0, candidates.findIndex((item) => item.id === selectedCandidateId.value));
      const next = Math.min(candidates.length - 1, Math.max(0, current + delta));
      selectCandidate(candidates[next]);
    }

    async function saveDecision(decisionType, overrides = {}) {
      if (!clinic.value) return;
      const candidate = selectedCandidate.value;
      const reviewedValue = (overrides.reviewed_value || editValue.value || candidate?.value || "").trim();
      if (["confirmed", "edited_confirmed"].includes(decisionType) && !reviewedValue) {
        error.value = "A confirmed decision needs an email value.";
        return;
      }
      const createdAt = nowIso();
      const decision = {
        id: uuid(),
        clinic_id: clinic.value.clinic.id,
        contact_point_id: candidate?.id || null,
        decision: decisionType,
        reviewed_value: reviewedValue || candidate?.value || "",
        original_value: candidate?.value || null,
        is_primary: decisionType !== "rejected" && Boolean(reviewedValue || candidate?.value),
        reason_code: reasonCode.value || overrides.reason_code || null,
        note: note.value || null,
        reviewer_id: reviewer.value || "reviewer",
        source_dataset_id: manifest.value?.dataset_id || null,
        source_dataset_version: manifest.value?.dataset_version || null,
        supersedes_id: null,
        created_at: createdAt,
      };
      const status = decisionType === "rejected" ? "needs_review" : "confirmed";
      await persistDecisionAndState(decision, status, decision.is_primary ? decision.id : null);
    }

    async function saveClinicState(status, reason = "") {
      if (!clinic.value) return;
      await persistDecisionAndState(null, status, null, reason);
    }

    async function persistDecisionAndState(decision, status, primaryDecisionId = null, reason = "") {
      saveStatus.value = "Saving locally";
      error.value = "";
      const timestamp = nowIso();
      if (decision) await put(db.value, "decisions", decision);
      const existing = localStateByClinic.value[clinic.value.clinic.id] || clinic.value.state || {};
      const state = {
        clinic_id: clinic.value.clinic.id,
        status,
        primary_review_decision_id: primaryDecisionId || existing.primary_review_decision_id || null,
        assigned_to: existing.assigned_to || null,
        reviewer_id: reviewer.value || "reviewer",
        reason_code: reasonCode.value || reason || null,
        note: note.value || null,
        version: Number(existing.version || 0) + 1,
        reviewed_at: ["confirmed", "no_email", "excluded"].includes(status) ? timestamp : existing.reviewed_at || null,
        updated_at: timestamp,
      };
      const event = {
        id: uuid(),
        clinic_id: clinic.value.clinic.id,
        type: decision ? `decision:${decision.decision}` : `state:${status}`,
        created_at: timestamp,
        reviewer_id: reviewer.value || "reviewer",
      };
      await put(db.value, "clinic_states", state);
      await put(db.value, "audit_events", event);
      await hydrateLocal();
      saveStatus.value = `Saved locally · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    async function saveAndNext() {
      await hydrateLocal();
      const currentId = clinic.value?.clinic?.id;
      const items = filteredQueue.value;
      const index = items.findIndex((item) => item.id === currentId);
      const next = items[index + 1] || queueWithLocalState.value.find((item) => item.status === "needs_review" && item.id !== currentId);
      if (next) openClinic(next.id);
      else backToQueue();
    }

    async function exportProgress() {
      const exportedAt = nowIso();
      const payload = {
        format: REVIEW_FORMAT,
        schema_version: SCHEMA_VERSION,
        dataset_id: manifest.value?.dataset_id || "unknown",
        dataset_version: manifest.value?.dataset_version || "unknown",
        base_data_hash: manifest.value?.base_data_hash || "sha256:unknown",
        reviewer: { id: reviewer.value || "reviewer" },
        exported_at: exportedAt,
        app_build: manifest.value?.source_commit || null,
        decisions: await getAll(db.value, "decisions"),
        clinic_states: await getAll(db.value, "clinic_states"),
        audit_events: await getAll(db.value, "audit_events"),
      };
      payload.checksum = await sha256(JSON.stringify({
        decisions: payload.decisions,
        clinic_states: payload.clinic_states,
        audit_events: payload.audit_events,
      }));
      const date = exportedAt.replaceAll(":", "").slice(0, 15);
      const filename = `clinic-review-${payload.dataset_id}-${payload.reviewer.id}-${date}.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
      lastExportAt.value = exportedAt;
      localStorage.setItem("review.lastExportAt", exportedAt);
      saveStatus.value = `Exported ${payload.decisions.length} decisions · ${payload.checksum.slice(0, 18)}`;
    }

    async function importProgress(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        await mergeImport(payload);
        await hydrateLocal();
        saveStatus.value = `Imported ${payload.decisions?.length || 0} decisions`;
      } catch (err) {
        error.value = err?.message || String(err);
      } finally {
        event.target.value = "";
      }
    }

    async function mergeImport(payload, { silent = false } = {}) {
      validatePayload(payload);
      if (!silent && manifest.value?.dataset_id && payload.dataset_id !== manifest.value.dataset_id) {
        const ok = confirm(`This export is for dataset ${payload.dataset_id}, current dataset is ${manifest.value.dataset_id}. Import anyway?`);
        if (!ok) return;
      }
      await put(db.value, "backups", {
        id: uuid(),
        created_at: nowIso(),
        decisions: await getAll(db.value, "decisions"),
        clinic_states: await getAll(db.value, "clinic_states"),
        audit_events: await getAll(db.value, "audit_events"),
      });
      for (const decision of payload.decisions || []) {
        const existing = await get(db.value, "decisions", decision.id);
        if (!existing || String(existing.created_at || "") <= String(decision.created_at || "")) {
          await put(db.value, "decisions", decision);
        }
      }
      for (const state of payload.clinic_states || []) {
        const existing = await get(db.value, "clinic_states", state.clinic_id);
        if (!existing || String(existing.updated_at || "") <= String(state.updated_at || "")) {
          await put(db.value, "clinic_states", state);
        }
      }
      for (const auditEvent of payload.audit_events || []) {
        if (!(await get(db.value, "audit_events", auditEvent.id))) await put(db.value, "audit_events", auditEvent);
      }
    }

    function validatePayload(payload) {
      if (payload.format !== REVIEW_FORMAT) throw new Error("Not a lead-gen review export.");
      if (payload.schema_version !== SCHEMA_VERSION) throw new Error("Unsupported review schema version.");
      if (!Array.isArray(payload.decisions) || !Array.isArray(payload.clinic_states)) throw new Error("Invalid review export shape.");
    }

    function visibleBackupReminder() {
      const completed = decisions.value.length + localStates.value.filter((item) => ["confirmed", "no_email", "excluded"].includes(item.status)).length;
      if (completed < 25) return false;
      if (!lastExportAt.value) return true;
      return Date.now() - new Date(lastExportAt.value).getTime() > 15 * 60 * 1000;
    }

    function onKey(event) {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (route.value.page !== "clinic") return;
      if (event.key === "1") saveDecision("confirmed");
      if (event.key === "2") saveDecision("rejected");
      if (event.key.toLowerCase() === "e") saveDecision("edited_confirmed", { reviewed_value: editValue.value });
      if (event.key.toLowerCase() === "n") saveClinicState("no_email", "checked_no_public_email");
      if (event.key.toLowerCase() === "x") saveClinicState("excluded", "out_of_scope");
      if (event.key.toLowerCase() === "j") moveCandidate(1);
      if (event.key.toLowerCase() === "k") moveCandidate(-1);
      if (event.key === "Enter") saveAndNext();
    }

    watch(search, (value) => localStorage.setItem("review.filter.search", value));
    watch(selectedState, (value) => localStorage.setItem("review.filter.state", value));
    watch(reviewer, (value) => localStorage.setItem("review.reviewer", value));
    watch(selectedCandidate, (value) => { editValue.value = value?.value || ""; });

    onMounted(() => {
      window.addEventListener("hashchange", loadRoute);
      window.addEventListener("keydown", onKey);
      init();
    });

    return {
      manifest,
      route,
      clinic,
      queue,
      filteredQueue,
      counts,
      selectedState,
      search,
      reviewer,
      selectedCandidate,
      selectedEvidence,
      selectedCandidateId,
      currentClinicState,
      currentClinicDecisions,
      reasonCode,
      note,
      editValue,
      saveStatus,
      error,
      lastExportAt,
      REASON_CODES,
      STATES,
      stateLabel,
      safeText,
      highlightEvidence,
      visibleBackupReminder,
      openClinic,
      backToQueue,
      selectCandidate,
      moveCandidate,
      saveDecision,
      saveClinicState,
      saveAndNext,
      exportProgress,
      importProgress,
    };
  },
  template: `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Lead Gen</p>
          <h1>Clinic email review</h1>
        </div>
        <div class="reviewer">
          <label>Reviewer <input v-model="reviewer" autocomplete="off" /></label>
          <button @click="exportProgress">Export progress</button>
          <label class="import-button">Import JSON<input type="file" accept="application/json" @change="importProgress" /></label>
        </div>
      </header>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div v-if="visibleBackupReminder()" class="alert">Export a backup soon. Browser storage is local to this browser profile.</div>
      <div class="statusline">
        <span>{{ saveStatus }}</span>
        <span v-if="manifest">{{ manifest.dataset_id }} · {{ manifest.generated_at }}</span>
      </div>

      <main v-if="route.page === 'queue'" class="queue">
        <section class="tabs">
          <button :class="{active:selectedState==='needs_review'}" @click="selectedState='needs_review'">Needs review <strong>{{ counts.needs_review || 0 }}</strong></button>
          <button :class="{active:selectedState==='confirmed'}" @click="selectedState='confirmed'">Confirmed <strong>{{ counts.confirmed || 0 }}</strong></button>
          <button :class="{active:selectedState==='no_email'}" @click="selectedState='no_email'">No email <strong>{{ counts.no_email || 0 }}</strong></button>
          <button :class="{active:selectedState==='not_processed'}" @click="selectedState='not_processed'">Not processed <strong>{{ counts.not_processed || 0 }}</strong></button>
          <button :class="{active:selectedState==='excluded'}" @click="selectedState='excluded'">Excluded <strong>{{ counts.excluded || 0 }}</strong></button>
          <button :class="{active:selectedState==='all'}" @click="selectedState='all'">All <strong>{{ queue.length }}</strong></button>
        </section>
        <div class="filters">
          <input v-model="search" type="search" placeholder="Search clinic, registry ID, city, domain, email…" />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Clinic / location</th><th>Best candidate</th><th>Evidence</th><th>Scores</th><th>Status</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in filteredQueue" :key="item.id" @click="openClinic(item.id)">
                <td><strong>{{ item.name }}</strong><small>{{ safeText(item.registry_id) }} · {{ safeText(item.city) }}{{ item.region ? ', ' + item.region : '' }}</small><small>{{ safeText(item.address) }}</small></td>
                <td><strong>{{ item.best_candidate?.value || '—' }}</strong><small>{{ item.candidate_email_count }} candidate(s) · {{ item.best_candidate?.classification || item.machine_status }}</small></td>
                <td><span>{{ item.domain || item.website || item.source_coverage_status || '—' }}</span><small>{{ item.best_candidate?.source_url || 'Open review for source evidence' }}</small></td>
                <td><span>Lead {{ item.lead_score || 0 }}</span><small>Quality {{ item.data_quality_score || 0 }} · hard {{ item.scrape_difficulty_score || 0 }}</small></td>
                <td><span class="pill" :class="item.status">{{ stateLabel(item.status) }}</span><small v-if="item.local_decision_count">{{ item.local_decision_count }} local decision(s)</small></td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>

      <main v-else-if="clinic" class="review-grid">
        <section class="decision-panel">
          <button class="plain" @click="backToQueue">← Queue</button>
          <h2>{{ clinic.clinic.name }}</h2>
          <p>{{ safeText(clinic.clinic.registry_id) }} · {{ safeText(clinic.clinic.city) }} · {{ safeText(clinic.clinic.address) }}</p>
          <dl class="facts">
            <div><dt>Status</dt><dd>{{ stateLabel(currentClinicState?.status) }}</dd></div>
            <div><dt>Website</dt><dd><a v-if="clinic.clinic.official_website || clinic.clinic.website" :href="clinic.clinic.official_website || clinic.clinic.website" target="_blank" rel="noreferrer">{{ clinic.clinic.official_domain || clinic.clinic.domain || clinic.clinic.website }}</a><span v-else>—</span></dd></div>
            <div><dt>Type</dt><dd>{{ clinic.clinic.clinic_type }} · {{ clinic.clinic.funding }}</dd></div>
            <div><dt>Machine</dt><dd>{{ clinic.machine_status }}</dd></div>
          </dl>
          <h3>Candidate emails</h3>
          <div v-if="clinic.candidates.length" class="candidates">
            <button v-for="candidate in clinic.candidates" :key="candidate.id" class="candidate" :class="{selected:candidate.id===selectedCandidateId}" @click="selectCandidate(candidate)">
              <strong>{{ candidate.value }}</strong>
              <small>{{ candidate.classification }} · {{ Math.round((candidate.confidence || 0) * 100) }}% · {{ candidate.usable_contact ? 'machine usable' : 'review' }}</small>
              <small>{{ candidate.owner_name || candidate.owner_type }} · {{ candidate.contact_role }}</small>
            </button>
          </div>
          <p v-else class="empty">No email candidate is available. Use No public email only if the available sources were checked.</p>
          <label>Edit value<input v-model="editValue" /></label>
          <label>Reason<select v-model="reasonCode"><option value="">No reason code</option><option v-for="reason in REASON_CODES" :key="reason" :value="reason">{{ reason.replaceAll('_', ' ') }}</option></select></label>
          <label>Note<textarea v-model="note" rows="3" placeholder="Optional reviewer note"></textarea></label>
          <div class="actions">
            <button @click="saveDecision('confirmed')">1 Confirm</button>
            <button class="secondary" @click="saveDecision('rejected')">2 Reject</button>
            <button class="secondary" @click="saveDecision('edited_confirmed', { reviewed_value: editValue })">E Edit + confirm</button>
            <button class="secondary" @click="saveClinicState('no_email', 'checked_no_public_email')">N No public email</button>
            <button class="danger" @click="saveClinicState('excluded', 'out_of_scope')">X Exclude</button>
            <button @click="saveAndNext">Enter Save + next</button>
          </div>
          <p class="shortcuts">J/K candidate · Enter save+next · shortcuts disabled while typing</p>
          <h3>Local decisions</h3>
          <ul class="history"><li v-for="decision in currentClinicDecisions" :key="decision.id">{{ decision.decision }} · {{ decision.reviewed_value }} · {{ decision.created_at }}</li></ul>
        </section>
        <section class="evidence-panel">
          <div class="evidence-head">
            <div><p class="eyebrow">Evidence</p><h2>{{ selectedCandidate?.value || 'No candidate selected' }}</h2></div>
            <a v-if="selectedEvidence?.open_url" :href="selectedEvidence.open_url" target="_blank" rel="noreferrer">Open original</a>
          </div>
          <div v-if="selectedCandidate" class="evidence-meta">
            <span>{{ selectedEvidence?.evidence_kind || 'evidence' }}</span>
            <span>{{ selectedEvidence?.title || selectedEvidence?.source_url || selectedCandidate.source_url || '—' }}</span>
            <span>{{ selectedEvidence?.observed_at || selectedCandidate.observed_at || '—' }}</span>
          </div>
          <pre v-if="selectedEvidence" class="evidence-text" v-html="highlightEvidence(selectedEvidence)"></pre>
          <div v-if="selectedCandidate" class="source-card">
            <h3>Extraction metadata</h3>
            <p>{{ selectedCandidate.reason || 'No reason recorded.' }}</p>
            <p>{{ selectedCandidate.evidence || '' }}</p>
            <ul><li v-for="ctx in selectedCandidate.page_context" :key="ctx">{{ ctx }}</li></ul>
          </div>
          <div class="source-card">
            <h3>Available sources</h3>
            <ul><li v-for="source in clinic.sources" :key="source.url"><a :href="source.url" target="_blank" rel="noreferrer">{{ source.domain || source.url }}</a> · {{ source.source_role }} · {{ source.ownership_status }} · useful {{ source.useful }}</li></ul>
          </div>
        </section>
      </main>
    </div>
  `,
};

createApp(App).mount("#app");

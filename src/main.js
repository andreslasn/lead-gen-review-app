import { createApp, computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import "./styles.css";

const DB_NAME = "lead-gen-clinic-review";
const DB_VERSION = 1;
const REVIEW_FORMAT = "lead-gen-clinic-review";
const SCHEMA_VERSION = 1;
const STATES = ["needs_review", "confirmed", "no_email", "not_processed", "excluded"];
const DECISION_REASON_CODES = [
  { key: "w", code: "wrong_clinic", label: "Wrong clinic" },
  { key: "t", code: "third_party", label: "Third party" },
  { key: "o", code: "outdated", label: "Outdated" },
  { key: "d", code: "duplicate", label: "Duplicate" },
  { key: "i", code: "invalid", label: "Invalid" },
  { key: "x", code: "other", label: "Other" },
];
const PREFETCH_COUNT = 3;

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

function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

function put(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName, "readwrite").put(value);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(value);
  });
}

function deleteValue(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = txStore(db, storeName, "readwrite").delete(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(true);
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

function safeText(value) {
  return value == null || value === "" ? "—" : String(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function routeClinicId() {
  return (window.location.hash || "").match(/^#\/clinics\/([^/?]+)/)?.[1] || null;
}

function normalizeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function stateLabel(value) {
  return {
    needs_review: "Needs review",
    confirmed: "Confirmed",
    no_email: "No email",
    not_processed: "Not processed",
    excluded: "Excluded",
  }[value] || value || "Needs review";
}

function laneLabel(value) {
  return {
    review: "Review",
    auto_confirm: "Auto-confirm audit",
    auto_suppress: "Auto-suppress",
    no_email: "No email",
    all: "All",
  }[value] || value;
}

function candidateLane(item) {
  const candidate = item.best_candidate || {};
  const confidence = Number(candidate.confidence || 0);
  const sourceRole = item.source_coverage_status || "";
  const sourceHost = normalizeHost(candidate.source_url || item.website || "");
  const itemHost = normalizeHost(item.website || "");
  const sameDomain = Boolean(sourceHost && itemHost && sourceHost === itemHost);

  if (!candidate.value) return "no_email";
  if (
    candidate.usable_contact
    && confidence >= 0.9
    && ["verified_official", "official", "official_verified"].includes(sourceRole)
    && (sameDomain || candidate.verification_status === "corroborated" || candidate.association_type === "clinic_contact")
  ) {
    return "auto_confirm";
  }
  if (!candidate.usable_contact && confidence < 0.4) return "auto_suppress";
  if (["third_party", "directory_operator", "webmaster"].includes(candidate.classification)) return "auto_suppress";
  return "review";
}

function lanePriority(lane) {
  return { review: 4, auto_confirm: 3, no_email: 2, auto_suppress: 1 }[lane] || 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function evidenceHtml(link, fallback = "") {
  if (!link) return escapeHtml(fallback || "No compact evidence was packaged for this candidate.");
  const prefix = escapeHtml(link.prefix_text || "");
  const quote = escapeHtml(link.exact_quote || "");
  const suffix = escapeHtml(link.suffix_text || "");
  return `${prefix}<mark>${quote}</mark>${suffix}`;
}

function candidateRoleLabel(candidate) {
  const text = [
    candidate?.value,
    candidate?.reason,
    candidate?.evidence,
    candidate?.contact_role,
    candidate?.owner_name,
  ].join(" ").toLowerCase();
  const classification = String(candidate?.classification || "").toLowerCase();
  const contactRole = String(candidate?.contact_role || "").toLowerCase();
  if (/(recept|prescription|rx|repeat)/i.test(text) || contactRole.includes("prescription")) return "Prescription/refill";
  if (classification.includes("staff") || classification.includes("doctor") || contactRole.includes("doctor") || /^dr[._-]/i.test(candidate?.value || "")) return "Doctor/staff";
  if (classification.includes("clinic") || contactRole.includes("clinic")) return "Clinic contact";
  if (classification.includes("generic")) return "Generic mailbox";
  if (classification.includes("third") || classification.includes("directory") || classification.includes("webmaster")) return "Not clinic-owned";
  return "Unclear";
}

function candidateSourceLabel(candidate, item) {
  const source = normalizeHost(candidate?.source_url || candidate?.evidence_links?.[0]?.source_url || item?.website || "");
  if (item?.source_coverage_status === "verified_official") return source ? `Official · ${source}` : "Official";
  return source || "Source";
}

function candidateEvidenceCount(candidate) {
  const count = candidate?.evidence_links?.length || 0;
  return count ? `${count} evidence` : "Evidence";
}

const App = {
  setup() {
    const db = ref(null);
    const manifest = ref(null);
    const queue = ref([]);
    const clinic = ref(null);
    const clinicCache = ref({});
    const decisions = ref([]);
    const localStates = ref([]);
    const reviewer = ref(localStorage.getItem("review.reviewer") || "reviewer");
    const search = ref(localStorage.getItem("review.filter.search") || "");
    const selectedLane = ref(localStorage.getItem("review.filter.lane") || "review");
    const currentIndex = ref(0);
    const selectedCandidateIndex = ref(0);
    const evidenceTab = ref("snapshot");
    const archiveFrame = ref(null);
    const saveStatus = ref("Loading");
    const error = ref("");
    const pendingReject = ref(false);
    const editMode = ref(false);
    const editValue = ref("");
    const note = ref("");
    const lastExportAt = ref(localStorage.getItem("review.lastExportAt") || "");
    const lastAction = ref(null);
    const sessionStartedAt = ref(Date.now());
    const sessionDecisionCount = ref(0);
    const itemStartedAt = ref(Date.now());
    const evidencePane = ref(null);

    const localStateByClinic = computed(() => Object.fromEntries(localStates.value.map((item) => [item.clinic_id, item])));
    const decisionsByClinic = computed(() => {
      const grouped = {};
      for (const decision of decisions.value) (grouped[decision.clinic_id] ||= []).push(decision);
      return grouped;
    });
    const preparedQueue = computed(() => queue.value.map((item) => {
      const localState = localStateByClinic.value[item.id];
      const lane = candidateLane(item);
      return {
        ...item,
        lane,
        status: localState?.status || item.status,
        reviewed_at: localState?.reviewed_at || item.reviewed_at,
        local_decision_count: (decisionsByClinic.value[item.id] || []).length,
      };
    }));
    const filteredQueue = computed(() => {
      const needle = search.value.trim().toLowerCase();
      return preparedQueue.value
        .filter((item) => selectedLane.value === "all" || item.lane === selectedLane.value)
        .filter((item) => item.status === "needs_review" || selectedLane.value === "all")
        .filter((item) => {
          if (!needle) return true;
          return [
            item.name,
            item.registry_id,
            item.city,
            item.region,
            item.address,
            item.domain,
            item.website,
            item.best_candidate?.value,
          ].some((value) => String(value || "").toLowerCase().includes(needle));
        })
        .sort((a, b) => lanePriority(b.lane) - lanePriority(a.lane) || (b.priority || 0) - (a.priority || 0));
    });
    const laneCounts = computed(() => {
      const counts = { review: 0, auto_confirm: 0, auto_suppress: 0, no_email: 0, all: preparedQueue.value.length };
      for (const item of preparedQueue.value) counts[item.lane] = (counts[item.lane] || 0) + 1;
      return counts;
    });
    const currentItem = computed(() => filteredQueue.value[currentIndex.value] || null);
    const candidates = computed(() => {
      const raw = clinic.value?.candidates || [];
      const validEmails = raw.filter((candidate) => String(candidate?.value || "").includes("@"));
      return validEmails.length ? validEmails : raw;
    });
    const selectedCandidate = computed(() => candidates.value[selectedCandidateIndex.value] || candidates.value[0] || currentItem.value?.best_candidate || null);
    const selectedEvidence = computed(() => selectedCandidate.value?.evidence_links?.[0] || null);
    const currentClinicState = computed(() => clinic.value ? localStateByClinic.value[clinic.value.clinic.id] || clinic.value.state : null);
    const currentClinicDecisions = computed(() => clinic.value ? decisionsByClinic.value[clinic.value.clinic.id] || [] : []);
    const snapshotTitle = computed(() => selectedEvidence.value?.title || selectedEvidence.value?.source_url || selectedCandidate.value?.source_url || "Cached evidence");
    const evidenceBody = computed(() => evidenceHtml(selectedEvidence.value, selectedCandidate.value?.evidence || ""));

    function artifactUrl(path) {
      if (!path) return null;
      const clean = String(path).replace(/^\/+/, "");
      return `data/${clean}`;
    }

    function focusedHtmlUrl(path, value) {
      const url = artifactUrl(path);
      if (!url) return null;
      const needle = String(value || "").trim();
      return needle ? `${url}#:~:text=${encodeURIComponent(needle)}` : url;
    }

    function focusArchivedEvidence(event) {
      const frame = event?.target || archiveFrame.value;
      const document = frame?.contentDocument;
      const needle = String(selectedCandidate.value?.value || "").trim().toLowerCase();
      if (!document || !needle) return;
      for (const element of document.querySelectorAll("[class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i]")) {
        element.style.setProperty("display", "none", "important");
      }
      let target = [...document.querySelectorAll("a[href^='mailto:' i]")].find((element) =>
        `${element.textContent || ""} ${element.getAttribute("href") || ""}`.toLowerCase().includes(needle)
      );
      if (!target) {
        target = [...document.querySelectorAll("*")].find((element) =>
          [...element.attributes].some((attribute) => String(attribute.value || "").toLowerCase().includes(needle))
        );
      }
      if (!target && document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (String(node.nodeValue || "").toLowerCase().includes(needle)) {
            target = node.parentElement;
            break;
          }
        }
      }
      if (!target) return;
      target.style.setProperty("background", "#fff36d", "important");
      target.style.setProperty("color", "#111", "important");
      target.style.setProperty("outline", "5px solid #ff2d7d", "important");
      target.style.setProperty("outline-offset", "4px", "important");
      const badge = document.createElement("div");
      badge.textContent = `Email evidence: ${selectedCandidate.value?.value || ""}`;
      badge.style.cssText = "display:block!important;margin:10px 0!important;padding:10px 12px!important;background:#ff2d7d!important;color:white!important;font:700 16px/1.25 sans-serif!important;border-radius:6px!important;";
      target.insertAdjacentElement("afterend", badge);
      requestAnimationFrame(() => target.scrollIntoView({ block: "center", inline: "nearest" }));
    }

    async function init() {
      try {
        db.value = await openDb();
        await loadStaticData();
        await hydrateLocal();
        await mergeCanonicalState();
        await hydrateLocal();
        const routeId = routeClinicId();
        const routeIndex = routeId ? filteredQueue.value.findIndex((item) => item.id === decodeURIComponent(routeId)) : -1;
        await setIndex(routeIndex >= 0 ? routeIndex : 0, { updateHash: false });
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

    async function loadClinic(clinicId) {
      if (!clinicId) return null;
      if (clinicCache.value[clinicId]) return clinicCache.value[clinicId];
      const response = await fetch(`data/clinics/${encodeURIComponent(clinicId)}.json`, { cache: "no-cache" });
      if (!response.ok) throw new Error("Clinic review file not found.");
      const payload = await response.json();
      clinicCache.value = { ...clinicCache.value, [clinicId]: payload };
      return payload;
    }

    async function setIndex(index, { updateHash = true } = {}) {
      if (!filteredQueue.value.length) {
        clinic.value = null;
        return;
      }
      currentIndex.value = clamp(index, 0, filteredQueue.value.length - 1);
      const item = filteredQueue.value[currentIndex.value];
      pendingReject.value = false;
      editMode.value = false;
      note.value = "";
      selectedCandidateIndex.value = 0;
      clinic.value = await loadClinic(item.id);
      evidenceTab.value = selectedEvidence.value?.raw_html_path ? "archive" : "snapshot";
      editValue.value = selectedCandidate.value?.value || "";
      itemStartedAt.value = Date.now();
      if (updateHash) window.history.replaceState(null, "", `#/clinics/${encodeURIComponent(item.id)}`);
      await nextTick();
      scrollEvidenceToHighlight();
      prefetchUpcoming();
    }

    function prefetchUpcoming() {
      for (let offset = 1; offset <= PREFETCH_COUNT; offset += 1) {
        const next = filteredQueue.value[currentIndex.value + offset];
        if (next && !clinicCache.value[next.id]) loadClinic(next.id).catch(() => {});
      }
    }

    function scrollEvidenceToHighlight() {
      const mark = evidencePane.value?.querySelector("mark");
      if (mark) mark.scrollIntoView({ block: "center" });
      else if (evidencePane.value) evidencePane.value.scrollTop = 0;
    }

    function selectCandidate(index) {
      selectedCandidateIndex.value = clamp(index, 0, Math.max(candidates.value.length - 1, 0));
      editValue.value = selectedCandidate.value?.value || "";
      pendingReject.value = false;
      evidenceTab.value = selectedEvidence.value?.raw_html_path ? "archive" : "snapshot";
      nextTick(scrollEvidenceToHighlight);
    }

    function moveCandidate(delta) {
      if (!candidates.value.length) return;
      selectCandidate(selectedCandidateIndex.value + delta);
    }

    async function nextLead() {
      await setIndex(currentIndex.value + 1);
    }

    async function previousLead() {
      await setIndex(currentIndex.value - 1);
    }

    async function saveDecision(decisionType, { reasonCode = null, reviewedValue = null } = {}) {
      if (!clinic.value) return;
      const candidate = selectedCandidate.value;
      const value = (reviewedValue || editValue.value || candidate?.value || "").trim();
      if (["confirmed", "edited_confirmed"].includes(decisionType) && !value) {
        error.value = "A confirmed decision needs an email value.";
        return;
      }
      const previousState = currentClinicState.value ? { ...currentClinicState.value } : null;
      const createdAt = nowIso();
      const decision = decisionType === "no_email" ? null : {
        id: uuid(),
        clinic_id: clinic.value.clinic.id,
        contact_point_id: candidate?.id || null,
        decision: decisionType,
        reviewed_value: value || candidate?.value || "",
        original_value: candidate?.value || null,
        is_primary: decisionType !== "rejected" && Boolean(value || candidate?.value),
        reason_code: reasonCode,
        note: note.value || null,
        reviewer_id: reviewer.value || "reviewer",
        source_dataset_id: manifest.value?.dataset_id || null,
        source_dataset_version: manifest.value?.dataset_version || null,
        supersedes_id: null,
        created_at: createdAt,
        evidence_viewed: evidenceTab.value,
        evidence_link_id: selectedEvidence.value?.id || null,
        decision_duration_ms: Date.now() - itemStartedAt.value,
        queue_lane: currentItem.value?.lane || null,
        selected_candidate_rank: selectedCandidateIndex.value + 1,
        selected_candidate_role_guess: candidateRoleLabel(candidate || {}),
        candidate_options: candidates.value.map((option, index) => ({
          id: option.id || null,
          value: option.value || "",
          rank: index + 1,
          role_guess: candidateRoleLabel(option),
          source_url: option.source_url || option.evidence_links?.[0]?.source_url || null,
          selected: index === selectedCandidateIndex.value,
        })),
      };
      const status = decisionType === "rejected" ? "needs_review" : decisionType === "no_email" ? "no_email" : "confirmed";
      await persistDecisionAndState(decision, status, decision?.is_primary ? decision.id : null, reasonCode, previousState);
      pendingReject.value = false;
      editMode.value = false;
      sessionDecisionCount.value += 1;
      saveStatus.value = `${stateLabel(status)} · press U to undo`;
      if (status === "needs_review") await nextLead();
      else await setIndex(currentIndex.value);
    }

    async function persistDecisionAndState(decision, status, primaryDecisionId = null, reason = null, previousState = null) {
      error.value = "";
      const timestamp = nowIso();
      if (decision) await put(db.value, "decisions", decision);
      const existing = previousState || currentClinicState.value || {};
      const state = {
        clinic_id: clinic.value.clinic.id,
        status,
        primary_review_decision_id: primaryDecisionId || existing.primary_review_decision_id || null,
        assigned_to: existing.assigned_to || null,
        reviewer_id: reviewer.value || "reviewer",
        reason_code: reason || null,
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
        evidence_viewed: evidenceTab.value,
        decision_duration_ms: Date.now() - itemStartedAt.value,
      };
      await put(db.value, "clinic_states", state);
      await put(db.value, "audit_events", event);
      lastAction.value = {
        decision_id: decision?.id || null,
        state_clinic_id: state.clinic_id,
        previous_state: previousState,
        audit_event_id: event.id,
      };
      await hydrateLocal();
    }

    async function undoLastAction() {
      if (!lastAction.value || !db.value) return;
      if (lastAction.value.decision_id) await deleteValue(db.value, "decisions", lastAction.value.decision_id);
      if (lastAction.value.audit_event_id) await deleteValue(db.value, "audit_events", lastAction.value.audit_event_id);
      if (lastAction.value.previous_state) await put(db.value, "clinic_states", lastAction.value.previous_state);
      else await deleteValue(db.value, "clinic_states", lastAction.value.state_clinic_id);
      await hydrateLocal();
      saveStatus.value = "Undone";
      const index = filteredQueue.value.findIndex((item) => item.id === lastAction.value.state_clinic_id);
      lastAction.value = null;
      if (index >= 0) await setIndex(index);
    }

    function rejectWithReason(reason) {
      saveDecision("rejected", { reasonCode: reason.code });
    }

    async function markNoPublicEmail() {
      await saveDecision("no_email", { reasonCode: "checked_no_public_email", reviewedValue: "" });
    }

    async function excludeCurrent() {
      if (!clinic.value) return;
      const previousState = currentClinicState.value ? { ...currentClinicState.value } : null;
      await persistDecisionAndState(null, "excluded", null, "out_of_scope", previousState);
      sessionDecisionCount.value += 1;
      saveStatus.value = "Excluded · press U to undo";
      await setIndex(currentIndex.value);
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
      saveStatus.value = `Exported ${payload.decisions.length} decisions`;
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

    async function mergeCanonicalState() {
      try {
        const response = await fetch("data/canonical-review-state.json", { cache: "no-cache" });
        if (!response.ok) return;
        await mergeImport(await response.json(), { silent: true });
      } catch (_) {
        return;
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
        if (!existing || String(existing.created_at || "") <= String(decision.created_at || "")) await put(db.value, "decisions", decision);
      }
      for (const state of payload.clinic_states || []) {
        const existing = await get(db.value, "clinic_states", state.clinic_id);
        if (!existing || String(existing.updated_at || "") <= String(state.updated_at || "")) await put(db.value, "clinic_states", state);
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
      const key = event.key.toLowerCase();
      if (pendingReject.value) {
        const reason = DECISION_REASON_CODES.find((item) => item.key === key);
        if (reason) {
          event.preventDefault();
          rejectWithReason(reason);
        }
      if (key === "escape") pendingReject.value = false;
        return;
      }
      if (event.key === "1") saveDecision("confirmed");
      if (key === "enter") saveDecision("confirmed");
      if (event.key === "2") pendingReject.value = true;
      if (event.key === "3") markNoPublicEmail();
      if (key === "j") moveCandidate(1);
      if (key === "k") moveCandidate(-1);
      if (key === "u") undoLastAction();
      if (key === "arrowright") nextLead();
      if (key === "arrowleft") previousLead();
    }

    watch(search, (value) => {
      localStorage.setItem("review.filter.search", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(selectedLane, (value) => {
      localStorage.setItem("review.filter.lane", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(reviewer, (value) => localStorage.setItem("review.reviewer", value));
    watch(evidenceTab, () => nextTick(scrollEvidenceToHighlight));

    onMounted(() => {
      window.addEventListener("keydown", onKey);
      init();
    });

    onUnmounted(() => {
      window.removeEventListener("keydown", onKey);
    });

    return {
      manifest,
      clinic,
      currentItem,
      filteredQueue,
      laneCounts,
      selectedLane,
      laneLabel,
      reviewer,
      search,
      candidates,
      selectedCandidate,
      selectedCandidateIndex,
      selectedEvidence,
      evidenceBody,
      evidencePane,
      archiveFrame,
      evidenceTab,
      snapshotTitle,
      currentClinicState,
      currentClinicDecisions,
      pendingReject,
      editMode,
      editValue,
      note,
      saveStatus,
      error,
      lastExportAt,
      DECISION_REASON_CODES,
      safeText,
      candidateRoleLabel,
      candidateSourceLabel,
      candidateEvidenceCount,
      artifactUrl,
      focusedHtmlUrl,
      focusArchivedEvidence,
      stateLabel,
      visibleBackupReminder,
      selectCandidate,
      saveDecision,
      rejectWithReason,
      markNoPublicEmail,
      excludeCurrent,
      nextLead,
      previousLead,
      undoLastAction,
      exportProgress,
      importProgress,
    };
  },
  template: `
    <div class="app-shell">
      <section class="queue-bar">
        <input v-model="search" class="search" type="search" placeholder="Search clinic, city, registry ID, email…" />
        <div class="lane-tabs">
          <button v-for="lane in ['review','auto_confirm','auto_suppress','no_email','all']" :key="lane" :class="{active:selectedLane===lane}" @click="selectedLane=lane">
            {{ laneLabel(lane) }} <strong>{{ laneCounts[lane] || 0 }}</strong>
          </button>
        </div>
      </section>

      <div v-if="error" class="alert error">{{ error }}</div>
      <div v-if="visibleBackupReminder()" class="alert">Export a backup soon. Browser storage is local to this browser profile.</div>

      <main v-if="currentItem && clinic" class="review-layout">
        <section class="decision-pane">
          <div class="clinic-meta">
            <span class="pill lane">{{ laneLabel(currentItem.lane) }}</span>
            <span class="muted">{{ currentItem.city }} · {{ currentItem.registry_id }}</span>
          </div>
          <h2>{{ clinic.clinic.name }}</h2>
          <p class="clinic-address">{{ clinic.clinic.address }}</p>

          <section class="candidate-card">
            <p class="label">Email candidates</p>
            <div v-if="candidates.length" class="candidate-table-wrap">
              <table class="candidate-table">
                <thead><tr><th></th><th>Email</th><th>Role guess</th><th>Source</th></tr></thead>
                <tbody>
                  <tr v-for="(candidate, index) in candidates" :key="candidate.id || candidate.value || index" :class="{selected:index===selectedCandidateIndex}" @click="selectCandidate(index)" @dblclick="saveDecision('confirmed')">
                    <td class="candidate-radio">{{ index === selectedCandidateIndex ? '●' : '○' }}</td>
                    <td><span class="candidate-email">{{ candidate.value }}</span></td>
                    <td>{{ candidateRoleLabel(candidate) }}</td>
                    <td><span>{{ candidateSourceLabel(candidate, currentItem) }}</span><small>{{ candidateEvidenceCount(candidate) }}</small></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="muted">No email candidate packaged for this clinic.</p>
            <p class="candidate-reason">{{ selectedCandidate?.reason || selectedCandidate?.evidence || 'No machine reason recorded.' }}</p>
            <div v-if="selectedCandidate?.triage" class="triage-summary" :class="'triage-' + selectedCandidate.triage.decision">
              <div class="triage-heading">
                <span class="pill">Machine triage: {{ selectedCandidate.triage.decision }}</span>
                <strong>{{ selectedCandidate.triage.ownership_class }} · {{ Math.round(Number(selectedCandidate.triage.confidence || 0) * 100) }}%</strong>
              </div>
              <p>{{ selectedCandidate.triage.reason }}</p>
              <blockquote v-if="selectedCandidate.triage.exact_quote">{{ selectedCandidate.triage.exact_quote }}</blockquote>
            </div>
          </section>

          <section class="excerpt-card">
            <p class="label">Evidence excerpt</p>
            <div class="excerpt" v-html="evidenceBody"></div>
          </section>

          <section v-if="pendingReject" class="reason-panel">
            <p class="label">Reject reason</p>
            <div class="reason-grid">
              <button v-for="reason in DECISION_REASON_CODES" :key="reason.code" @click="rejectWithReason(reason)">
                <strong>{{ reason.key }}</strong> {{ reason.label }}
              </button>
            </div>
            <p class="muted">Press reason key, or Esc to cancel.</p>
          </section>

          <section v-if="editMode" class="edit-panel">
            <label>Edit email<input v-model="editValue" /></label>
            <label>Note<textarea v-model="note" rows="3" placeholder="Optional note"></textarea></label>
            <button @click="saveDecision('edited_confirmed', { reviewedValue: editValue })">Save edited email</button>
          </section>

          <div class="action-bar">
            <button class="primary" @click="saveDecision('confirmed')"><kbd>1</kbd> Confirm</button>
            <button class="secondary" @click="pendingReject=true"><kbd>2</kbd> Reject</button>
            <button class="secondary" @click="markNoPublicEmail"><kbd>3</kbd> No public email</button>
            <button class="quiet" @click="editMode=!editMode">Edit</button>
            <button class="quiet" @click="excludeCurrent">Exclude</button>
            <button class="quiet" @click="undoLastAction"><kbd>U</kbd> Undo</button>
          </div>

          <p class="shortcut-line">J/K alternate · ←/→ lead · decisions auto-advance</p>
        </section>

        <section class="evidence-pane">
          <div class="evidence-toolbar">
            <div>
              <p class="eyebrow">Captured evidence</p>
              <h2>{{ snapshotTitle }}</h2>
            </div>
            <div class="evidence-links">
              <a v-if="selectedEvidence?.raw_html_path" :href="focusedHtmlUrl(selectedEvidence.raw_html_path, selectedCandidate?.value)" target="_blank" rel="noreferrer">Centered HTML ↗</a>
              <a v-if="selectedEvidence?.raw_html_path" :href="artifactUrl(selectedEvidence.raw_html_path)" target="_blank" rel="noreferrer">Raw HTML ↗</a>
              <a v-if="selectedEvidence?.screenshot_path" :href="artifactUrl(selectedEvidence.screenshot_path)" target="_blank" rel="noreferrer">Screenshot ↗</a>
              <a v-if="selectedEvidence?.open_url || selectedCandidate?.source_url" :href="selectedEvidence?.open_url || selectedCandidate?.source_url" target="_blank" rel="noreferrer">Open live site ↗</a>
            </div>
          </div>
          <nav class="evidence-tabs">
            <button v-if="selectedEvidence?.raw_html_path" :class="{active:evidenceTab==='archive'}" @click="evidenceTab='archive'">Archived HTML</button>
            <button :class="{active:evidenceTab==='snapshot'}" @click="evidenceTab='snapshot'">Snapshot</button>
            <button :class="{active:evidenceTab==='live'}" @click="evidenceTab='live'">Live</button>
            <button :class="{active:evidenceTab==='sources'}" @click="evidenceTab='sources'">Sources</button>
          </nav>

          <div v-if="evidenceTab==='archive'" class="archive-pane">
            <p class="archive-note">Archived source, positioned at <strong>{{ selectedCandidate?.value }}</strong>. Scripts and forms are disabled.</p>
            <iframe
              class="archive-frame"
              :src="focusedHtmlUrl(selectedEvidence?.raw_html_path, selectedCandidate?.value)"
              :title="'Archived evidence for ' + (selectedCandidate?.value || 'email')"
              sandbox="allow-same-origin"
              referrerpolicy="no-referrer"
              ref="archiveFrame"
              @load="focusArchivedEvidence"
            ></iframe>
          </div>

          <div v-else-if="evidenceTab==='snapshot'" ref="evidencePane" class="snapshot-pane">
            <div class="snapshot-meta">
              <span>{{ selectedEvidence?.evidence_kind || 'evidence' }}</span>
              <span>{{ selectedEvidence?.observed_at || selectedCandidate?.observed_at || 'unknown time' }}</span>
              <span>{{ selectedCandidate?.source_url || selectedEvidence?.source_url || 'unknown source' }}</span>
            </div>
            <a v-if="selectedEvidence?.screenshot_path" :href="artifactUrl(selectedEvidence.screenshot_path)" target="_blank" rel="noreferrer">
              <img class="evidence-screenshot" :src="artifactUrl(selectedEvidence.screenshot_path)" alt="Saved full-page evidence screenshot" />
            </a>
            <pre class="snapshot-text" v-html="evidenceBody"></pre>
          </div>

          <div v-else-if="evidenceTab==='live'" class="live-pane">
            <h3>Live website is intentionally not embedded.</h3>
            <p>Review decisions should be based on the captured evidence snapshot. Live pages can change and many sites block iframes with CSP or X-Frame-Options.</p>
            <a class="primary-link" v-if="selectedEvidence?.open_url || selectedCandidate?.source_url" :href="selectedEvidence?.open_url || selectedCandidate?.source_url" target="_blank" rel="noreferrer">Open current live page ↗</a>
          </div>

          <div v-else class="sources-pane">
            <details open>
              <summary>Candidate metadata</summary>
              <dl>
                <div><dt>Owner</dt><dd>{{ selectedCandidate?.owner_name || selectedCandidate?.owner_type || '—' }}</dd></div>
                <div><dt>Role</dt><dd>{{ selectedCandidate?.contact_role || selectedCandidate?.associated_role || '—' }}</dd></div>
                <div><dt>Association</dt><dd>{{ selectedCandidate?.association_type || '—' }}</dd></div>
                <div><dt>Deliverability</dt><dd>{{ selectedCandidate?.syntax_status || '—' }} · {{ selectedCandidate?.mx_status || '—' }} · {{ selectedCandidate?.deliverability_status || '—' }}</dd></div>
                <div v-if="selectedCandidate?.triage"><dt>Triage</dt><dd>{{ selectedCandidate.triage.method }} · {{ selectedCandidate.triage.decision }} · {{ selectedCandidate.triage.ownership_class }}</dd></div>
              </dl>
            </details>
            <details>
              <summary>All sources</summary>
              <ul>
                <li v-for="source in clinic.sources" :key="source.url">
                  <a :href="source.url" target="_blank" rel="noreferrer">{{ source.domain || source.url }}</a>
                  <span>{{ source.source_role }} · {{ source.ownership_status }} · useful {{ source.useful }}</span>
                </li>
              </ul>
            </details>
            <details>
              <summary>Local decision history</summary>
              <ul>
                <li v-for="decision in currentClinicDecisions" :key="decision.id">{{ decision.decision }} · {{ decision.reviewed_value }} · {{ decision.created_at }}</li>
              </ul>
            </details>
          </div>
        </section>
      </main>

      <main v-else class="empty-state">
        <h2>No leads in this lane.</h2>
        <p>Change the lane filter or search query.</p>
      </main>

      <button class="floating-export" @click="exportProgress" :title="saveStatus">Export .json</button>
    </div>
  `,
};

createApp(App).mount("#app");

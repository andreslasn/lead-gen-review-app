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
const ROLE_OPTIONS = [
  { value: "clinic_contact", label: "Generic contact" },
  { value: "doctor_staff", label: "Doctor/staff" },
  { value: "prescription_refill", label: "Prescription/refill" },
  { value: "not_clinic_owned", label: "Not clinic-owned" },
  { value: "unclear", label: "Unclear" },
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

function fullEvidenceHtml(text, email) {
  const source = String(text || "").replaceAll("\u0000", " ");
  const needle = String(email || "").trim();
  if (!source || !needle) return escapeHtml(source);
  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return escapeHtml(source);
  return `${escapeHtml(source.slice(0, index))}<mark>${escapeHtml(source.slice(index, index + needle.length))}</mark>${escapeHtml(source.slice(index + needle.length))}`;
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
  if (classification.includes("clinic") || contactRole.includes("clinic")) return "Generic contact";
  if (classification.includes("generic")) return "Generic contact";
  if (classification.includes("third") || classification.includes("directory") || classification.includes("webmaster")) return "Not clinic-owned";
  return "Unclear";
}

function candidateRoleCode(candidate) {
  const ownershipClass = candidate?.triage?.ownership_class;
  if (["target_person", "same_professional_other_practice", "covering_provider"].includes(ownershipClass)) return "doctor_staff";
  if (ownershipClass === "target_practice") return "clinic_contact";
  if (["different_provider", "source_operator", "parent_organization", "third_party", "not_supported_by_evidence"].includes(ownershipClass)) return "not_clinic_owned";
  const label = candidateRoleLabel(candidate);
  return ROLE_OPTIONS.find((option) => option.label === label)?.value || "unclear";
}

function normalizedRoleCode(role) {
  if (role === "covering_provider") return "doctor_staff";
  if (["other_provider", "source_operator"].includes(role)) return "not_clinic_owned";
  return ROLE_OPTIONS.some((option) => option.value === role) ? role : "unclear";
}

function candidateEvidenceCount(candidate) {
  const count = candidate?.evidence_links?.length || 0;
  return count ? `${count} evidence` : "Evidence";
}

function candidateReasonWithoutTriageDuplication(candidate) {
  const triageReason = String(candidate?.triage?.reason || "").trim();
  let reason = String(candidate?.reason || candidate?.evidence || "").trim();
  reason = reason
    .replace(/^Contact was retained for review but not marked usable because its source or surrounding evidence could not be matched to the target registry clinic\.\s*/i, "")
    .replace(/^Triage (?:suppressed|promoted):\s*/i, "")
    .trim();
  if (triageReason && reason.localeCompare(triageReason, undefined, { sensitivity: "base" }) === 0) return "";
  if (triageReason && reason.toLowerCase().endsWith(triageReason.toLowerCase())) {
    reason = reason.slice(0, -triageReason.length).trim().replace(/[.:;,-]+$/, "").trim();
  }
  return reason;
}

function normalizedMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function candidateEvidenceText(candidate) {
  return normalizedMatchText([
    candidate?.owner_name,
    candidate?.reason,
    candidate?.evidence,
    ...(candidate?.evidence_links || []).flatMap((link) => [link.prefix_text, link.exact_quote, link.suffix_text]),
  ].filter(Boolean).join(" "));
}

function candidateMatchesTarget(candidate, clinic) {
  const targetTokens = normalizedMatchText(clinic?.name)
    .replace(/\b(?:dr|haziorvosi|praxis|rendelo|rendeles)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (!targetTokens.length) return false;
  const evidence = candidateEvidenceText(candidate);
  return targetTokens.every((token) => evidence.includes(token));
}

function candidatePresentationGroup(candidate, clinic) {
  const ownershipClass = candidate?.triage?.ownership_class;
  if (
    candidate?.classification === "invalid"
    || candidate?.syntax_status === "invalid"
    || /\.(?:at|biz|co|com|de|eu|hu|info|io|net|org|ro|sk)-(?:ba|ban|be|ben|bol|ert|hez|hoz|nak|nek|ra|re|rol|tol|val|vel)$/i.test(candidate?.value || "")
  ) return "invalid";
  if (
    candidate?.triage?.decision === "suppress"
    || ["different_provider", "source_operator", "parent_organization", "third_party", "not_supported_by_evidence"].includes(ownershipClass)
    || ["third_party", "directory_operator", "legal_imprint_contact", "technical_webmaster", "automated_no_reply"].includes(candidate?.classification)
    || ["directory_operator", "website_operator", "technical_vendor", "parent_organization"].includes(candidate?.owner_type)
    || ["directory_listing", "website_operator", "parent_organization_contact"].includes(candidate?.association_type)
  ) return "other";
  if (
    candidate?.usable_contact
    || candidate?.triage?.decision === "promote"
    || ["direct", "practice_contact_for_person", "clinic_contact"].includes(candidate?.association_type)
    || candidateMatchesTarget(candidate, clinic)
  ) return "primary";
  return "primary";
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
    const roleOverrides = ref([]);
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
    const showOtherCandidates = ref(false);
    const showInvalidCandidates = ref(false);
    const lastExportAt = ref(localStorage.getItem("review.lastExportAt") || "");
    const lastAction = ref(null);
    const sessionStartedAt = ref(Date.now());
    const sessionDecisionCount = ref(0);
    const itemStartedAt = ref(Date.now());
    const evidencePane = ref(null);
    const fullEvidenceText = ref("");
    let evidenceTextRequest = 0;

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
    const candidateGroups = computed(() => {
      const groups = { primary: [], other: [], invalid: [] };
      candidates.value.forEach((candidate, index) => {
        groups[candidatePresentationGroup(candidate, clinic.value?.clinic)].push({ candidate, index });
      });
      return groups;
    });
    const displayedCandidateRows = computed(() => {
      const rows = candidateGroups.value.primary.map((row) => ({ type: "candidate", ...row }));
      if (candidateGroups.value.other.length) {
        rows.push({ type: "toggle", group: "other", count: candidateGroups.value.other.length });
        if (showOtherCandidates.value) rows.push(...candidateGroups.value.other.map((row) => ({ type: "candidate", ...row })));
      }
      if (candidateGroups.value.invalid.length) {
        rows.push({ type: "toggle", group: "invalid", count: candidateGroups.value.invalid.length });
        if (showInvalidCandidates.value) rows.push(...candidateGroups.value.invalid.map((row) => ({ type: "candidate", ...row })));
      }
      return rows;
    });
    const selectedCandidate = computed(() => candidates.value[selectedCandidateIndex.value] || candidates.value[0] || currentItem.value?.best_candidate || null);
    const selectedEvidence = computed(() => selectedCandidate.value?.evidence_links?.[0] || null);
    const selectedDocument = computed(() => (clinic.value?.documents || []).find((document) => document.id === selectedEvidence.value?.source_document_id) || null);
    const currentClinicState = computed(() => clinic.value ? localStateByClinic.value[clinic.value.clinic.id] || clinic.value.state : null);
    const currentClinicDecisions = computed(() => clinic.value ? decisionsByClinic.value[clinic.value.clinic.id] || [] : []);
    const roleOverrideByContact = computed(() => Object.fromEntries(roleOverrides.value.map((item) => [item.contact_point_id, item])));
    const snapshotTitle = computed(() => selectedEvidence.value?.title || selectedEvidence.value?.source_url || selectedCandidate.value?.source_url || "Cached evidence");
    const evidenceBody = computed(() => evidenceHtml(selectedEvidence.value, selectedCandidate.value?.evidence || ""));
    const fullEvidenceBody = computed(() => fullEvidenceText.value
      ? fullEvidenceHtml(fullEvidenceText.value, selectedCandidate.value?.value)
      : evidenceBody.value);

    function artifactUrl(path) {
      if (!path) return null;
      const clean = String(path).replace(/^\/+/, "");
      return `data/${clean}`;
    }

    function focusedHtmlUrl(path, value) {
      const url = artifactUrl(path);
      if (!url) return null;
      return url;
    }

    async function loadFullEvidenceText() {
      const requestId = ++evidenceTextRequest;
      fullEvidenceText.value = "";
      const path = selectedEvidence.value?.review_text_path || selectedDocument.value?.review_text_path;
      const url = artifactUrl(path);
      if (!url) return;
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) return;
        const text = await response.text();
        if (requestId !== evidenceTextRequest) return;
        fullEvidenceText.value = text;
        await nextTick();
        scrollEvidenceToHighlight();
      } catch {
        if (requestId === evidenceTextRequest) fullEvidenceText.value = "";
      }
    }

    function candidateDecision(candidate) {
      return [...currentClinicDecisions.value]
        .filter((decision) => decision.contact_point_id && decision.contact_point_id === candidate?.id)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
    }

    function candidateDecisionLabel(candidate) {
      const decision = candidateDecision(candidate);
      if (!decision) return "";
      return decision.decision === "rejected" ? "Rejected" : "Confirmed";
    }

    function focusArchivedEvidence(event) {
      const frame = event?.target || archiveFrame.value;
      const document = frame?.contentDocument;
      const needle = String(selectedCandidate.value?.value || "").trim().toLowerCase();
      if (!document || !needle) return;
      document.documentElement.style.setProperty("zoom", "1", "important");
      for (const element of document.querySelectorAll("[class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i]")) {
        element.style.setProperty("display", "none", "important");
      }
      document.querySelectorAll("[data-review-spotlight]").forEach((element) => element.remove());
      let target = null;
      let matchedRange = null;
      if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const value = String(node.nodeValue || "");
          const start = value.toLowerCase().indexOf(needle);
          if (start < 0) continue;
          target = node.parentElement;
          matchedRange = document.createRange();
          matchedRange.setStart(node, start);
          matchedRange.setEnd(node, start + needle.length);
          break;
        }
      }
      if (!target) {
        target = [...document.querySelectorAll("a")].find((element) =>
          `${element.textContent || ""} ${element.getAttribute("data-review-original-href") || ""}`.toLowerCase().includes(needle)
        );
      }
      if (!target) {
        target = [...document.querySelectorAll("*")].find((element) =>
          [...element.attributes].some((attribute) => String(attribute.value || "").toLowerCase().includes(needle))
        );
      }
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const sourceRect = matchedRange?.getBoundingClientRect() || target.getBoundingClientRect();
        const padding = 6;
        const pageX = document.defaultView?.scrollX || document.documentElement.scrollLeft || 0;
        const pageY = document.defaultView?.scrollY || document.documentElement.scrollTop || 0;
        const left = Math.max(pageX + 8, sourceRect.left + pageX - padding);
        const top = Math.max(pageY + 8, sourceRect.top + pageY - padding);
        const width = Math.max(20, sourceRect.width + (padding * 2));
        const height = Math.max(20, sourceRect.height + (padding * 2));
        const highlight = document.createElement("div");
        highlight.setAttribute("data-review-spotlight", "true");
        highlight.style.cssText = `position:absolute!important;left:${left}px!important;top:${top}px!important;width:${width}px!important;height:${height}px!important;z-index:2147483646!important;pointer-events:none!important;border:3px solid #ff2d7d!important;border-radius:5px!important;box-shadow:0 2px 10px rgba(255,45,125,.35)!important;background:rgba(255,243,109,.28)!important;box-sizing:border-box!important;`;
        document.body.append(highlight);
      }));
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
      roleOverrides.value = (await getAll(db.value, "meta"))
        .filter((item) => String(item.key || "").startsWith("role_override:"))
        .map((item) => item.value);
    }

    function displayedCandidateRole(candidate) {
      return normalizedRoleCode(roleOverrideByContact.value[candidate?.id]?.role || candidateRoleCode(candidate));
    }

    async function updateCandidateRole(candidate, role) {
      if (!candidate?.id || !clinic.value?.clinic?.id || !ROLE_OPTIONS.some((option) => option.value === role)) return;
      const override = {
        clinic_id: clinic.value.clinic.id,
        contact_point_id: candidate.id,
        role,
        original_role: normalizedRoleCode(candidate.contact_role || candidateRoleCode(candidate)),
        reviewer_id: reviewer.value || "reviewer",
        updated_at: nowIso(),
      };
      await put(db.value, "meta", { key: `role_override:${candidate.id}`, value: override });
      roleOverrides.value = [
        ...roleOverrides.value.filter((item) => item.contact_point_id !== candidate.id),
        override,
      ];
      await put(db.value, "audit_events", {
        id: uuid(),
        event: "role_override",
        clinic_id: override.clinic_id,
        contact_point_id: override.contact_point_id,
        role,
        reviewer_id: override.reviewer_id,
        created_at: override.updated_at,
      });
      saveStatus.value = `Role updated · ${ROLE_OPTIONS.find((option) => option.value === role)?.label || role}`;
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
      showOtherCandidates.value = candidateGroups.value.primary.length === 0;
      showInvalidCandidates.value = false;
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
      nextTick(() => {
        scrollEvidenceToHighlight();
        focusArchivedEvidence({ target: archiveFrame.value });
      });
    }

    function previewCandidate(index) {
      if (pendingReject.value) return;
      if (index === selectedCandidateIndex.value) return;
      selectCandidate(index);
    }

    function rejectCandidate(index) {
      selectCandidate(index);
      pendingReject.value = true;
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
      const allCandidatesRejected = decisionType === "rejected" && candidates.value.every((item) =>
        item.id === candidate?.id || candidateDecision(item)?.decision === "rejected"
      );
      const status = allCandidatesRejected
        ? "no_email"
        : decisionType === "rejected"
          ? "needs_review"
          : decisionType === "no_email"
            ? "no_email"
            : "confirmed";
      await persistDecisionAndState(decision, status, decision?.is_primary ? decision.id : null, reasonCode, previousState);
      pendingReject.value = false;
      editMode.value = false;
      sessionDecisionCount.value += 1;
      saveStatus.value = `${stateLabel(status)} · press U to undo`;
      if (decisionType === "rejected") {
        const decidedIds = new Set(currentClinicDecisions.value.map((item) => item.contact_point_id));
        decidedIds.add(candidate?.id);
        const remainingIndices = candidates.value
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => !decidedIds.has(item.id))
          .map(({ index }) => index);
        const nextIndex = remainingIndices.find((index) => index > selectedCandidateIndex.value)
          ?? remainingIndices[0]
          ?? -1;
        if (nextIndex >= 0) selectCandidate(nextIndex);
        else if (status === "no_email") await setIndex(currentIndex.value);
      } else {
        await setIndex(currentIndex.value);
      }
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
        role_overrides: roleOverrides.value,
        audit_events: await getAll(db.value, "audit_events"),
      };
      payload.checksum = await sha256(JSON.stringify({
        decisions: payload.decisions,
        clinic_states: payload.clinic_states,
        role_overrides: payload.role_overrides,
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
        role_overrides: roleOverrides.value,
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
      for (const override of payload.role_overrides || []) {
        const key = `role_override:${override.contact_point_id}`;
        const existing = await get(db.value, "meta", key);
        if (!existing || String(existing.value?.updated_at || "") <= String(override.updated_at || "")) {
          await put(db.value, "meta", { key, value: override });
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
      if (payload.role_overrides != null && !Array.isArray(payload.role_overrides)) throw new Error("Invalid role overrides.");
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
    watch(
      () => [selectedEvidence.value?.review_text_path, selectedEvidence.value?.source_document_id, selectedCandidate.value?.value],
      () => loadFullEvidenceText(),
    );

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
      fullEvidenceBody,
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
      ROLE_OPTIONS,
      candidateGroups,
      displayedCandidateRows,
      showOtherCandidates,
      showInvalidCandidates,
      safeText,
      candidateRoleLabel,
      candidateEvidenceCount,
      candidateReasonWithoutTriageDuplication,
      displayedCandidateRole,
      updateCandidateRole,
      candidateDecision,
      candidateDecisionLabel,
      artifactUrl,
      focusedHtmlUrl,
      focusArchivedEvidence,
      stateLabel,
      visibleBackupReminder,
      selectCandidate,
      previewCandidate,
      rejectCandidate,
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
          <span class="queue-summary">{{ manifest?.counts?.clinics || 0 }} clinics · {{ manifest?.counts?.candidate_emails || 0 }} candidate emails</span>
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
            <p v-if="candidateGroups.other.length || candidateGroups.invalid.length" class="candidate-group-note">
              Showing {{ candidateGroups.primary.length }} likely relevant candidate{{ candidateGroups.primary.length === 1 ? '' : 's' }}.
              {{ candidateGroups.other.length }} other page contact{{ candidateGroups.other.length === 1 ? '' : 's' }} and
              {{ candidateGroups.invalid.length }} extraction artifact{{ candidateGroups.invalid.length === 1 ? '' : 's' }} are collapsed.
            </p>
            <div v-if="candidates.length" class="candidate-table-wrap">
              <table class="candidate-table">
                <thead><tr><th></th><th>Email</th><th>Role guess</th><th>Decision</th></tr></thead>
                <tbody>
                  <tr v-for="row in displayedCandidateRows" :key="row.type === 'candidate' ? (row.candidate.id || row.index) : row.group" :class="row.type === 'candidate' ? {selected:row.index===selectedCandidateIndex, decided: candidateDecision(row.candidate)} : 'candidate-group-toggle'" @mouseenter="row.type === 'candidate' && previewCandidate(row.index)" @click="row.type === 'candidate' && selectCandidate(row.index)">
                    <template v-if="row.type === 'candidate'">
                      <td class="candidate-radio">{{ row.index === selectedCandidateIndex ? '●' : '○' }}</td>
                      <td><span class="candidate-email">{{ row.candidate.value }}</span><small>{{ candidateEvidenceCount(row.candidate) }}</small><small v-if="candidateDecision(row.candidate)" class="candidate-decision-label">{{ candidateDecisionLabel(row.candidate) }}</small></td>
                      <td>
                        <select class="candidate-role-select" :value="displayedCandidateRole(row.candidate)" @click.stop @change.stop="updateCandidateRole(row.candidate, $event.target.value)">
                          <option v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                        </select>
                      </td>
                      <td class="candidate-actions">
                        <button class="candidate-confirm" @click.stop="selectCandidate(row.index); saveDecision('confirmed')">Confirm</button>
                        <button class="candidate-reject" @click.stop="rejectCandidate(row.index)">Reject</button>
                      </td>
                    </template>
                    <td v-else colspan="4">
                      <button v-if="row.group === 'other'" @click.stop="showOtherCandidates = !showOtherCandidates">{{ showOtherCandidates ? 'Hide' : 'Show' }} {{ row.count }} other contact{{ row.count === 1 ? '' : 's' }} from this shared source</button>
                      <button v-else @click.stop="showInvalidCandidates = !showInvalidCandidates">{{ showInvalidCandidates ? 'Hide' : 'Show' }} {{ row.count }} invalid extraction artifact{{ row.count === 1 ? '' : 's' }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="muted">No email candidate packaged for this clinic.</p>
            <p v-if="candidateReasonWithoutTriageDuplication(selectedCandidate)" class="candidate-reason">{{ candidateReasonWithoutTriageDuplication(selectedCandidate) }}</p>
            <div v-if="selectedCandidate?.triage" class="triage-summary" :class="'triage-' + selectedCandidate.triage.decision">
              <div class="triage-heading">
                <span class="pill">Machine triage: {{ selectedCandidate.triage.decision }}</span>
                <strong>{{ selectedCandidate.triage.ownership_class }} · {{ Math.round(Number(selectedCandidate.triage.confidence || 0) * 100) }}%</strong>
              </div>
              <p>{{ selectedCandidate.triage.reason }}</p>
            </div>
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
            <button class="secondary" @click="markNoPublicEmail"><kbd>3</kbd> No public email</button>
            <button class="quiet" @click="editMode=!editMode">Edit</button>
            <button class="quiet" @click="excludeCurrent">Exclude</button>
            <button class="quiet" @click="undoLastAction"><kbd>U</kbd> Undo</button>
          </div>

          <p class="shortcut-line">J/K alternate · ←/→ lead · decisions auto-advance</p>
        </section>

        <section class="evidence-pane">
          <div class="evidence-toolbar">
            <a v-if="selectedEvidence?.open_url || selectedCandidate?.source_url" :href="selectedEvidence?.open_url || selectedCandidate?.source_url" target="_blank" rel="noreferrer">Open live page ↗</a>
          </div>

          <div v-if="selectedEvidence?.raw_html_path" class="archive-pane">
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

          <div v-else ref="evidencePane" class="snapshot-pane">
            <pre class="snapshot-text" v-html="fullEvidenceBody"></pre>
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

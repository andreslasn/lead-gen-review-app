import { createApp, computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import "./styles.css";

const DB_NAME = "lead-gen-clinic-review";
const DB_VERSION = 2;
const REVIEW_FORMAT = "lead-gen-clinic-review";
const SCHEMA_VERSION = 1;
const PACKAGE_FORMAT = "lead-gen-review-package";
const PACKAGE_SCHEMA_VERSION = 1;
const STATES = ["needs_review", "confirmed", "no_email", "not_processed", "excluded"];
const DEFAULT_ROLE_OPTIONS = [
  { value: "clinic_contact", label: "Generic contact" },
  { value: "doctor_staff", label: "Doctor/staff" },
];
const DEFAULT_ROLE_ALIASES = {
  covering_provider: "doctor_staff",
  prescription_refill: "clinic_contact",
  not_clinic_owned: "not_relevant",
  unclear: "not_relevant",
  other_provider: "not_relevant",
  source_operator: "not_relevant",
};
const PREFETCH_COUNT = 3;
const REVIEW_SYNC_CONFIG = "review-sync.json";
const EMAIL_INDEX_PATH = "data/email-index.json";
const EMAIL_REVIEW_QUEUE_PATH = "data/email-review-queue.json";
const EMAIL_VALIDATION_SEED_PATH = "data/email-validation-seed.json";
const CAMPAIGN_EMAIL_USAGE_PATH = "data/campaign-email-usage.json";
const EMAIL_STATUSES = ["unreviewed", "valid", "invalid"];
const DATA_DEPLOY_VERSION = "email-global-20260812-campaign-2";
const DB_OPEN_TIMEOUT_MS = 2500;
const HIDDEN_REVIEW_UI_TEXT = [
  "Accepted by an external human reviewer in a validated workbook column.",
  "The surrounding context explicitly associates this mailbox with a named professional. Prepared for cohort ownership triage. The evidence directly lists the target doctor's name and the candidate email together in the 19th adult GP district entry",
];

function openDb({ timeoutMs = DB_OPEN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("Browser storage is unavailable. The packaged queue can be viewed, but review actions need browser storage."));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("Browser storage unavailable."));
    }, timeoutMs);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("decisions")) db.createObjectStore("decisions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("clinic_states")) db.createObjectStore("clinic_states", { keyPath: "clinic_id" });
      if (!db.objectStoreNames.contains("audit_events")) db.createObjectStore("audit_events", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "id" });
      if (!db.objectStoreNames.contains("email_validations")) db.createObjectStore("email_validations", { keyPath: "email" });
    };
    request.onblocked = () => {
      finish(reject, new Error("Browser storage unavailable."));
    };
    request.onerror = () => finish(reject, request.error);
    request.onsuccess = () => finish(resolve, request.result);
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

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function safeReviewPathPart(value) {
  return String(value || "reviewer")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "reviewer";
}

function staticUrl(path) {
  const separator = String(path).includes("?") ? "&" : "?";
  return `${path}${separator}v=${encodeURIComponent(DATA_DEPLOY_VERSION)}`;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeText(value) {
  return value == null || value === "" ? "—" : String(value);
}

function normalizeEmailValue(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].toLowerCase() : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function routeEmailValue() {
  return (window.location.hash || "").match(/^#\/emails\/([^/?]+)/)?.[1] || null;
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
    confirmed: "Accepted",
    no_email: "No public email",
    not_processed: "Not processed",
    excluded: "Not accepted",
  }[value] || value || "Needs review";
}

function laneLabel(value) {
  return {
    unreviewed: "Unreviewed",
    reviewed: "Reviewed",
    valid: "Valid",
    invalid: "Invalid",
    accepted: "Accepted",
    shared_email_review: "Shared email",
    weak_join_review: "Weak join",
    not_accepted: "Not accepted",
    needs_review: "Needs review",
    no_matched_email: "No matched email",
    no_public_email: "No public email",
    all: "All",
  }[value] || value;
}

function reasonLabel(value) {
  return {
    accepted_registry_id: "Registry-ID accepted",
    accepted_no_proof: "Registry-ID accepted, proof missing",
    review_shared_email: "Shared email needs review",
    review_weak_join: "Weak clinic/email join",
    external_reviewer_validated: "Reviewer validated",
  }[value] || value || "";
}

function confidencePool(item, lane) {
  if (item.status === "confirmed") return "accepted";
  if (item.status === "excluded") return "not_accepted";
  if (item.review_reason_code === "review_shared_email") return "shared_email_review";
  if (item.review_reason_code === "review_weak_join") return "weak_join_review";
  if (lane !== "no_email") return "needs_review";
  return item.status === "no_email" ? "no_public_email" : "no_matched_email";
}

function normalizedLaneSelection(value) {
  if (["unreviewed", "reviewed", "valid", "invalid"].includes(value)) return value;
  if (["accepted", "confirmed", "not_accepted", "excluded"].includes(value)) return "reviewed";
  if (value === "all") return value;
  return "unreviewed";
}

function matchesLaneStatus(item, lane) {
  if (lane === "all") return true;
  if (lane === "reviewed") return item.status !== "unreviewed";
  return item.status === lane;
}

function emailStatusLabel(value) {
  return {
    unreviewed: "Unreviewed",
    valid: "Valid",
    invalid: "Invalid",
  }[value] || "Unreviewed";
}

function normalizedEmailStatus(value) {
  return EMAIL_STATUSES.includes(value) ? value : "unreviewed";
}

function normalizedCampaignUsageFilter(value) {
  return ["all", "unused", "used"].includes(value) ? value : "all";
}

function campaignUsageFilterLabel(value) {
  return {
    unused: "Unused",
    used: "Used",
  }[value] || "";
}

function campaignUsageLabel(item) {
  if (item?.used_in_campaign) return "Used in campaign";
  return "Unused in campaign";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function csvRows(rows, columns) {
  return [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(",")),
  ].join("\n");
}

function itemRegions(item) {
  const regions = Array.isArray(item?.regions) && item.regions.length
    ? item.regions
    : [
      item?.region,
      ...(item?.occurrences || []).map((occurrence) => occurrence.region),
    ];
  return [...new Set(regions.map((region) => String(region || "").trim()).filter(Boolean))];
}

function itemMatchesRegion(item, region) {
  return !region || itemRegions(item).includes(region);
}

function mergedEmailValidationList(...lists) {
  const byEmail = new Map();
  for (const list of lists) {
    for (const validation of list || []) {
      const email = normalizeEmailValue(validation?.email || validation?.display_value);
      if (!email || !email.includes("@")) continue;
      const normalized = {
        ...validation,
        email,
        display_value: validation.display_value || email,
        status: normalizedEmailStatus(validation.status),
      };
      const existing = byEmail.get(email);
      const existingTime = String(existing?.updated_at || existing?.reviewed_at || "");
      const normalizedTime = String(normalized.updated_at || normalized.reviewed_at || "");
      if (!existing || existingTime <= normalizedTime) byEmail.set(email, normalized);
    }
  }
  return [...byEmail.values()];
}

function normalizedNoMatchedEvidenceFilter(value) {
  if (["html", "none"].includes(value)) return value;
  return value === "no_html" ? "none" : "html";
}

function candidateLane(item) {
  const candidate = item.best_candidate || {};
  const confidence = Number(candidate.confidence || 0);
  const triage = candidate.triage || {};
  const triageConfidence = Number(triage.confidence || 0);
  const targetOwnership = ["target_person", "target_practice", "same_professional_other_practice", "covering_provider"].includes(triage.ownership_class);
  const nonTargetOwnership = ["different_provider", "source_operator", "parent_organization", "third_party", "not_supported_by_evidence"].includes(triage.ownership_class);
  const sourceRole = item.source_coverage_status || "";
  const sourceHost = normalizeHost(candidate.source_url || item.website || "");
  const itemHost = normalizeHost(item.website || "");
  const sameDomain = Boolean(sourceHost && itemHost && sourceHost === itemHost);

  if (!candidate.value) return "no_email";
  if (triage.decision === "suppress" || (nonTargetOwnership && triageConfidence >= 0.9)) return "auto_suppress";
  if (
    candidate.usable_contact
    && confidence >= 0.9
    && ["verified_official", "official", "official_verified"].includes(sourceRole)
    && (sameDomain || candidate.verification_status === "corroborated" || candidate.association_type === "clinic_contact")
  ) {
    return "auto_confirm";
  }
  if (targetOwnership && triageConfidence >= 0.9) return "review";
  if (!candidate.usable_contact && confidence < 0.4) return "auto_suppress";
  if (["third_party", "directory_operator", "webmaster"].includes(candidate.classification)) return "auto_suppress";
  return "review";
}

function lanePriority(lane) {
  return { review: 4, auto_confirm: 3, auto_suppress: 2, no_email: 1 }[lane] || 0;
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
  if (!link) return escapeHtml(sanitizeTriageUiText(fallback) || "No compact evidence was packaged for this candidate.");
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

function evidencePresentation(link, document) {
  const rawHtmlPath = link?.raw_html_path || document?.raw_html_path;
  const screenshotPath = link?.screenshot_path || document?.screenshot_path;
  const reviewTextPath = link?.review_text_path || document?.review_text_path;
  if (rawHtmlPath) {
    return {
      kind: "html",
      label: "Archived HTML",
      detail: "Sanitized capture of the original webpage.",
      path: rawHtmlPath,
    };
  }
  if (screenshotPath) {
    return {
      kind: "screenshot",
      label: "Screenshot fallback",
      detail: "No archived HTML was available. This is a compressed screenshot of the captured page.",
      path: screenshotPath,
    };
  }
  if (reviewTextPath) {
    return {
      kind: "text",
      label: "Text-only fallback",
      detail: "This is extracted page text, not the original webpage layout or HTML.",
      path: reviewTextPath,
    };
  }
  return {
    kind: "excerpt",
    label: "Evidence excerpt fallback",
    detail: "No archived HTML or screenshot was available. This is retained extraction context only.",
    path: null,
  };
}

function candidateRoleLabel(candidate, reviewPolicy = {}) {
  const text = [
    candidate?.value,
    candidate?.reason,
    candidate?.evidence,
    candidate?.contact_role,
    candidate?.owner_name,
  ].join(" ").toLowerCase();
  const classification = String(candidate?.classification || "").toLowerCase();
  const contactRole = String(candidate?.contact_role || "").toLowerCase();
  const genericTerms = reviewPolicy.generic_contact_terms || ["prescription", "refill", "repeat", "rx"];
  const staffTerms = reviewPolicy.staff_contact_terms || ["doctor", "physician", "staff"];
  if (genericTerms.some((term) => term && text.includes(String(term).toLowerCase())) || contactRole.includes("prescription")) return "Generic contact";
  if (staffTerms.some((term) => term && text.includes(String(term).toLowerCase())) || classification.includes("staff") || classification.includes("doctor") || contactRole.includes("doctor") || /^dr[._-]/i.test(candidate?.value || "")) return "Doctor/staff";
  if (classification.includes("clinic") || contactRole.includes("clinic")) return "Generic contact";
  if (classification.includes("generic")) return "Generic contact";
  return "Generic contact";
}

function candidateRoleCode(candidate, roleOptions = DEFAULT_ROLE_OPTIONS, reviewPolicy = {}) {
  const ownershipClass = candidate?.triage?.ownership_class;
  if (["target_person", "same_professional_other_practice", "covering_provider"].includes(ownershipClass)) return "doctor_staff";
  if (ownershipClass === "target_practice") return "clinic_contact";
  if (["different_provider", "source_operator", "parent_organization", "third_party", "not_supported_by_evidence"].includes(ownershipClass)) return "clinic_contact";
  const label = candidateRoleLabel(candidate, reviewPolicy);
  return roleOptions.find((option) => option.label === label)?.value || "clinic_contact";
}

function normalizedRoleCode(
  role,
  roleOptions = DEFAULT_ROLE_OPTIONS,
  aliases = DEFAULT_ROLE_ALIASES,
) {
  const normalized = aliases[role] || role;
  return roleOptions.some((option) => option.value === normalized) ? normalized : "clinic_contact";
}

function sanitizeTriageUiText(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/\bTriage\s+llm-[^.!?\n]*(?:[.!?]\s*)?/gi, " ")
    .replace(/\bMachine triage:\s*[^.!?\n]*(?:[.!?]\s*)?/gi, " ")
    .replace(/\bTriage\s+(?:suppressed|promoted|retained)[^.!?\n]*(?:[.!?]\s*)?/gi, " ")
    .replace(/\bLLM classification retained[^.!?\n]*(?:[.!?]\s*)?/gi, " ")
    .replace(/\b(?:different_provider|parent_organization|source_operator|third_party|not_supported_by_evidence)\s*[·:,-]?\s*\d{1,3}%?/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.:;,\s-]+|[.:;,\s-]+$/g, "")
    .trim();
  if (/^(different_provider|parent_organization|source_operator|third_party|not_supported_by_evidence)(?:\s*\([\d.]+\))?$/i.test(text)) return "";
  return text;
}

function visibleAuditFlags(flags = []) {
  return flags.filter((flag) => !HIDDEN_REVIEW_UI_TEXT.some((text) => String(flag || "").localeCompare(text, undefined, { sensitivity: "base" }) === 0));
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

function candidateMatchesTarget(candidate, clinic, reviewPolicy = {}) {
  const stopwords = new Set(
    (reviewPolicy.target_name_stopwords || ["dr", "clinic", "practice", "medical", "health", "center", "centre"])
      .map((item) => normalizedMatchText(item)),
  );
  const targetTokens = normalizedMatchText(clinic?.name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopwords.has(token));
  if (!targetTokens.length) return false;
  const evidence = candidateEvidenceText(candidate);
  return targetTokens.every((token) => evidence.includes(token));
}

function candidatePresentationGroup(candidate, clinic, reviewPolicy = {}) {
  const ownershipClass = candidate?.triage?.ownership_class;
  const artifactSuffixes = reviewPolicy.email_artifact_suffixes || [];
  const email = String(candidate?.value || "").toLowerCase();
  if (
    candidate?.classification === "invalid"
    || candidate?.syntax_status === "invalid"
    || artifactSuffixes.some((suffix) => email.endsWith(`-${String(suffix).toLowerCase()}`))
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
    || candidateMatchesTarget(candidate, clinic, reviewPolicy)
  ) return "primary";
  return "primary";
}

const App = {
  setup() {
    const db = ref(null);
    const manifest = ref(null);
    const queue = ref([]);
    const emailIndex = ref([]);
    const staticEmailValidations = ref([]);
    const campaignEmailUsage = ref([]);
    const clinicIndex = ref([]);
    const clinic = ref(null);
    const clinicCache = ref({});
    const decisions = ref([]);
    const localStates = ref([]);
    const emailValidations = ref([]);
    const roleOverrides = ref([]);
    const reviewer = ref(localStorage.getItem("review.reviewer") || "reviewer");
    const search = ref(localStorage.getItem("review.filter.search") || "");
    const selectedRegion = ref(localStorage.getItem("review.filter.region") || "");
    const selectedLane = ref(normalizedLaneSelection(localStorage.getItem("review.filter.lane")));
    const campaignUsageFilter = ref(normalizedCampaignUsageFilter(localStorage.getItem("review.filter.campaignUsage")));
    const noMatchedEvidenceFilter = ref(normalizedNoMatchedEvidenceFilter(localStorage.getItem("review.filter.noMatchedEvidence")));
    const currentIndex = ref(0);
    const selectedCandidateIndex = ref(0);
    const pendingEmailStatus = ref("");
    const evidenceTab = ref("snapshot");
    const archiveFrame = ref(null);
    const saveStatus = ref("Loading");
    const loading = ref(true);
    const error = ref("");
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
    const syncConfig = ref(null);
    const syncPanelOpen = ref(false);
    const githubToken = ref(sessionStorage.getItem("review.githubToken") || "");
    const syncStatus = ref("Local only");
    const remoteReviewSha = ref(null);
    const remoteReviewLoaded = ref(false);
    let evidenceTextRequest = 0;
    let syncTimer = null;
    let dbOpenPromise = null;

    const localStateByClinic = computed(() => Object.fromEntries(localStates.value.map((item) => [item.clinic_id, item])));
    const emailValidationByValue = computed(() => Object.fromEntries(
      mergedEmailValidationList(staticEmailValidations.value, emailValidations.value).map((item) => [item.email, item]),
    ));
    const campaignUsageByEmail = computed(() => Object.fromEntries(
      campaignEmailUsage.value.map((item) => [normalizeEmailValue(item.email), item]).filter(([email]) => email),
    ));
    const decisionsByClinic = computed(() => {
      const grouped = {};
      for (const decision of decisions.value) (grouped[decision.clinic_id] ||= []).push(decision);
      return grouped;
    });
    const preparedQueue = computed(() => emailIndex.value.map((item) => {
      const validation = emailValidationByValue.value[item.email] || null;
      const campaignUsage = campaignUsageByEmail.value[item.email] || null;
      const status = normalizedEmailStatus(validation?.status);
      return {
        ...item,
        id: item.email,
        lane: status,
        status,
        confidence_pool: status,
        used_in_campaign: Boolean(campaignUsage),
        campaign_usage: campaignUsage,
        reviewed_at: validation?.reviewed_at || null,
        reviewer_id: validation?.reviewed_by || null,
        audit_flags: visibleAuditFlags(validation?.audit_flags || []),
      };
    }));
    const regionOptions = computed(() => [...new Set(
      preparedQueue.value.flatMap((item) => itemRegions(item)),
    )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    const regionFilterLabel = computed(() => manifest.value?.review_ui?.region_filter_label || "All regions");
    const roleOptions = computed(() => {
      const configured = manifest.value?.review_ui?.contact_types;
      const options = Array.isArray(configured) && configured.length ? configured : DEFAULT_ROLE_OPTIONS;
      return options
        .filter((option) => ["clinic_contact", "doctor_staff"].includes(option.value))
        .map((option) => ({
          ...option,
          label: option.value === "clinic_contact" ? "Generic" : "Doctor/staff",
        }));
    });
    const roleAliases = computed(() => ({
      ...DEFAULT_ROLE_ALIASES,
      ...(manifest.value?.review_ui?.contact_type_aliases || {}),
    }));
    const reviewPolicy = computed(() => manifest.value?.review_policy || {});
    const locationFilteredQueue = computed(() => preparedQueue.value.filter((item) => itemMatchesRegion(item, selectedRegion.value)));
    const isUnusedValidCampaignEmail = (item) => item.status === "valid" && !item.used_in_campaign;
    const campaignUsageFilteredQueue = computed(() => locationFilteredQueue.value.filter((item) => {
      if (campaignUsageFilter.value === "used") return item.used_in_campaign;
      if (campaignUsageFilter.value === "unused") return isUnusedValidCampaignEmail(item);
      return true;
    }));
    const filteredQueue = computed(() => {
      const needle = search.value.trim().toLowerCase();
      return campaignUsageFilteredQueue.value
        .filter((item) => matchesLaneStatus(item, selectedLane.value))
        .filter((item) => {
          if (!needle) return true;
          return [
            item.email,
            item.display_value,
            item.name,
            item.registry_id,
            item.city,
            item.region,
            item.address,
            item.source_url,
            ...(item.campaign_usage?.source_files || []),
          ].some((value) => String(value || "").toLowerCase().includes(needle));
        })
        .sort((a, b) => (
          Number(a.status !== "unreviewed") - Number(b.status !== "unreviewed")
          || b.occurrence_count - a.occurrence_count
          || a.email.localeCompare(b.email)
        ));
    });
    const laneCounts = computed(() => {
      const counts = {
        unreviewed: 0,
        reviewed: 0,
        valid: 0,
        invalid: 0,
        all: locationFilteredQueue.value.length,
      };
      for (const item of locationFilteredQueue.value) {
        counts[item.status] = (counts[item.status] || 0) + 1;
        if (item.status !== "unreviewed") counts.reviewed += 1;
      }
      return counts;
    });
    const campaignUsageCounts = computed(() => {
      const counts = { all: locationFilteredQueue.value.length, unused: 0, used: 0 };
      for (const item of locationFilteredQueue.value) {
        if (item.used_in_campaign) counts.used += 1;
        else if (isUnusedValidCampaignEmail(item)) counts.unused += 1;
      }
      return counts;
    });
    const unusedValidExportCount = computed(() => unusedValidEmailRows(selectedRegion.value).length);
    const unusedExportTitle = computed(() => {
      const region = selectedRegion.value || "all counties";
      return `Export ${unusedValidExportCount.value} unused valid emails for ${region}`;
    });
    const noMatchedEvidenceCounts = computed(() => {
      return { html: 0, none: 0 };
    });
    const currentItem = computed(() => filteredQueue.value[currentIndex.value] || null);
    const isNoMatchArchivedHtml = computed(() => (
      currentItem.value?.confidence_pool === "no_matched_email"
      && currentItem.value?.evidence_availability === "html"
    ));
    const candidates = computed(() => {
      const raw = clinic.value?.candidates || [];
      const validEmails = raw.filter((candidate) => String(candidate?.value || "").includes("@"));
      const source = validEmails.length ? validEmails : raw;
      const grouped = new Map();
      for (const candidate of source) {
        const key = String(candidate?.value || "").trim().toLowerCase();
        if (!key) continue;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(candidate);
      }
      return [...grouped.values()].map((duplicates) => {
        const preferred = [...duplicates].sort((a, b) => {
          const aDecision = candidateDecision(a);
          const bDecision = candidateDecision(b);
          const aScore = Number(["confirmed", "edited_confirmed"].includes(aDecision?.decision)) * 16
            + Number(a.classification === "reviewer_validated") * 8
            + Number(Boolean(a.usable_contact)) * 4
            + Number(a.verification_status === "reviewer_confirmed") * 2
            + Number(a.evidence_links?.length || 0);
          const bScore = Number(["confirmed", "edited_confirmed"].includes(bDecision?.decision)) * 16
            + Number(b.classification === "reviewer_validated") * 8
            + Number(Boolean(b.usable_contact)) * 4
            + Number(b.verification_status === "reviewer_confirmed") * 2
            + Number(b.evidence_links?.length || 0);
          return bScore - aScore || Number(b.confidence || 0) - Number(a.confidence || 0);
        })[0];
        const evidenceByKey = new Map();
        for (const candidate of duplicates) {
          for (const link of candidate.evidence_links || []) {
            const evidenceKey = link.id || [link.source_url, link.exact_quote, link.raw_html_path, link.screenshot_path].join("|");
            if (!evidenceByKey.has(evidenceKey)) evidenceByKey.set(evidenceKey, link);
          }
        }
        return {
          ...preferred,
          evidence_links: [...evidenceByKey.values()],
          duplicate_contact_ids: duplicates.map((candidate) => candidate.id).filter(Boolean),
        };
      });
    });
    const candidateGroups = computed(() => {
      const groups = { primary: [], other: [], invalid: [] };
      candidates.value.forEach((candidate, index) => {
        groups[candidatePresentationGroup(candidate, clinic.value?.clinic, reviewPolicy.value)].push({ candidate, index });
      });
      return groups;
    });
    const displayedCandidateRows = computed(() => {
      if (currentItem.value?.email) {
        const email = currentItem.value.email;
        const occurrenceIds = new Set(
          (currentItem.value.occurrences || [])
            .filter((occurrence) => occurrence.clinic_id === clinic.value?.clinic?.id)
            .map((occurrence) => occurrence.contact_point_id)
            .filter(Boolean),
        );
        return candidates.value
          .map((candidate, index) => ({ type: "candidate", candidate, index }))
          .filter(({ candidate }) => (
            occurrenceIds.has(candidate.id)
            || normalizeEmailValue(candidate.value) === email
          ));
      }
      if (isNoMatchArchivedHtml.value) {
        const documents = clinic.value?.documents || [];
        const archivedDocumentIds = new Set(
          documents.filter((document) => document.raw_html_path).map((document) => document.id),
        );
        return candidates.value
          .map((candidate, index) => ({ type: "candidate", candidate, index }))
          .filter(({ candidate }) => (
            candidatePresentationGroup(candidate, clinic.value?.clinic) !== "invalid"
            && (candidate.evidence_links || []).some((link) => (
              Boolean(link.raw_html_path)
              || archivedDocumentIds.has(link.source_document_id)
            ))
          ));
      }
      return candidateGroups.value.primary.map((row) => ({ type: "candidate", ...row }));
    });
    const currentEmailValidation = computed(() => currentItem.value?.email
      ? emailValidationByValue.value[currentItem.value.email] || null
      : null);
    const currentEmailStatus = computed(() => normalizedEmailStatus(currentEmailValidation.value?.status));
    const pendingValidationReady = computed(() => ["valid", "invalid"].includes(pendingEmailStatus.value));
    const currentEmailOccurrences = computed(() => {
      const occurrences = currentItem.value?.occurrences || [];
      if (!selectedRegion.value) return occurrences;
      return [...occurrences].sort((a, b) => (
        Number(b.region === selectedRegion.value) - Number(a.region === selectedRegion.value)
        || String(a.clinic_name || "").localeCompare(String(b.clinic_name || ""), undefined, { sensitivity: "base" })
      ));
    });
    const selectedCandidate = computed(() => {
      const selected = candidates.value[selectedCandidateIndex.value];
      if (
        isNoMatchArchivedHtml.value
        && selected
        && displayedCandidateRows.value.some((row) => row.index === selectedCandidateIndex.value)
      ) return selected;
      if (selected && candidatePresentationGroup(selected, clinic.value?.clinic) === "primary") return selected;
      return displayedCandidateRows.value[0]?.candidate || null;
    });
    const selectedEvidence = computed(() => {
      const links = selectedCandidate.value?.evidence_links || [];
      const archivedDocumentIds = new Set(
        (clinic.value?.documents || [])
          .filter((document) => document.raw_html_path)
          .map((document) => document.id),
      );
      return links.find((link) => link.raw_html_path)
        || links.find((link) => archivedDocumentIds.has(link.source_document_id))
        || links[0]
        || null;
    });
    const selectedDocument = computed(() => {
      const documents = clinic.value?.documents || [];
      const sourceUrl = selectedEvidence.value?.source_url || selectedCandidate.value?.source_url || "";
      const sourceDocument = documents.find((document) => (
        document.id === selectedEvidence.value?.source_document_id
      ));
      if (sourceDocument) return sourceDocument;
      if (sourceUrl) {
        const normalizedSource = sourceUrl.split("#", 1)[0].replace(/\/$/, "");
        const matchedSource = documents.find((document) => [document.source_url, document.final_url]
          .filter(Boolean)
          .some((value) => value.split("#", 1)[0].replace(/\/$/, "") === normalizedSource));
        if (matchedSource) return matchedSource;
      }
      if (isNoMatchArchivedHtml.value) {
        return documents.find((document) => document.raw_html_path)
          || documents.find((document) => document.screenshot_path || document.review_text_path)
          || null;
      }
      return null;
    });
    const selectedEvidencePresentation = computed(() => evidencePresentation(selectedEvidence.value, selectedDocument.value));
    const livePageUrl = computed(() => (
      selectedEvidence.value?.open_url
      || selectedCandidate.value?.source_url
      || selectedDocument.value?.final_url
      || selectedDocument.value?.source_url
      || null
    ));
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
      return staticUrl(`data/${clean}`);
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
      const validation = emailValidationByValue.value[normalizeEmailValue(candidate?.value)];
      if (validation?.status === "valid") return { ...validation, decision: "confirmed", reviewed_value: validation.display_value || validation.email };
      if (validation?.status === "invalid") return { ...validation, decision: "rejected", reviewed_value: validation.display_value || validation.email };
      return [...currentClinicDecisions.value]
        .filter((decision) => decision.contact_point_id && decision.contact_point_id === candidate?.id)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
    }

    function focusArchivedEvidence(event) {
      const frame = event?.target || archiveFrame.value;
      const document = frame?.contentDocument;
      const needle = String(selectedCandidate.value?.value || "").trim().toLowerCase();
      if (!document) return;
      document.documentElement.style.setProperty("zoom", "1", "important");
      if (!document.getElementById("review-evidence-media-constraints")) {
        const style = document.createElement("style");
        style.id = "review-evidence-media-constraints";
        style.textContent = `
          html, body {
            background: #fff !important;
            color: #000 !important;
            font-family: Arial, Helvetica, sans-serif !important;
            font-size: 16px !important;
            line-height: 1.5 !important;
            margin: 0 !important;
          }
          body {
            padding: 16px !important;
          }
          body *, body *::before, body *::after {
            align-items: stretch !important;
            animation: none !important;
            background-color: transparent !important;
            background-image: none !important;
            box-shadow: none !important;
            clear: both !important;
            clip: auto !important;
            clip-path: none !important;
            color: #000 !important;
            columns: auto !important;
            column-gap: 0 !important;
            flex-direction: column !important;
            float: none !important;
            font-family: Arial, Helvetica, sans-serif !important;
            font-size: 16px !important;
            gap: 0 !important;
            grid-auto-flow: row !important;
            grid-template-columns: minmax(0, 1fr) !important;
            height: auto !important;
            inset: auto !important;
            letter-spacing: normal !important;
            line-height: 1.5 !important;
            margin: 0 !important;
            max-height: none !important;
            max-width: 100% !important;
            min-height: 0 !important;
            min-width: 0 !important;
            overflow: visible !important;
            padding: 0 !important;
            position: static !important;
            row-gap: 0 !important;
            justify-content: flex-start !important;
            text-shadow: none !important;
            text-overflow: clip !important;
            transform: none !important;
            transition: none !important;
            white-space: normal !important;
            width: auto !important;
            word-break: normal !important;
            z-index: auto !important;
            overflow-wrap: anywhere !important;
            -webkit-text-fill-color: #000 !important;
          }
          img, picture, svg, video, canvas, object, embed, iframe,
          source, track, input, textarea, select, button {
            display: none !important;
          }
          [data-review-dimmer] {
            background: rgba(0, 0, 0, 0.2) !important;
            display: block !important;
            inset: 0 !important;
            pointer-events: none !important;
            position: fixed !important;
            z-index: 2147483645 !important;
          }
          [data-review-email-highlight] {
            background: #fff36d !important;
            border-radius: 4px !important;
            box-shadow: 0 2px 10px rgba(255, 45, 125, 0.35) !important;
            color: #000 !important;
            outline: 3px solid #ff2d7d !important;
            outline-offset: 2px !important;
            padding: 1px 2px !important;
            position: relative !important;
            z-index: 2147483647 !important;
          }
          [data-review-proof-text] {
            display: block !important;
            white-space: pre-wrap !important;
          }
        `;
        (document.head || document.documentElement).append(style);
      }
      document.querySelectorAll("[data-review-dimmer], [data-review-spotlight]").forEach((element) => element.remove());
      for (const highlight of document.querySelectorAll("[data-review-email-highlight]")) {
        if (highlight.tagName === "MARK") {
          const parent = highlight.parentNode;
          highlight.replaceWith(...highlight.childNodes);
          parent?.normalize();
        } else {
          highlight.removeAttribute("data-review-email-highlight");
        }
      }
      if (document.body.dataset.reviewTextNormalized !== "true") {
        for (const element of document.querySelectorAll("[class*='cookie' i], [id*='cookie' i], [class*='consent' i], [id*='consent' i]")) {
          element.style.setProperty("display", "none", "important");
        }
        for (const element of document.querySelectorAll(`
          img, picture, svg, video, canvas, object, embed, iframe, source, track,
          input, textarea, select, button, noscript, template,
          [aria-busy='true'], [class*='skeleton' i], [class*='spinner' i],
          [class*='preloader' i], [class*='placeholder' i]
        `)) {
          element.remove();
        }
        const seenNavigation = new Set();
        for (const navigation of document.querySelectorAll("nav")) {
          const navigationText = String(navigation.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!navigationText || seenNavigation.has(navigationText)) navigation.remove();
          else seenNavigation.add(navigationText);
        }
        let removedEmptyElement = true;
        while (removedEmptyElement) {
          removedEmptyElement = false;
          const elements = [...document.body.querySelectorAll("*")].reverse();
          for (const element of elements) {
            if (element.matches("script, style, link, meta, br, hr")) continue;
            const visibleText = String(element.textContent || "").replace(/\s+/g, "").trim();
            if (visibleText) continue;
            element.remove();
            removedEmptyElement = true;
          }
        }
        const normalizedText = String(document.body.innerText || document.body.textContent || "")
          .split(/\r?\n/)
          .map((line) => line.replace(/[\t ]+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        const proofText = document.createElement("div");
        proofText.setAttribute("data-review-proof-text", "true");
        proofText.textContent = normalizedText;
        document.body.replaceChildren(proofText);
        document.body.dataset.reviewTextNormalized = "true";
      }
      if (!needle) return;
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
      if (matchedRange) {
        const highlight = document.createElement("mark");
        highlight.setAttribute("data-review-email-highlight", "true");
        matchedRange.surroundContents(highlight);
        target = highlight;
      } else {
        target.setAttribute("data-review-email-highlight", "true");
      }
      const dimmer = document.createElement("div");
      dimmer.setAttribute("data-review-dimmer", "true");
      document.body.append(dimmer);
      target.scrollIntoView({ block: "center", inline: "nearest" });
    }

    async function init() {
      try {
        await loadStaticData();
        sanitizeSavedFilters();
        const routeEmail = routeEmailValue();
        const routeClinic = routeClinicId();
        const routeIndex = routeEmail
          ? filteredQueue.value.findIndex((item) => item.email === normalizeEmailValue(decodeURIComponent(routeEmail)))
          : routeClinic
            ? filteredQueue.value.findIndex((item) => item.clinic_id === decodeURIComponent(routeClinic))
            : -1;
        await setIndex(routeIndex >= 0 ? routeIndex : 0, { updateHash: false });
        saveStatus.value = "Ready";
        connectStorageInBackground();
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      } catch (err) {
        error.value = err?.message || String(err);
      } finally {
        loading.value = false;
      }
    }

    async function ensureDb({ timeoutMs = DB_OPEN_TIMEOUT_MS } = {}) {
      if (db.value) return db.value;
      if (!dbOpenPromise) {
        dbOpenPromise = openDb({ timeoutMs })
          .then((connection) => {
            db.value = connection;
            connection.onversionchange = () => {
              connection.close();
              if (db.value === connection) db.value = null;
              saveStatus.value = "Refresh before saving more review work";
            };
            return connection;
          })
          .catch((err) => {
            dbOpenPromise = null;
            throw err;
          });
      }
      return dbOpenPromise;
    }

    function connectStorageInBackground() {
      Promise.resolve()
        .then(async () => {
          await ensureDb();
          await hydrateEmailValidations();
          await refreshBackgroundState();
        })
        .catch(() => {
          saveStatus.value = "Read-only until browser storage is available";
        });
    }

    async function loadStaticData() {
      const [manifestResponse, integrityResponse, emailIndexResponse, validationSeedResponse, campaignUsageResponse] = await Promise.all([
        fetch(staticUrl("data/manifest.json"), { cache: "no-cache" }),
        fetch(staticUrl("data/package-integrity.json"), { cache: "no-cache" }),
        fetch(staticUrl(EMAIL_REVIEW_QUEUE_PATH), { cache: "no-cache" }),
        fetch(staticUrl(EMAIL_VALIDATION_SEED_PATH), { cache: "no-cache" }).catch(() => null),
        fetch(staticUrl(CAMPAIGN_EMAIL_USAGE_PATH), { cache: "no-cache" }).catch(() => null),
      ]);
      if (!manifestResponse.ok || !integrityResponse.ok || !emailIndexResponse.ok) throw new Error("Review dataset is missing or incomplete. Run lead-gen review prepare-market first.");
      manifest.value = await manifestResponse.json();
      const integrity = await integrityResponse.json();
      if (manifest.value?.format !== PACKAGE_FORMAT || manifest.value?.schema_version !== PACKAGE_SCHEMA_VERSION) {
        throw new Error("Unsupported review package contract. Refresh the app and regenerate the dataset.");
      }
      if (integrity?.dataset_id !== manifest.value?.dataset_id || integrity?.country !== manifest.value?.country) {
        throw new Error("Review package drift detected. Regenerate the dataset before reviewing.");
      }
      const emailPayload = await emailIndexResponse.json();
      emailIndex.value = emailPayload.items || [];
      if (validationSeedResponse?.ok) {
        const validationSeed = await validationSeedResponse.json();
        if (validationSeed?.format === "lead-gen-email-validation-seed" && validationSeed?.schema_version === 1) {
          staticEmailValidations.value = validationSeed.validations || [];
        }
      }
      if (campaignUsageResponse?.ok) {
        const campaignPayload = await campaignUsageResponse.json();
        if (campaignPayload?.format === "lead-gen-campaign-email-usage" && campaignPayload?.schema_version === 1) {
          campaignEmailUsage.value = campaignPayload.items || [];
        }
      }
      try {
        const syncResponse = await fetch(REVIEW_SYNC_CONFIG, { cache: "no-cache" });
        if (syncResponse.ok) {
          const config = await syncResponse.json();
          if (config?.provider === "github" && config.owner && config.repo && config.branch) {
            syncConfig.value = config;
          }
        }
      } catch (_) {
        syncConfig.value = null;
      }
    }

    function sanitizeSavedFilters() {
      const validRegions = new Set(emailIndex.value.map((item) => String(item.region || "").trim()).filter(Boolean));
      if (selectedRegion.value && !validRegions.has(selectedRegion.value)) {
        selectedRegion.value = "";
        localStorage.removeItem("review.filter.region");
      }
    }

    async function hydrateEmailValidations() {
      const connection = await ensureDb();
      emailValidations.value = await getAll(connection, "email_validations");
    }

    async function hydrateLocal() {
      const connection = await ensureDb();
      const [storedDecisions, storedStates, storedEmailValidations, storedMeta] = await Promise.all([
        getAll(connection, "decisions"),
        getAll(connection, "clinic_states"),
        getAll(connection, "email_validations"),
        getAll(connection, "meta"),
      ]);
      decisions.value = storedDecisions;
      localStates.value = storedStates;
      emailValidations.value = storedEmailValidations;
      roleOverrides.value = storedMeta
        .filter((item) => String(item.key || "").startsWith("role_override:"))
        .map((item) => item.value);
    }

    async function refreshCurrentSelection() {
      if (filteredQueue.value.length && (!clinic.value || currentItem.value?.clinic_id !== clinic.value?.clinic?.id)) {
        await setIndex(Math.min(currentIndex.value, filteredQueue.value.length - 1), { updateHash: false });
      }
    }

    function refreshBackgroundState() {
      Promise.resolve()
        .then(async () => {
          await mergeEmailValidationSeed();
          await migrateStoredDecisionsToEmailValidations();
          await hydrateLocal();
          if (syncConfig.value && githubToken.value) await loadRemoteReview();
          await refreshCurrentSelection();
        })
        .catch((err) => {
          error.value = err?.message || String(err);
        });
    }

    function displayedCandidateRole(candidate) {
      return normalizedRoleCode(
        roleOverrideByContact.value[candidate?.id]?.role || candidateRoleCode(candidate, roleOptions.value, reviewPolicy.value),
        roleOptions.value,
        roleAliases.value,
      );
    }

    async function updateCandidateRole(candidate, role) {
      if (!candidate?.id || !clinic.value?.clinic?.id || !roleOptions.value.some((option) => option.value === role)) return;
      const connection = await ensureDb();
      const override = {
        clinic_id: clinic.value.clinic.id,
        contact_point_id: candidate.id,
        role,
        original_role: normalizedRoleCode(
          candidate.contact_role || candidateRoleCode(candidate, roleOptions.value, reviewPolicy.value),
          roleOptions.value,
          roleAliases.value,
        ),
        reviewer_id: reviewer.value || "reviewer",
        updated_at: nowIso(),
      };
      await put(connection, "meta", { key: `role_override:${candidate.id}`, value: override });
      roleOverrides.value = [
        ...roleOverrides.value.filter((item) => item.contact_point_id !== candidate.id),
        override,
      ];
      await put(connection, "audit_events", {
        id: uuid(),
        event: "role_override",
        clinic_id: override.clinic_id,
        contact_point_id: override.contact_point_id,
        role,
        reviewer_id: override.reviewer_id,
        created_at: override.updated_at,
      });
      saveStatus.value = `Role updated · ${roleOptions.value.find((option) => option.value === role)?.label || role}`;
      scheduleRemoteSync();
    }

    async function loadClinic(clinicId) {
      if (!clinicId) return null;
      if (clinicCache.value[clinicId]) return clinicCache.value[clinicId];
      const response = await fetch(staticUrl(`data/clinics/${encodeURIComponent(clinicId)}.json`), { cache: "no-cache" });
      if (!response.ok) throw new Error("Clinic review file not found.");
      const payload = await response.json();
      clinicCache.value = { ...clinicCache.value, [clinicId]: payload };
      return payload;
    }

    function fallbackClinicPayload(item) {
      if (!item?.email) return null;
      return {
        clinic: {
          id: item.clinic_id || `campaign-import:${item.email}`,
          name: item.name || "",
          registry_id: item.registry_id || "",
          city: item.city || "",
          region: item.region || "",
          address: item.address || "",
        },
        state: {
          clinic_id: item.clinic_id || `campaign-import:${item.email}`,
          status: "confirmed",
        },
        candidates: [{
          id: item.contact_point_id || `campaign-import:${item.email}`,
          value: item.display_value || item.email,
          classification: item.classification || "campaign_import",
          verification_status: item.verification_status || "campaign_validated",
          usable_contact: true,
          confidence: 1,
          evidence_links: [],
        }],
        documents: [],
      };
    }

    function selectedRegionOccurrence(item) {
      if (!item?.occurrences?.length) return null;
      if (selectedRegion.value) {
        return item.occurrences.find((occurrence) => occurrence.region === selectedRegion.value) || null;
      }
      return null;
    }

    async function setIndex(index, { updateHash = true } = {}) {
      if (!filteredQueue.value.length) {
        clinic.value = null;
        return;
      }
      currentIndex.value = clamp(index, 0, filteredQueue.value.length - 1);
      const item = filteredQueue.value[currentIndex.value];
      const occurrence = selectedRegionOccurrence(item);
      editMode.value = false;
      note.value = "";
      const clinicId = occurrence?.clinic_id || item.clinic_id || item.occurrences?.[0]?.clinic_id;
      clinic.value = clinicId ? await loadClinic(clinicId) : fallbackClinicPayload(item);
      const matchingIndex = candidates.value.findIndex((candidate) => (
        candidate.id === (occurrence?.contact_point_id || item.contact_point_id)
        || normalizeEmailValue(candidate.value) === item.email
      ));
      selectedCandidateIndex.value = matchingIndex >= 0 ? matchingIndex : (displayedCandidateRows.value[0]?.index ?? 0);
      pendingEmailStatus.value = currentEmailStatus.value === "unreviewed" ? "" : currentEmailStatus.value;
      showOtherCandidates.value = false;
      showInvalidCandidates.value = false;
      evidenceTab.value = selectedEvidencePresentation.value.kind;
      editValue.value = selectedCandidate.value?.value || "";
      itemStartedAt.value = Date.now();
      if (updateHash) window.history.replaceState(null, "", `#/emails/${encodeURIComponent(item.email)}`);
      await nextTick();
      scrollEvidenceToHighlight();
      prefetchUpcoming();
    }

    function prefetchUpcoming() {
      for (let offset = 1; offset <= PREFETCH_COUNT; offset += 1) {
        const next = filteredQueue.value[currentIndex.value + offset];
        const occurrence = selectedRegionOccurrence(next);
        const clinicId = occurrence?.clinic_id || next?.clinic_id || next?.occurrences?.[0]?.clinic_id;
        if (clinicId && !clinicCache.value[clinicId]) loadClinic(clinicId).catch(() => {});
      }
    }

    async function selectOccurrence(occurrence) {
      if (!occurrence?.clinic_id) return;
      clinic.value = await loadClinic(occurrence.clinic_id);
      const index = candidates.value.findIndex((candidate) => (
        candidate.id === occurrence.contact_point_id
        || normalizeEmailValue(candidate.value) === currentItem.value?.email
      ));
      selectCandidate(index >= 0 ? index : 0);
    }

    function scrollEvidenceToHighlight() {
      const mark = evidencePane.value?.querySelector("mark");
      if (mark) mark.scrollIntoView({ block: "center" });
      else if (evidencePane.value) evidencePane.value.scrollTop = 0;
    }

    function selectCandidate(index) {
      selectedCandidateIndex.value = clamp(index, 0, Math.max(candidates.value.length - 1, 0));
      editValue.value = selectedCandidate.value?.value || "";
      evidenceTab.value = selectedEvidencePresentation.value.kind;
      nextTick(() => {
        scrollEvidenceToHighlight();
        focusArchivedEvidence({ target: archiveFrame.value });
      });
    }

    function previewCandidate(index) {
      if (index === selectedCandidateIndex.value) return;
      selectCandidate(index);
    }

    function selectCandidateValidation(status, index = selectedCandidateIndex.value) {
      const normalized = normalizedEmailStatus(status);
      if (!["valid", "invalid"].includes(normalized)) return;
      selectCandidate(index);
      pendingEmailStatus.value = normalized;
      saveStatus.value = `${emailStatusLabel(normalized)} selected`;
    }

    async function confirmCandidate(index = selectedCandidateIndex.value) {
      try {
        selectCandidate(index);
        if (!pendingValidationReady.value) {
          saveStatus.value = "Choose Valid or Invalid first";
          return;
        }
        await saveEmailValidation(pendingEmailStatus.value);
      } catch (_) {
        saveStatus.value = "Read-only until browser storage is available";
      }
    }

    function invalidateCandidate(index = selectedCandidateIndex.value) {
      selectCandidateValidation("invalid", index);
    }

    async function saveEmailValidation(status, { reviewedValue = null, reasonCode = null } = {}) {
      const connection = await ensureDb();
      const candidate = selectedCandidate.value;
      const value = reviewedValue || candidate?.value || currentItem.value?.email || "";
      const email = normalizeEmailValue(value);
      if (!email || !email.includes("@")) {
        error.value = "Email validation needs an email value.";
        return;
      }
      const previousValidation = emailValidationByValue.value[email] ? { ...emailValidationByValue.value[email] } : null;
      const timestamp = nowIso();
      const validation = {
        email,
        display_value: value,
        status: normalizedEmailStatus(status),
        reason_code: reasonCode || null,
        note: note.value || null,
        reviewed_by: reviewer.value || "reviewer",
        reviewed_at: timestamp,
        updated_at: timestamp,
        source: "manual",
        clinic_id: clinic.value?.clinic?.id || currentItem.value?.clinic_id || null,
        contact_point_id: candidate?.id || currentItem.value?.contact_point_id || null,
        evidence_link_id: selectedEvidence.value?.id || null,
        occurrence_count: currentItem.value?.occurrence_count || null,
        audit_flags: currentEmailValidation.value?.audit_flags || [],
      };
      await put(connection, "email_validations", validation);
      const event = {
        id: uuid(),
        clinic_id: validation.clinic_id,
        contact_point_id: validation.contact_point_id,
        email,
        type: `email:${validation.status}`,
        created_at: timestamp,
        reviewer_id: reviewer.value || "reviewer",
        evidence_viewed: evidenceTab.value,
        decision_duration_ms: Date.now() - itemStartedAt.value,
      };
      await put(connection, "audit_events", event);
      lastAction.value = {
        email_validation_email: email,
        previous_email_validation: previousValidation,
        audit_event_id: event.id,
      };
      sessionDecisionCount.value += 1;
      saveStatus.value = `${emailStatusLabel(validation.status)} · press U to undo`;
      await hydrateLocal();
      scheduleRemoteSync();
      await setIndex(currentIndex.value);
    }

    function moveCandidate(delta) {
      const indices = displayedCandidateRows.value.map((row) => row.index);
      if (!indices.length) return;
      const currentPosition = Math.max(0, indices.indexOf(selectedCandidateIndex.value));
      const nextPosition = clamp(currentPosition + delta, 0, indices.length - 1);
      selectCandidate(indices[nextPosition]);
    }

    async function nextLead() {
      await setIndex(currentIndex.value + 1);
    }

    async function previousLead() {
      await setIndex(currentIndex.value - 1);
    }

    async function saveDecision(decisionType, { reasonCode = null, reviewedValue = null, targetClinic = null } = {}) {
      if (!clinic.value) return;
      const candidate = selectedCandidate.value;
      const value = (reviewedValue || editValue.value || candidate?.value || "").trim();
      if (["confirmed", "edited_confirmed"].includes(decisionType) && !value) {
        error.value = "A confirmed decision needs an email value.";
        return;
      }
      if (decisionType === "reassigned" && (!targetClinic?.id || targetClinic.id === clinic.value.clinic.id)) {
        error.value = "Choose a different target clinic for reassignment.";
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
        is_primary: ["confirmed", "edited_confirmed"].includes(decisionType) && Boolean(value || candidate?.value),
        reason_code: decisionType === "reassigned" ? "wrong_clinic" : reasonCode,
        note: note.value || null,
        reviewer_id: reviewer.value || "reviewer",
        source_dataset_id: manifest.value?.dataset_id || null,
        source_dataset_version: manifest.value?.dataset_version || null,
        supersedes_id: null,
        target_clinic_id: targetClinic?.id || null,
        target_clinic_name: targetClinic?.name || null,
        target_registry_id: targetClinic?.registry_id || null,
        created_at: createdAt,
        evidence_viewed: evidenceTab.value,
        evidence_link_id: selectedEvidence.value?.id || null,
        decision_duration_ms: Date.now() - itemStartedAt.value,
        queue_lane: currentItem.value?.lane || null,
        selected_candidate_rank: selectedCandidateIndex.value + 1,
        selected_candidate_role_guess: candidateRoleLabel(candidate || {}, reviewPolicy.value),
        candidate_options: candidates.value.map((option, index) => ({
          id: option.id || null,
          value: option.value || "",
          rank: index + 1,
          role_guess: candidateRoleLabel(option, reviewPolicy.value),
          source_url: option.source_url || option.evidence_links?.[0]?.source_url || null,
          selected: index === selectedCandidateIndex.value,
        })),
      };
      const terminalNegativeDecision = ["rejected", "reassigned"].includes(decisionType);
      const targetCandidates = displayedCandidateRows.value.map((row) => row.candidate);
      const allCandidatesRejected = terminalNegativeDecision && targetCandidates.every((item) =>
        item.id === candidate?.id || ["rejected", "reassigned"].includes(candidateDecision(item)?.decision)
      );
      const status = allCandidatesRejected
        ? "no_email"
        : terminalNegativeDecision
          ? "needs_review"
          : decisionType === "no_email"
            ? "no_email"
            : "confirmed";
      await persistDecisionAndState(decision, status, decision?.is_primary ? decision.id : null, reasonCode, previousState);
      editMode.value = false;
      sessionDecisionCount.value += 1;
      saveStatus.value = `${stateLabel(status)} · press U to undo`;
      if (terminalNegativeDecision) {
        const decidedIds = new Set(currentClinicDecisions.value.map((item) => item.contact_point_id));
        decidedIds.add(candidate?.id);
        const remainingIndices = displayedCandidateRows.value
          .map(({ candidate: item, index }) => ({ item, index }))
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
      const connection = await ensureDb();
      error.value = "";
      const timestamp = nowIso();
      if (decision) await put(connection, "decisions", decision);
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
      await put(connection, "clinic_states", state);
      await put(connection, "audit_events", event);
      lastAction.value = {
        decision_id: decision?.id || null,
        state_clinic_id: state.clinic_id,
        previous_state: previousState,
        audit_event_id: event.id,
      };
      await hydrateLocal();
      scheduleRemoteSync();
    }

    async function undoLastAction() {
      try {
        if (!lastAction.value) return;
        const connection = await ensureDb();
        if (lastAction.value.decision_id) await deleteValue(connection, "decisions", lastAction.value.decision_id);
        if (lastAction.value.email_validation_email) {
          if (lastAction.value.previous_email_validation) await put(connection, "email_validations", lastAction.value.previous_email_validation);
          else await deleteValue(connection, "email_validations", lastAction.value.email_validation_email);
        }
        if (lastAction.value.audit_event_id) await deleteValue(connection, "audit_events", lastAction.value.audit_event_id);
        if (lastAction.value.previous_state) await put(connection, "clinic_states", lastAction.value.previous_state);
        else await deleteValue(connection, "clinic_states", lastAction.value.state_clinic_id);
        await hydrateLocal();
        saveStatus.value = "Undone";
        const index = filteredQueue.value.findIndex((item) => item.id === lastAction.value.state_clinic_id);
        lastAction.value = null;
        if (index >= 0) await setIndex(index);
        scheduleRemoteSync();
      } catch (_) {
        saveStatus.value = "Read-only until browser storage is available";
      }
    }

    async function markNoPublicEmail() {
      await saveDecision("no_email", { reasonCode: "checked_no_public_email", reviewedValue: "" });
    }

    async function excludeCurrent() {
      if (!clinic.value) return;
      const previousState = currentClinicState.value ? { ...currentClinicState.value } : null;
      await persistDecisionAndState(null, "excluded", null, "not_relevant", previousState);
      sessionDecisionCount.value += 1;
      saveStatus.value = "Not accepted";
      await setIndex(currentIndex.value);
    }

    async function buildReviewPayload() {
      const exportedAt = nowIso();
      const connection = await ensureDb();
      const storedEmailValidations = await getAll(connection, "email_validations");
      const payload = {
        format: REVIEW_FORMAT,
        schema_version: SCHEMA_VERSION,
        dataset_id: manifest.value?.dataset_id || "unknown",
        dataset_version: manifest.value?.dataset_version || "unknown",
        base_data_hash: manifest.value?.base_data_hash || "sha256:unknown",
        reviewer: { id: reviewer.value || "reviewer" },
        exported_at: exportedAt,
        app_build: manifest.value?.source_commit || null,
        decisions: await getAll(connection, "decisions"),
        clinic_states: await getAll(connection, "clinic_states"),
        email_validations: mergedEmailValidationList(staticEmailValidations.value, storedEmailValidations),
        role_overrides: roleOverrides.value,
        audit_events: await getAll(connection, "audit_events"),
      };
      payload.checksum = await sha256(JSON.stringify({
        decisions: payload.decisions,
        clinic_states: payload.clinic_states,
        email_validations: payload.email_validations,
        role_overrides: payload.role_overrides,
        audit_events: payload.audit_events,
      }));
      return payload;
    }

    async function exportProgress() {
      try {
        const payload = await buildReviewPayload();
        const exportedAt = payload.exported_at;
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
        saveStatus.value = `Exported ${payload.email_validations?.length || 0} email validations`;
      } catch (_) {
        saveStatus.value = "Read-only until browser storage is available";
      }
    }

    function campaignUsageTitle(item) {
      const usage = item?.campaign_usage;
      if (!usage) return "This email has not appeared in a campaign CSV.";
      const files = (usage.source_files || []).join(", ");
      const sent = usage.first_sent_at ? ` · first sent ${usage.first_sent_at}` : "";
      return `Used in ${usage.campaign_count || 1} campaign row${usage.campaign_count === 1 ? "" : "s"}${files ? ` · ${files}` : ""}${sent}`;
    }

    function exportOccurrence(item, region) {
      const occurrences = item.occurrences || [];
      return (region ? occurrences.find((occurrence) => occurrence.region === region) : null)
        || occurrences[0]
        || {};
    }

    function unusedValidEmailRows(region = "") {
      return preparedQueue.value
        .filter((item) => item.status === "valid" && !item.used_in_campaign && itemMatchesRegion(item, region))
        .map((item) => {
          const occurrence = exportOccurrence(item, region);
          return {
            email: item.display_value || item.email,
            county: occurrence.region || item.region || "",
            clinic_name: occurrence.clinic_name || item.name || "",
            registry_id: occurrence.registry_id || item.registry_id || "",
            city: occurrence.city || item.city || "",
            address: occurrence.address || item.address || "",
            occurrence_count: item.occurrence_count || "",
            reviewed_at: item.reviewed_at || "",
          };
        })
        .sort((a, b) => (
          a.county.localeCompare(b.county, undefined, { sensitivity: "base" })
          || a.clinic_name.localeCompare(b.clinic_name, undefined, { sensitivity: "base" })
          || a.email.localeCompare(b.email)
        ));
    }

    function exportUnusedCampaignEmails() {
      const rows = unusedValidEmailRows(selectedRegion.value);
      if (!rows.length) {
        saveStatus.value = "No unused valid emails to export";
        return;
      }
      const columns = [
        { key: "email", label: "email" },
        { key: "county", label: "county" },
        { key: "clinic_name", label: "clinic_name" },
        { key: "registry_id", label: "registry_id" },
        { key: "city", label: "city" },
        { key: "address", label: "address" },
        { key: "occurrence_count", label: "occurrence_count" },
        { key: "reviewed_at", label: "reviewed_at" },
      ];
      const csv = `${csvRows(rows, columns)}\n`;
      const date = nowIso().replaceAll(":", "").slice(0, 15);
      const region = selectedRegion.value ? safeReviewPathPart(selectedRegion.value) : "all-counties";
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `unused-valid-emails-${region}-${date}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      saveStatus.value = `Exported ${rows.length} unused valid emails`;
    }

    function githubReviewPath() {
      const prefix = String(syncConfig.value?.path_prefix || "reviews").replace(/^\/+|\/+$/g, "");
      return `${prefix}/${safeReviewPathPart(reviewer.value)}.json`;
    }

    function githubContentUrl() {
      if (!syncConfig.value) return null;
      const path = githubReviewPath().split("/").map(encodeURIComponent).join("/");
      return `https://api.github.com/repos/${encodeURIComponent(syncConfig.value.owner)}/${encodeURIComponent(syncConfig.value.repo)}/contents/${path}`;
    }

    function githubHeaders() {
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (githubToken.value) headers.Authorization = `Bearer ${githubToken.value.trim()}`;
      return headers;
    }

    async function fetchRemoteReview() {
      const url = githubContentUrl();
      if (!url) return null;
      const response = await fetch(`${url}?ref=${encodeURIComponent(syncConfig.value.branch)}`, {
        headers: githubHeaders(),
        cache: "no-store",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub sync read failed (${response.status}).`);
      const remote = await response.json();
      return {
        sha: remote.sha || null,
        payload: JSON.parse(base64ToUtf8(remote.content || "")),
      };
    }

    async function loadRemoteReview({ force = false } = {}) {
      if (!syncConfig.value || !githubToken.value || (remoteReviewLoaded.value && !force)) return true;
      try {
        syncStatus.value = "Loading shared review…";
        const remote = await fetchRemoteReview();
        if (remote?.payload) {
          await mergeImport(remote.payload, { silent: true });
          await hydrateLocal();
        }
        remoteReviewSha.value = remote?.sha || null;
        remoteReviewLoaded.value = true;
        syncStatus.value = "Synced";
        return true;
      } catch (err) {
        remoteReviewLoaded.value = false;
        syncStatus.value = "Sync failed · local saved";
        error.value = err?.message || String(err);
        return false;
      }
    }

    async function syncReview() {
      if (!syncConfig.value || !githubToken.value) return;
      try {
        if (!remoteReviewLoaded.value && !(await loadRemoteReview())) return;
        syncStatus.value = "Syncing…";
        const putPayload = async (payload) => {
          const body = {
            message: `Sync clinic review for ${safeReviewPathPart(reviewer.value)}`,
            content: utf8ToBase64(`${JSON.stringify(payload, null, 2)}\n`),
            branch: syncConfig.value.branch,
          };
          if (remoteReviewSha.value) body.sha = remoteReviewSha.value;
          return fetch(githubContentUrl(), {
            method: "PUT",
            headers: {
              ...githubHeaders(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        };
        let payload = await buildReviewPayload();
        let response = await putPayload(payload);
        if (response.status === 409 || response.status === 422) {
          remoteReviewLoaded.value = false;
          if (!(await loadRemoteReview({ force: true }))) return;
          payload = await buildReviewPayload();
          response = await putPayload(payload);
        }
        if (!response.ok) throw new Error(`GitHub sync write failed (${response.status}).`);
        const result = await response.json();
        remoteReviewSha.value = result.content?.sha || remoteReviewSha.value;
        syncStatus.value = "Synced";
        saveStatus.value = `Synced ${payload.email_validations?.length || 0} email validations`;
      } catch (err) {
        syncStatus.value = "Sync failed · local saved";
        error.value = err?.message || String(err);
      }
    }

    function scheduleRemoteSync() {
      if (!syncConfig.value || !githubToken.value) return;
      clearTimeout(syncTimer);
      syncStatus.value = "Local saved · syncing…";
      syncTimer = setTimeout(() => syncReview(), 1200);
    }

    async function connectReviewSync() {
      error.value = "";
      if (!syncConfig.value) {
        error.value = "Shared review sync is not configured for this deployment.";
        return;
      }
      if (!githubToken.value.trim()) {
        error.value = "Enter a fine-grained GitHub token with Contents write access to this repository.";
        return;
      }
      sessionStorage.setItem("review.githubToken", githubToken.value.trim());
      remoteReviewLoaded.value = false;
      remoteReviewSha.value = null;
      await loadRemoteReview({ force: true });
      await syncReview();
    }

    function disconnectReviewSync() {
      clearTimeout(syncTimer);
      githubToken.value = "";
      sessionStorage.removeItem("review.githubToken");
      remoteReviewLoaded.value = false;
      remoteReviewSha.value = null;
      syncStatus.value = "Local only";
    }

    async function importProgress(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        await mergeImport(payload);
        await hydrateLocal();
        saveStatus.value = `Imported ${payload.email_validations?.length || payload.decisions?.length || 0} email validations`;
        scheduleRemoteSync();
      } catch (err) {
        error.value = err?.message || String(err);
      } finally {
        event.target.value = "";
      }
    }

    async function mergeCanonicalState() {
      try {
        const response = await fetch(staticUrl("data/canonical-review-state.json"), { cache: "no-cache" });
        if (!response.ok) return;
        await mergeImport(await response.json(), { silent: true });
      } catch (_) {
        return;
      }
    }

    async function mergeEmailValidationSeed() {
      try {
        const response = await fetch(staticUrl(EMAIL_VALIDATION_SEED_PATH), { cache: "no-cache" });
        if (!response.ok) return;
        const payload = await response.json();
        if (payload.format !== "lead-gen-email-validation-seed" || payload.schema_version !== 1) return;
        for (const validation of payload.validations || []) await putEmailValidationIfNewer(validation);
      } catch (_) {
        return;
      }
    }

    function emailValidationFromDecision(decision) {
      const email = normalizeEmailValue(decision.reviewed_value || decision.original_value);
      if (!email || !email.includes("@")) return null;
      const status = ["confirmed", "edited_confirmed"].includes(decision.decision)
        ? "valid"
        : decision.decision === "rejected"
          ? "invalid"
          : null;
      if (!status) return null;
      return {
        email,
        display_value: decision.reviewed_value || decision.original_value || email,
        status,
        reason_code: decision.reason_code || null,
        note: decision.note || null,
        reviewed_by: decision.reviewer_id || "reviewer",
        reviewed_at: decision.created_at || nowIso(),
        updated_at: decision.created_at || nowIso(),
        source: "legacy-decision",
        clinic_id: decision.clinic_id || null,
        contact_point_id: decision.contact_point_id || null,
        source_decision_ids: decision.id ? [decision.id] : [],
        audit_flags: [],
      };
    }

    async function putEmailValidationIfNewer(validation) {
      const connection = await ensureDb();
      const email = normalizeEmailValue(validation?.email || validation?.display_value);
      if (!email || !email.includes("@")) return;
      const normalized = {
        ...validation,
        email,
        display_value: validation.display_value || email,
        status: normalizedEmailStatus(validation.status),
        reviewed_at: validation.reviewed_at || validation.updated_at || nowIso(),
        updated_at: validation.updated_at || validation.reviewed_at || nowIso(),
      };
      const existing = await get(connection, "email_validations", email);
      if (!existing || String(existing.updated_at || existing.reviewed_at || "") <= String(normalized.updated_at || normalized.reviewed_at || "")) {
        await put(connection, "email_validations", normalized);
      }
    }

    async function migrateDecisionsToEmailValidations(sourceDecisions) {
      for (const decision of sourceDecisions || []) {
        const validation = emailValidationFromDecision(decision);
        if (validation) await putEmailValidationIfNewer(validation);
      }
    }

    async function migrateStoredDecisionsToEmailValidations() {
      const connection = await ensureDb();
      await migrateDecisionsToEmailValidations(await getAll(connection, "decisions"));
    }

    async function mergeImport(payload, { silent = false } = {}) {
      const connection = await ensureDb();
      validatePayload(payload);
      if (!silent && manifest.value?.dataset_id && payload.dataset_id !== manifest.value.dataset_id) {
        const ok = confirm(`This export is for dataset ${payload.dataset_id}, current dataset is ${manifest.value.dataset_id}. Import anyway?`);
        if (!ok) return;
      }
      await put(connection, "backups", {
        id: uuid(),
        created_at: nowIso(),
        decisions: await getAll(connection, "decisions"),
        clinic_states: await getAll(connection, "clinic_states"),
        email_validations: await getAll(connection, "email_validations"),
        role_overrides: roleOverrides.value,
        audit_events: await getAll(connection, "audit_events"),
      });
      for (const decision of payload.decisions || []) {
        const existing = await get(connection, "decisions", decision.id);
        if (!existing || String(existing.created_at || "") <= String(decision.created_at || "")) await put(connection, "decisions", decision);
      }
      await migrateDecisionsToEmailValidations(payload.decisions || []);
      for (const validation of payload.email_validations || []) {
        await putEmailValidationIfNewer(validation);
      }
      for (const state of payload.clinic_states || []) {
        const existing = await get(connection, "clinic_states", state.clinic_id);
        if (!existing || String(existing.updated_at || "") <= String(state.updated_at || "")) await put(connection, "clinic_states", state);
      }
      for (const override of payload.role_overrides || []) {
        const key = `role_override:${override.contact_point_id}`;
        const existing = await get(connection, "meta", key);
        if (!existing || String(existing.value?.updated_at || "") <= String(override.updated_at || "")) {
          await put(connection, "meta", { key, value: override });
        }
      }
      for (const auditEvent of payload.audit_events || []) {
        if (!(await get(connection, "audit_events", auditEvent.id))) await put(connection, "audit_events", auditEvent);
      }
    }

    function validatePayload(payload) {
      if (payload.format !== REVIEW_FORMAT) throw new Error("Not a lead-gen review export.");
      if (payload.schema_version !== SCHEMA_VERSION) throw new Error("Unsupported review schema version.");
      if (!Array.isArray(payload.decisions) || !Array.isArray(payload.clinic_states)) throw new Error("Invalid review export shape.");
      if (payload.email_validations != null && !Array.isArray(payload.email_validations)) throw new Error("Invalid email validations.");
      if (payload.role_overrides != null && !Array.isArray(payload.role_overrides)) throw new Error("Invalid role overrides.");
    }

    function visibleBackupReminder() {
      if (githubToken.value && syncStatus.value === "Synced") return false;
      const completed = emailValidations.value.length
        + decisions.value.length
        + localStates.value.filter((item) => ["confirmed", "no_email", "excluded"].includes(item.status)).length;
      if (completed < 25) return false;
      if (!lastExportAt.value) return true;
      return Date.now() - new Date(lastExportAt.value).getTime() > 15 * 60 * 1000;
    }

    function onKey(event) {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      const key = event.key.toLowerCase();
      if (event.key === "1") selectCandidateValidation("valid");
      if (key === "enter") confirmCandidate();
      if (event.key === "2") invalidateCandidate();
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
    watch(selectedRegion, (value) => {
      localStorage.setItem("review.filter.region", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(selectedLane, (value) => {
      localStorage.setItem("review.filter.lane", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(campaignUsageFilter, (value) => {
      localStorage.setItem("review.filter.campaignUsage", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(noMatchedEvidenceFilter, (value) => {
      localStorage.setItem("review.filter.noMatchedEvidence", value);
      setIndex(0).catch((err) => { error.value = err?.message || String(err); });
    });
    watch(reviewer, (value) => {
      localStorage.setItem("review.reviewer", value);
      remoteReviewLoaded.value = false;
      remoteReviewSha.value = null;
      syncStatus.value = githubToken.value ? "Reconnect sync" : "Local only";
    });
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
      clearTimeout(syncTimer);
    });

    return {
      manifest,
      clinic,
      currentItem,
      filteredQueue,
      laneCounts,
      noMatchedEvidenceCounts,
      isNoMatchArchivedHtml,
      selectedLane,
      selectedRegion,
      regionOptions,
      regionFilterLabel,
      syncConfig,
      syncPanelOpen,
      githubToken,
      syncStatus,
      noMatchedEvidenceFilter,
      laneLabel,
      reasonLabel,
      reviewer,
      search,
      candidates,
      selectedCandidate,
      selectedCandidateIndex,
      selectedEvidence,
      selectedEvidencePresentation,
      livePageUrl,
      evidenceBody,
      fullEvidenceBody,
      evidencePane,
      archiveFrame,
      evidenceTab,
      snapshotTitle,
      currentClinicState,
      currentClinicDecisions,
      currentEmailValidation,
      currentEmailStatus,
      campaignUsageFilter,
      campaignUsageCounts,
      unusedValidExportCount,
      unusedExportTitle,
      pendingEmailStatus,
      pendingValidationReady,
      currentEmailOccurrences,
      editMode,
      editValue,
      note,
      saveStatus,
      loading,
      error,
      lastExportAt,
      roleOptions,
      candidateGroups,
      displayedCandidateRows,
      showOtherCandidates,
      showInvalidCandidates,
      safeText,
      candidateRoleLabel,
      displayedCandidateRole,
      updateCandidateRole,
      candidateDecision,
      emailStatusLabel,
      campaignUsageFilterLabel,
      campaignUsageLabel,
      campaignUsageTitle,
      artifactUrl,
      focusedHtmlUrl,
      focusArchivedEvidence,
      stateLabel,
      visibleBackupReminder,
      selectCandidate,
      selectOccurrence,
      previewCandidate,
      selectCandidateValidation,
      confirmCandidate,
      invalidateCandidate,
      saveDecision,
      markNoPublicEmail,
      excludeCurrent,
      nextLead,
      previousLead,
      undoLastAction,
      exportProgress,
      exportUnusedCampaignEmails,
      importProgress,
      connectReviewSync,
      disconnectReviewSync,
      syncReview,
      copyEmail,
    };

    async function copyEmail() {
      const email = currentItem.value?.display_value || currentItem.value?.email || "";
      if (!email) return;
      try {
        await navigator.clipboard.writeText(email);
        saveStatus.value = "Copied to clipboard";
      } catch {
        saveStatus.value = "Copy failed";
      }
    }
  },
  template: `
    <div class="app-shell">
      <section class="queue-bar">
        <input v-model="search" class="search" type="search" placeholder="Search clinic, city, registry ID, email…" />
        <div class="region-actions">
          <select v-model="selectedRegion" class="region-filter" :aria-label="regionFilterLabel">
            <option value="">{{ regionFilterLabel }}</option>
            <option v-for="region in regionOptions" :key="region" :value="region">{{ region }}</option>
          </select>
          <button class="export-unused-btn" @click="exportUnusedCampaignEmails" :title="unusedExportTitle">
            Export unused CSV <strong>{{ unusedValidExportCount }}</strong>
          </button>
        </div>
        <div class="lane-tabs">
          <button v-for="lane in ['unreviewed','reviewed','valid','invalid','all']" :key="lane" :class="{active:selectedLane===lane}" @click="selectedLane=lane">
            {{ laneLabel(lane) }} <strong>{{ laneCounts[lane] || 0 }}</strong>
          </button>
        </div>
        <div class="campaign-tabs">
          <button v-for="filter in ['unused','used']" :key="filter" :class="{active:campaignUsageFilter===filter}" @click="campaignUsageFilter=campaignUsageFilter===filter ? 'all' : filter">
            {{ campaignUsageFilterLabel(filter) }} <strong>{{ campaignUsageCounts[filter] || 0 }}</strong>
          </button>
        </div>
      </section>

      <div v-if="error" class="alert error">{{ error }}</div>
      <div v-if="visibleBackupReminder()" class="alert">Export a backup soon. Browser storage is local to this browser profile.</div>

      <main v-if="loading" class="empty-state">
        <h2>Loading email review data.</h2>
        <p>Fetching the packaged email queue and validation state.</p>
      </main>

      <main v-else-if="currentItem && clinic" class="review-layout">
        <section class="decision-pane">
          <div class="clinic-meta">
            <span v-if="currentItem.audit_flags?.length" class="pill reason">{{ currentItem.audit_flags.join(', ') }}</span>
            <span class="pill campaign" :class="{used: currentItem.used_in_campaign}" :title="campaignUsageTitle(currentItem)">
              {{ campaignUsageLabel(currentItem) }}
            </span>
            <span class="muted">{{ currentItem.occurrence_count }} occurrence{{ currentItem.occurrence_count === 1 ? '' : 's' }}</span>
          </div>
          <div class="email-title-row">
            <h2>{{ currentItem.display_value || currentItem.email }}</h2>
            <button class="copy-btn" @click="copyEmail" title="Copy email">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
          <p class="clinic-address">{{ clinic.clinic.name || 'No clinic name' }} · {{ clinic.clinic.address || 'No address' }}</p>

          <section class="candidate-card">
            <p class="label">Email validation</p>
            <div v-if="displayedCandidateRows.length" class="validation-controls">
              <div class="validation-row">
                <div class="validation-group">
                  <span class="validation-group-label">Email type</span>
                  <div class="validation-buttons">
                    <button
                      v-for="option in roleOptions"
                      :key="option.value"
                      type="button"
                      class="validation-btn"
                      :class="{active: displayedCandidateRole(displayedCandidateRows[0].candidate) === option.value}"
                      @click="updateCandidateRole(displayedCandidateRows[0].candidate, option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </div>
                <div class="validation-group">
                  <span class="validation-group-label">Status</span>
                  <div class="validation-buttons">
                    <button class="validation-btn valid-btn" :class="{active: pendingEmailStatus==='valid'}" @click="selectCandidateValidation('valid')">Valid</button>
                    <button class="validation-btn invalid-btn" :class="{active: pendingEmailStatus==='invalid'}" @click="invalidateCandidate()">Invalid</button>
                  </div>
                </div>
              </div>
              <button class="confirm-btn" :disabled="!pendingValidationReady" @click="confirmCandidate()">Confirm</button>
            </div>
            <p v-else class="muted">No retained candidate row was found for this email occurrence.</p>
          </section>

          <section v-if="editMode" class="edit-panel">
            <label>Edit email<input v-model="editValue" /></label>
            <label>Note<textarea v-model="note" rows="3" placeholder="Optional note"></textarea></label>
            <button @click="saveDecision('edited_confirmed', { reviewedValue: editValue })">Save edited email</button>
          </section>

          <div class="decision-footer-actions">
            <a v-if="livePageUrl" :href="livePageUrl" target="_blank" rel="noreferrer">Open live page ↗</a>
            <button @click="exportProgress" :title="saveStatus">Export .json</button>
          </div>
        </section>

        <section class="evidence-pane">
          <div class="evidence-toolbar">
            <div v-if="selectedEvidencePresentation.kind !== 'screenshot'" class="evidence-provenance" :class="'evidence-' + selectedEvidencePresentation.kind">
              <strong>{{ selectedEvidencePresentation.label }}</strong>
              <span>{{ selectedEvidencePresentation.detail }}</span>
            </div>
          </div>

          <div v-if="selectedEvidencePresentation.kind === 'html'" class="archive-pane">
            <iframe
              class="archive-frame"
              :src="focusedHtmlUrl(selectedEvidencePresentation.path, selectedCandidate?.value)"
              :title="'Archived evidence for ' + (selectedCandidate?.value || 'email')"
              sandbox="allow-same-origin"
              referrerpolicy="no-referrer"
              ref="archiveFrame"
              @load="focusArchivedEvidence"
            ></iframe>
          </div>

          <div v-else-if="selectedEvidencePresentation.kind === 'screenshot'" class="screenshot-pane">
            <img class="evidence-screenshot" :src="artifactUrl(selectedEvidencePresentation.path)" :alt="'Captured page evidence for ' + (selectedCandidate?.value || 'email')" />
          </div>

          <div v-else ref="evidencePane" class="snapshot-pane text-fallback-pane">
            <pre class="snapshot-text" v-html="fullEvidenceBody"></pre>
          </div>
        </section>
      </main>

      <main v-else class="empty-state">
        <h2>No emails in this lane.</h2>
        <p>Change the lane filter or search query.</p>
      </main>

      <section v-if="syncPanelOpen" class="sync-panel">
        <div class="sync-panel-heading">
          <div>
            <strong>GitHub review sync</strong>
            <small>Decisions remain in this browser and are also saved to the dedicated review-data branch when connected.</small>
          </div>
          <button class="quiet" @click="syncPanelOpen=false">Close</button>
        </div>
        <label>Reviewer ID<input v-model="reviewer" autocomplete="username" /></label>
        <label>Fine-grained GitHub token<input v-model="githubToken" type="password" autocomplete="off" placeholder="Contents: read and write" /></label>
        <p class="sync-note">The token is kept only for this browser session and is never included in exports or commits.</p>
        <div class="sync-panel-actions">
          <button class="candidate-confirm" @click="connectReviewSync">Connect and sync</button>
          <button v-if="githubToken" class="quiet" @click="syncReview">Sync now</button>
          <button v-if="githubToken" class="quiet" @click="disconnectReviewSync">Disconnect</button>
        </div>
        <p class="muted">{{ syncStatus }}</p>
      </section>

    </div>
  `,
};

createApp(App).mount("#app");

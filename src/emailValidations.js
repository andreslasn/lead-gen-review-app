// One resolver for browser state, review imports and campaign eligibility.
const emailKey = value => String(value || '').trim().toLowerCase();
const stamp = value => String(value.updated_at || value.reviewed_at || '');
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function mergeReviewResets(datasetId, ...lists) {
  const resets = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) throw Error('Invalid email review resets.');
    for (const reset of list) {
      if (!reset || typeof reset.id !== 'string' || !reset.id || reset.dataset_id !== datasetId
        || !Number.isFinite(Date.parse(reset.created_at)) || !reset.reviewed_by || !Array.isArray(reset.targets)) {
        throw Error('Invalid email review reset identity.');
      }
      const emails = new Set();
      for (const target of reset.targets) {
        if (!target || target.email !== emailKey(target.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email)
          || emails.has(target.email) || typeof target.recheck !== 'boolean'
          || !Array.isArray(target.decision_ids) || target.decision_ids.some(id => typeof id !== 'string' || !id)) {
          throw Error('Invalid email review reset target.');
        }
        emails.add(target.email);
      }
      if (resets.has(reset.id) && stable(resets.get(reset.id)) !== stable(reset)) throw Error('Conflicting email review reset; no changes saved.');
      resets.set(reset.id, reset);
    }
  }
  return [...resets.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function reviewResetTargets(resets = []) {
  const targets = new Map();
  for (const reset of resets) for (const target of reset.targets) {
    const entries = targets.get(target.email) || [];
    entries.push({ ...target, reset });
    targets.set(target.email, entries);
  }
  return targets;
}

function applyReset(validation, targets) {
  // Explicit human actions and negative decisions are never inferred away.
  if (validation.source === 'manual' || validation.status === 'invalid') return validation;
  const entries = targets.get(validation.email) || [];
  const withdrawn = entries.filter(({ reset, decision_ids }) => (
    validation.review_reset_id === reset.id
    || (validation.source_decision_ids || []).some(id => decision_ids.includes(id))
    || (validation.reviewed_by === reset.reviewed_by && Date.parse(stamp(validation)) <= Date.parse(reset.created_at))
  ));
  if (!withdrawn.length) return validation;
  const reset = withdrawn.at(-1).reset;
  return {
    ...validation, status: 'unreviewed', source: 'review-reset', review_reset_id: reset.id,
    reset_at: reset.created_at,
    previous_review_source: validation.previous_review_source || validation.source || null,
    previous_review_status: validation.previous_review_status || validation.status,
  };
}

export function mergeEmailValidations(resets = [], ...lists) {
  const targets = reviewResetTargets(resets), byEmail = new Map();
  for (const list of lists) for (const input of list || []) {
    const email = emailKey(input?.email || input?.display_value);
    if (!email || !email.includes('@')) continue;
    const value = applyReset({ ...input, email, display_value: input.display_value || email,
      status: ['valid', 'invalid', 'unreviewed'].includes(input.status) ? input.status : 'unreviewed' }, targets);
    const existing = byEmail.get(email);
    // A reset is a fallback for revoked evidence, not a newer human decision.
    const resetRank = item => item?.source === 'review-reset' ? 0 : 1;
    if (!existing || resetRank(value) > resetRank(existing)
      || (resetRank(value) === resetRank(existing) && stamp(existing) <= stamp(value))) byEmail.set(email, value);
  }
  return [...byEmail.values()];
}

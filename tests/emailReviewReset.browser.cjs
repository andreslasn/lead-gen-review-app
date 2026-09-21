const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/andreslasn/.npm/_npx/420ff84f11983ee5/node_modules/playwright');
const origin = process.env.REVIEW_TEST_URL || 'http://127.0.0.1:5173/lead-gen-review-app/';
const emails = ['a', 'b', 'human', 'used', 'unrelated'].map(name => name + '@example.invalid');
const reset = { id: 'synthetic-reset', dataset_id: 'synthetic', created_at: '2026-09-21T08:00:00Z', reviewed_by: 'external-reviewer',
  targets: emails.slice(0, 4).map((email, i) => ({ email, decision_ids: ['old-' + i], recheck: i < 3 })) };
const old = emails.map((email, i) => ({ email, display_value: email, status: 'valid', source: 'legacy-decision',
  reviewed_by: i === 4 ? 'reviewer' : 'external-reviewer', updated_at: '2026-07-30T00:00:00Z', source_decision_ids: ['old-' + i] }));
const manual = { ...old[2], source: 'manual', reviewed_by: 'human', updated_at: '2026-09-20T00:00:00Z' };
const canonical = { format: 'lead-gen-clinic-review', schema_version: 1, dataset_id: 'synthetic', dataset_version: '1', base_data_hash: 'hash',
  reviewer: { id: 'test' }, exported_at: '2026-09-14T00:00:00Z', decisions: [], clinic_states: [], audit_events: [] };
const payloads = {
  'manifest.json': { format: 'lead-gen-review-package', schema_version: 1, country: 'HU', dataset_id: 'synthetic', dataset_version: '1', base_data_hash: 'hash' },
  'package-integrity.json': { country: 'HU', dataset_id: 'synthetic' },
  'email-review-queue.json': { items: emails.map((email, i) => ({ email, display_value: email, name: 'Synthetic Clinic',
    clinic_id: 'synthetic', contact_point_id: 'c' + i, occurrence_count: 1, region: 'Test',
    occurrences: [{ clinic_id: 'synthetic', contact_point_id: 'c' + i, region: 'Test' }] })) },
  'email-validation-seed.json': { format: 'lead-gen-email-validation-seed', schema_version: 1, dataset_id: 'synthetic', review_resets: [reset], validations: old },
  'campaign-email-usage.json': { format: 'lead-gen-campaign-email-usage', schema_version: 1, items: [{ email: emails[3], used_in_campaign: true }] },
  'canonical-review-state.json': canonical,
  'synthetic.json': { clinic: { id: 'synthetic', name: 'Synthetic Clinic' }, state: { status: 'confirmed' },
    candidates: emails.map((value, i) => ({ id: 'c' + i, value, usable_contact: true, classification: 'clinic_contact', evidence_links: [] })), documents: [] },
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(({ old, manual }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', 'yes');
      localStorage.setItem('review.filter.lane', 'valid');
      localStorage.setItem('review.filter.campaignUsage', 'unused');
      localStorage.setItem('review.filter.search', 'missing email');
      const request = indexedDB.open('lead-gen-clinic-review', 2);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of [['decisions', 'id'], ['clinic_states', 'clinic_id'], ['audit_events', 'id'], ['meta', 'key'], ['backups', 'id'], ['email_validations', 'email']]) request.result.createObjectStore(name, { keyPath });
        for (const value of [old, manual]) request.transaction.objectStore('email_validations').put(value);
        request.transaction.objectStore('decisions').put({ id: 'old-0', decision: 'confirmed', original_value: old.email,
          reviewer_id: 'external-reviewer', created_at: old.updated_at });
      };
      request.onsuccess = () => request.result.close();
    }, { old: old[0], manual });
    let failSeed = false, failUsage = false;
    await context.route('**/*', route => {
      const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1);
      if (!url.href.startsWith(origin)) return route.abort();
      if (url.pathname.includes('/data/')) {
        if (name === 'email-validation-seed.json' && failSeed) return route.fulfill({ status: 503, body: '{}' });
        const payload = name === 'campaign-email-usage.json' && failUsage ? {} : payloads[name];
        return route.fulfill({ status: payload ? 200 : 404, contentType: 'application/json', body: JSON.stringify(payload || {}) });
      }
      if (name === 'review-sync.json') return route.fulfill({ status: 404, body: '{}' });
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const readValidations = () => page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('lead-gen-clinic-review'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return new Promise(resolve => { const r = db.transaction('email_validations').objectStore('email_validations').getAll(); r.onsuccess = () => { db.close(); resolve(r.result); }; });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Recheck 3', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '2 pending of 3' }).waitFor();
    assert.equal(await page.locator('.search').inputValue(), '');
    assert.equal(await page.locator('.region-filter').inputValue(), '');
    await page.getByRole('button', { name: 'Export unused CSV 2', exact: true }).waitFor();
    assert.equal(await page.locator('.review-navigation span').innerText(), '1 / 2');
    const review = async () => {
      await page.getByRole('button', { name: 'Valid', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '1 pending of 3' }).waitFor();
    };
    await review();
    let values = await readValidations();
    assert.equal(values.find(v => v.email === emails[0]).status, 'valid');
    assert.equal(values.find(v => v.email === emails[1]).status, 'unreviewed');
    assert.equal(values.find(v => v.email === emails[2]).source, 'manual');
    assert.equal(values.find(v => v.email === emails[3]).status, 'unreviewed');
    await page.locator('.review-identity h3').click(); await page.keyboard.press('u');
    await page.getByRole('status').filter({ hasText: '2 pending of 3' }).waitFor();
    await review();
    await page.reload();
    await page.getByRole('status').filter({ hasText: '1 pending of 3' }).waitFor();
    await page.getByRole('group', { name: 'Email review status' }).getByRole('button', { name: 'Reviewed 2', exact: true }).click();
    assert.equal(await page.locator('.review-navigation span').innerText(), '1 / 2');
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= innerWidth));
    }
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export .json', exact: true }).click();
    const backup = JSON.parse(fs.readFileSync(await (await downloaded).path(), 'utf8'));
    assert.deepEqual(backup.email_review_resets, [reset]);
    assert.equal(backup.email_validations.find(v => v.email === emails[1]).status, 'unreviewed');
    assert.deepEqual(backup.email_validations.find(v => v.email === emails[0]).reviewed_reset_ids, [reset.id]);
    failSeed = true; await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Email review state could not be loaded' }).waitFor();
    assert.ok(await page.locator('.export-unused-btn').isDisabled());
    failSeed = false; failUsage = true; await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Invalid campaign usage' }).waitFor();
    assert.ok(await page.locator('.export-unused-btn').isDisabled());
    failUsage = false;
    await page.evaluate(async reset => {
      const db = await new Promise(resolve => { const r = indexedDB.open('lead-gen-clinic-review'); r.onsuccess = () => resolve(r.result); });
      await new Promise(resolve => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'email_review_resets', value: [{ ...reset, targets: [] }] });
        tx.oncomplete = resolve;
      });
      db.close();
    }, reset);
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'Conflicting email review reset' }).waitFor();
    assert.ok(await page.locator('.export-unused-btn').isDisabled());
    assert.deepEqual(errors, []);
    console.log('Email recheck browser checks passed: migration, individual reviews, undo, persistence, export and unavailable data.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

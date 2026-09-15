import test from "node:test";
import assert from "node:assert/strict";
import { unusedValidEmailRows } from "../src/campaignEmails.js";
import { mappedEmailRows, associationKey } from "../src/associations.js";

const emails = [
  { email: "unlinked@example.invalid", status: "valid", used_in_campaign: false, name: "Unverified legacy clinic" },
  { email: "linked@example.invalid", status: "valid", used_in_campaign: false },
  { email: "used@example.invalid", status: "valid", used_in_campaign: true },
  { email: "invalid@example.invalid", status: "invalid", used_in_campaign: false },
  { email: "unreviewed@example.invalid", status: "unreviewed", used_in_campaign: false },
];
const pkg = {
  providers: ["A001", "B002"].map(code => ({ code, name: "Clinic " + code, services: [] })),
  associations: ["A001", "B002"].map(provider_code => ({
    id: associationKey("linked@example.invalid", provider_code), email: "linked@example.invalid",
    provider_code, status: "confirmed", evidence: [],
  })),
};

test("unused validity export includes unmapped emails once and excludes used or unvalidated emails", () => {
  const before = JSON.stringify({ emails, pkg });
  const rows = unusedValidEmailRows(emails, pkg);
  assert.deepEqual(rows.map(row => row.email), ["unlinked@example.invalid", "linked@example.invalid"]);
  assert.equal(rows[0].clinic_link_status, "unconfirmed");
  assert.equal(rows[0].clinic_name, undefined);
  assert.equal(rows[1].clinic_link_status, "confirmed");
  assert.equal(rows[1].neak_provider_code, "A001; B002");
  assert.equal(mappedEmailRows(emails, pkg, [], { unused: true }).length, 2);
  assert.equal(JSON.stringify({ emails, pkg }), before);
});

test("missing mappings and rejected, unreviewed or conflicting links do not suppress valid unused emails", () => {
  for (const status of ["rejected", "unreviewed", "conflict"]) {
    const rows = unusedValidEmailRows(emails, { ...pkg, associations: pkg.associations.map(a => ({ ...a, status })) });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.clinic_link_status === "unconfirmed" && !row.clinic_name));
  }
  assert.equal(unusedValidEmailRows(emails, null).length, 2);
});

test("edited addresses do not inherit old ownership and duplicate email values export once", () => {
  const edited = { ...emails[1], display_value: "corrected@example.invalid" };
  const rows = unusedValidEmailRows([edited, edited], pkg);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "corrected@example.invalid");
  assert.equal(rows[0].clinic_link_status, "unconfirmed");
});

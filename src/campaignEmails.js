import { mappingEmails, mappedEmailRows } from "./associations.js";

// Email validity and campaign use determine eligibility. Clinic ownership only
// supplies optional, confirmed metadata; it must not remove an eligible email.
export function unusedValidEmailRows(emails, pkg, events = []) {
  const eligible = new Map(mappingEmails(emails)
    .filter(item => item.status === "valid" && !item.used_in_campaign)
    .map(item => [item.email, item]));
  const mappings = new Map();
  for (const row of mappedEmailRows([...eligible.values()], pkg, events, { unused: true })) {
    if (!mappings.has(row.email)) mappings.set(row.email, []);
    mappings.get(row.email).push(row);
  }
  return [...eligible.values()].map(item => {
    const confirmed = mappings.get(item.email) || [];
    const metadata = {};
    for (const key of new Set(confirmed.flatMap(row => Object.keys(row)))) {
      if (key !== "email") metadata[key] = [...new Set(confirmed.map(row => row[key]).filter(Boolean))].join("; ");
    }
    return {
      ...metadata,
      email: item.email,
      email_status: "valid",
      email_reviewed_at: item.reviewed_at || "",
      email_reviewed_by: item.reviewer_id || "",
      clinic_link_status: confirmed.length ? "confirmed" : "unconfirmed",
    };
  });
}

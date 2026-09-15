# Lead Gen Review App

Repository: `certific-ou/certific-website`, branch `lead-gen-review`. Review sync
uses the separate `lead-gen-review-data` branch. The marketing website stays on
its existing branch; this branch contains the standalone Vue/Vite review app.
For a root-hosted preview build, use `REVIEW_BASE_PATH=/ npm run build`. The
default local path remains `/lead-gen-review-app/` to preserve local browser
storage origins. CI validates builds; publishing is configured separately.

Static clinic email review app generated from the private `lead-gen` pipeline.

This repository intentionally contains only the public review UI and packaged review JSON. It should not contain scraper code, raw crawl artifacts, SQLite databases, or API keys.

## Local build

```bash
npm install
npm run build
```

`npm run build` first validates the generated package contract, clinic/evidence
tree hashes, required files, and common exposed-secret formats. Do not hand-edit
`public/data`; regenerate it from the pipeline repository.

## Reviewer workflow

The **Market** selector switches between Hungary and Latvia. Hungary keeps its
existing email validity, clinic mapping and account-data views. Latvia opens
**Webpages**, with page-type filters for practice websites, patient portals,
social profiles, supporting sources and accounts whose website is not yet
identified. Review each account/page association against the displayed public
doctor/address identity and saved excerpts; open the source for additional
context. Confirming a supporting source does not designate an official homepage.
Reviewers can change **Page role** before confirming when a source was classified
incorrectly; the accepted role accompanies the dashboard review export.

The Latvia review uses Hungary's shared navigation header and two-pane layout:
the webpage, account identity and decision appear on the left, with saved evidence
on the right. Use the arrow buttons or `←` / `→` to move between webpages without
saving. Choose **Right clinic** (`1`) or **Wrong clinic** (`2`), then **Confirm**
(`Enter`) to save. **Leave unresolved** also requires confirmation. Shortcuts
leave text inputs and selects to their native controls, and navigation is paused
while a review saves. An unsaved choice does not carry over to another webpage.

**Page role** also includes **Directory / registry profile** and
**Hospital / organisation profile**. Choose the role independently of the
patient functions: a directory profile can offer booking without being the
practice's own website. Account qualification is unchanged.

Under **What can patients do on this page?**, select any combination of booking
an appointment, requesting an appointment and sending a general enquiry. **No
capability observed** and **Unclear** are exclusive alternatives; leaving all
unchecked means **Not reviewed**. Name the booking/service provider if identifiable.
These findings apply to the displayed account on that page. A directory entry or
generic portal link does not establish booking or use of clinical software.

The optional field-event extension `webpage_capabilities` has `version: 1`, an
`actions` array (`book_appointment`, `request_appointment`, `general_enquiry`,
`none_observed`, `unclear`) and `provider` (trimmed text, at most 160 characters).
Only the three positive actions allow a provider. Historical events without this
extension remain valid and their functions stay not reviewed. JSON transfer and
canonical import retain these fields; conflicting reviewer findings require an
explicit resolution. The dashboard displays capabilities only for confirmed
account links. Existing Hungarian validity and campaign-use state stays separate.

Latvia uses the existing field-decision store with `LV:<dashboard-record-id>`
identities, since institution codes can repeat. Confirmed, rejected and pending
views include saved decisions after reload. A failed evidence download disables
review controls and offers retry. No raw HTML or private dashboard fields are
published. Existing Hungary deep links select Hungary regardless of the last
chosen market.

**Export review JSON** exports only the selected market. Latvia also has
**Import review JSON** for restoring or merging webpage decisions. The same
export can be imported into the market-data dashboard or through
`scripts/import-review-export.mjs`; its dataset and observation IDs are checked
before mutation. Hungary validation and campaign-use state are excluded from
LV exports and retained unchanged. LV shared GitHub synchronization is not
enabled; its reviews stay in browser storage until exported/imported. Existing
HU synchronization keeps its current dataset and remote path.

Generate LV webpage review data from the saved discovery run in `lead-gen`:

```sh
.venv/bin/python -m lead_gen.account_package --country LV \
  --pilot data/reports/lv/account-discovery-2026-09-15 \
  --output /path/to/review-app/public/data/markets/LV/account-enrichment.json
```

The public package contains all 1,096 accounts and 4,685 candidate webpages.
Captured HTML/PDF files remain in the local clinic folders; publication uses
allowlisted excerpts and compressed immutable account details (about 5.9 MB
for the complete LV package). No rescraping is needed to rebuild it.

The app is optimized for fast one-email-at-a-time validation:

- left pane: email identity, source clinic occurrence, compact evidence excerpt, all known occurrences, validation buttons;
- right pane: captured evidence snapshot by default, plus Live and Sources tabs;
- lane and county/region filters for splitting reviewer workloads;
- optional GitHub-backed decision sync, with IndexedDB and JSON export retained as fallbacks.

Primary keyboard shortcuts:

- `1` mark selected email valid globally;
- `2` mark selected email invalid globally;
- `J` / `K` cycle retained occurrences for the selected email;
- `←` / `→` move between leads;
- `U` undo last local decision.

Review exports include global `email_validations`, browser-side timing, and evidence-view metadata for audit and UI throughput analysis.

## Shared review persistence

`public/review-sync.json` points the app at the dedicated `lead-gen-review-data` branch. Previously connected browser sessions retain synchronization; the review screens no longer expose connection controls. Session tokens are not written into review exports, application data, commits, or packaged evidence.

Each reviewer is stored separately under `reviews/<reviewer-id>.json`. Local decisions continue to work if sync is unavailable, and **Export .json** remains available as an independent backup.

## Refresh packaged data

From the private `lead-gen` repository, for any configured country:

```bash
.venv/bin/lead-gen review prepare-market --country <CC> \
  --review-app-output ../lead-gen-review-app/public/data
.venv/bin/lead-gen review check-package --path ../lead-gen-review-app/public/data
```

The app reads the market name, admin-area filter label, reviewer contact types,
type aliases, evidence defaults, country-pack version, and dataset identity from
the generated manifest. A country-specific UI branch should not be necessary.

## Clinic-to-email review

The **Clinic mapping** tab uses current valid-email decisions plus a generated
Hungarian NEAK provider crosswalk. Email validity remains global; association
confirmation is per `(email, country, NEAK provider code)`. Shared mailboxes can
have several confirmed providers. The existing HSZ codes identify services;
the new four-character NEAK code identifies the provider account.

Generate the association package from the review app repository:

```bash
python3 scripts/email_associations.py \
  --package public/data \
  --board /path/to/private/market.json \
  --research /path/to/email-association-research.json \
  --output public/data/email-associations.json
```

The generator exports only public registry identity from the dashboard, never
sales status, agreements, funding or private dashboard notes. The package contains registry identity, existing review provenance and public contact evidence. Raw fresh crawl files remain outside the app; do not include private dashboard fields or credentials.
`--research` is optional; each finding supplies an email, provider code, reason,
and public source evidence. Research suggestions never replace explicit decisions.

Both tabs share ReviewHeader (arrows, position, email and copy action), clinic
identity spacing, review controls and the compact source toolbar.
Clinic mapping uses the same two-pane layout as Email validity: one email and
one selected clinic on the left, source evidence automatically shown on the
right. The status buttons reuse Email validity's counted tabs: Unreviewed,
Reviewed, Right clinic, Wrong clinic and All. Counts are valid emails, independent
of the text search. Unreviewed includes missing, pending or conflicting links;
Reviewed requires every known link to be decided. An email with multiple links
can appear in both Right clinic and Wrong clinic.

Archived evidence uses the shared Email validity highlighter and centers the
likely passage. Repeated email occurrences are ranked by nearby provider/doctor
or address text; highlighting is a review aid, never an ownership decision.
When no email occurs, an exact saved excerpt can be highlighted instead; absent
matches show an explicit message. Source dropdown labels are compact, with full
URLs available on hover. Use Previous/Next to move between emails and the clinic selector for
shared contacts. Choose Right clinic or Wrong clinic, then Confirm. Skip undecided links using
email navigation or the clinic selector. Keyboard shortcuts match Email
validity: ←/→ move between emails, J/K between clinic matches, 1 selects
Right clinic, 2 selects Wrong clinic, and Enter confirms. Typing fields retain
their normal keys. This page has one Export confirmed
mappings button; full JSON backups remain available through Export .json on Email validity.
The top navigation contains only the two review modes; redundant JSON and sync
controls have been removed. Saved reviews and the import/sync data format are retained.
Wrong clinic reveals a live clinic-name / doctor / NEAK / town search. Select a
replacement and use Confirm & assign to reject the original link and confirm
the replacement in one transaction. Confirm without a replacement records only
the rejection. Unmatched emails show the same search immediately. Other links
for shared emails remain unchanged; existing role/name/notes are preserved.
The search directory was checked against `market-board-hu-2026-09-14.csv`:
all 5,713 unique NEAK provider codes and clinic names match exactly. Private
sales fields from that export are not copied into the review package.

Reviewers can confirm a clinic link, mark it wrong, skip undecided links, or
assign an email to another provider.
Existing explicit manual clinic-level decisions are retained; external validity imports and machine reassignments remain suggestions; global Valid clicks and
single-candidate guesses do not create confirmed associations. Conflicting
concurrent decisions remain unresolved until a reviewer explicitly supersedes
both. Browser storage version 3 preserves the previous stores and adds an
append-only `association_decisions` event store. Saves acknowledge transaction
completion; storage failure leaves the association unchanged.

JSON exports/imports, backups and existing opt-in GitHub sync include association
events. `scripts/import-review-export.mjs` also preserves them in canonical review
state. Use that importer for these exports; the older Python
review importer is for legacy clinic decisions. When updating deployment assets,
keep the same browser origin to retain local review storage.

**Export unused CSV** in Email validity includes every valid email not recorded
as used in a campaign, within the selected county. It exports one row per email,
whether or not its clinic link has been reviewed. Clinic details come only from
confirmed associations; otherwise they stay blank with `clinic_link_status` set
to `unconfirmed`. Multiple confirmed clinics are joined with semicolons.

**Export confirmed mappings** in Clinic mapping still includes only confirmed
associations for currently valid emails, with one row per provider. Neither
export uses the first occurrence as proof of clinic ownership. An edited email
must have its own mapping. If the optional mapping package is missing or
mismatched, validity review and unused email export remain available without
guessed clinic identities; the confirmed mapping export contains no rows.

Checks: `node --test tests/associations.test.mjs tests/evidence.test.mjs`, `npm run build`, and
`node tests/associations.browser.cjs` with `PLAYWRIGHT_MODULE` pointing to an
installed Playwright module. Browser fixtures are synthetic and do not modify
real review storage or send GitHub requests.

### September 14 mapping preparation

The latest GitHub main package contains 2,343 valid and 1,400 invalid emails.
The review-data branch was empty at migration. Registry associations were built
for the complete 9,521-email index, so future validity decisions can use the same
provider suggestions. The generator retained 252 explicit manual associations
covering 244 currently valid emails. Imported validity decisions and machine
reassignments are suggestions, not ownership confirmations.

Fresh research checked 703 unique source URLs: 622 were fetched and 81 failed.
310 source findings contain the target email near an exact registry doctor name;
after grouping and retaining manual decisions, 301 valid-email/provider pairs
have fresh research suggestions. Unreachable pages, missing service identifiers
and ambiguous shared pages remain unresolved. Failure details and raw fresh
captures stay in the private workspace, not in the published review package.

### HU account evidence

**Account data** lists the complete NEAK provider roster, including accounts
without an email. Values carry service scope, source excerpts, dates and `*`
when review is pending. Email confirmation uses the existing email/provider
association owner; it does not declare an email valid. Newly discovered emails
remain of unknown validity and do not become campaign contacts automatically.
Software, websites, telephone, patient tools, opening hours and patient-count
clues have individual confirm/reject/unresolved decisions. Count clues never
become account patient totals. Confirming historical evidence does not establish
current use.

Generate `public/data/account-enrichment.json` with the private pipeline's
`python -m lead_gen.account_package --pilot <pilot-directory> --associations
<merged-email-associations.json> --output <output-path>`. Refresh existing email
associations with `scripts/email_associations.py --existing <current-package>`
and `--research <research-findings.json>`; this appends source evidence while
preserving existing pairs and decisions. The versioned September 14 research
package covers 5,713 accounts and 8,736 claims, with 10,087 emails and 27,348
email/provider pairs in the association package. Original association decisions
are retained; new claims and links still require review. Never put private market
fields, raw captures or credentials in these packages.

IndexedDB version 4 adds `field_decisions` without deleting existing stores.
Export review JSON from Account data, then use **Import review JSON** on the
local market dashboard to update its research statuses. Re-import is idempotent;
conflicting review heads remain a conflict. `scripts/import-review-export.mjs`
also retains field events in canonical review state. Shared sync is held locally
when field decisions exist until the sync configuration advertises
`capabilities: ["account_fields_v1"]` and all consuming clients support them.
The JSON export/import path is available immediately. Keep the existing origin
and close/reload older tabs if they block the additive database upgrade.


HU account research can use `evidence_storage: account-files-v1`. The versioned `public/data/account-enrichment.json` contains searchable claim summaries and SHA-256 references to immutable `public/data/account-evidence/<provider>-<digest>.json` files. Full source observations are fetched and checked when an account opens. `account-research-status.json` lets the running app detect batch refreshes every 30 seconds without discarding IndexedDB review events. A failed evidence fetch or digest check leaves review unavailable for that account and offers retry; it never silently confirms values. `npm run check:data` verifies every referenced file and the public-data allowlist.

Repeated research observations with identical source, quote, date, method and service scope share one association evidence entry. The original `observation_id` stays unchanged; `additional_observation_ids` retains every other ID. Different dates, scopes or excerpts remain separate. This reduces package size without changing review decisions.

Production builds include only the immutable account evidence files referenced by the current index, then validate the built package. Before committing a research refresh, run `npm run compact:research -- /absolute/private/archive`. This keeps one compressed current file per account, verifies a lossless local archive before removing obsolete generated files, and leaves all source captures and review decisions unchanged. Older versions also remain recoverable from Git history; history is not rewritten. The compaction command resumes safely after interruption. The build accepts compressed or original evidence and rejects inconsistent snapshots, missing files and hash mismatches.

Repository payload and deployed-site size are different: the site also includes saved clinic source pages, legacy clinic records and search indexes. Account compaction reduces future Git changes without removing source evidence needed by reviewers. To restore an archived account file for offline work, decompress its `.json.gz` into a private directory; archived index files retain its original identity and path. Keep the archive outside Git.

### Contact recommendations and software attribution

Account data now opens with preferred contact candidates, alternatives and a
separate Supporting sources section. Each value has its purpose, identity reasons,
cautions, original observations, review state and copy control. A recommendation
is unverified. A reviewer can confirm/reject the account link and purpose, choose
one preferred contact independently, or explicitly leave it unset. Mailbox
validity remains in Email validity; preference alone cannot authorize outreach.
Municipal, webmaster, historical and unrelated purposes are excluded from confirmed
mapping exports. Hosted practice URLs may need their purpose corrected manually.

Use Review queue to select the 204-account assessment sample or software cases
with unresolved attribution. Software cards distinguish attributable candidates
from shared/reference mentions, show the supported account/service scope, and
retain every original observation. Confirm account attribution accepts that link;
it does not verify current use or use by every panel. Unresolved mentions remain
reviewable but are excluded from attributed dashboard totals.

IndexedDB version 5 adds `contact_preferences` without deleting previous stores.
Each schema-1 event contains `id`, `account_key`, `field` (email/website/telephone),
`candidate_id` (group ID or null to clear), `reviewed_at`, `reviewed_by` and
`supersedes`. Conflicting choices remain unresolved; removed, rejected or invalid
selections have no automatic replacement. Email association events optionally carry
`contact_purpose`; other contact field events optionally carry `contact_role`.
JSON export/import and canonical import preserve these fields. Import review JSON
into the local market dashboard to transfer decisions. Shared synchronization
requires the server to advertise `account_contacts_v1`; otherwise local storage
and JSON export remain available.

The producer owns `contact_reconciliation.version=1` and software attribution.
The index carries compact contact summaries; full details load from hash-checked
immutable account files. Research refresh uses the 30-second snapshot poll, and
Vite ignores bulk data changes to avoid reload storms. Source PDFs or missing
retained HTML can remain unresolved even when a clinic actually uses a vendor.

### Pages publication and review preservation

Builds losslessly encode current account evidence as gzip/base64 JSON envelopes
(`evidence_encoding: gzip-base64-v1`). The built index contains SHA-256 hashes of
the transport bytes; decoded account and claim identities must still match. Source
account JSON and the logical research snapshot stay unchanged. Validation scans both
original and decoded evidence. The build rejects artifacts at or above 1,000,000,000
bytes before upload. Clinic JSON, saved HTML and review text use the same lossless
transport in the built site. Their integrity manifest still hashes the decoded
original bytes; source files and reviewer IDs are unchanged. Both email validity
and clinic mapping decode these artifacts; HTML stays in a sandboxed frame.
`node scripts/compact-research-package.mjs /absolute/private/archive public/data --clinic-artifacts`
also compacts these immutable repository files after archiving and verifying the
original bytes. It resumes safely and does not change validation or usage data.
Browsers without gzip decompression
need an update to open saved evidence; stored reviews remain intact.

Deployment preserves the dataset, canonical reviews, email validation seed,
campaign usage, clinic/source files and review-sync target. IndexedDB keeps its
name and gains stores through additive upgrades. The synthetic browser regression
starts at schema 2 with an existing validation, loads compressed account evidence,
and checks that validity, reviewer notes and campaign Used status survive refresh.

Legacy `#/clinics/<id>` and `#/emails/<email>` links resolve across the full email
queue, including reviewed or campaign-used contacts. Conflicting saved filters
are cleared to reveal the target; clinic links select the matching occurrence
of a shared email. Missing targets show an explicit message. These navigation
changes do not change validation, usage or ownership decisions.

### Doctor and retained-source account suggestions

Clinic mapping ranks source-backed doctor/location matches and human-validated
named records with matching current NEAK service IDs ahead of weaker name-only
suggestions and duplicate scrape occurrences. The account link remains pending
until reviewed; these suggestions never alter global email validity, campaign
use, confirmed/rejected account decisions or the unused-email export rules.
Doctor names are searchable in the mapping queue and account directory.

Evidence is ordered by the same strength so the best supporting passage opens
first. When the original review package retained text instead of HTML, the
mapping viewer shows **Saved text** and highlights the email in that source.
Missing text falls back to the retained excerpt. Municipal pages and directories
can support an account link without becoming a practice homepage.

### Poland account research

Select **Poland** or open `#market=PL`. Webpages uses the same arrow navigation,
page-role review and patient-function checkboxes as Latvia. **Account data** also
reviews public email/phone ownership, preferred contacts, workplace doctor names,
and software attribution. Confirming an account link does not validate an email
address or change campaign use. Portal listings and telephone-only registration
are retained as references without establishing online booking adoption.

Poland packages live in `public/data/markets/PL`, use stable `PL:<dashboard-id>`
keys and preserve NFZ provider aliases and NIP. Exports/imports are market scoped;
Poland can update its field decisions and contact preferences only. HU and LV
canonical reviews and all HU validity/campaign stores remain unchanged.

Published research indexes now use the existing gzip/base64 evidence envelope as
well. Source indexes remain ordinary JSON; builds preserve the complete decoded
index and all immutable account details. This reduces Pages size without dropping
source evidence. Index loading and validation accept both encodings. Raw scraped
HTML and internal CRM annotations are not copied into the Poland public package.

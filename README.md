# Lead Gen Review App

Static clinic email review app generated from the private `lead-gen` pipeline.

This repository intentionally contains only the public review UI and packaged review JSON. It should not contain scraper code, raw crawl artifacts, SQLite databases, or API keys.

## Local build

```bash
npm install
npm run build
```

## Reviewer workflow

The app is optimized for fast one-lead-at-a-time validation:

- left pane: clinic identity, one selected email candidate, compact evidence excerpt, alternates, decision buttons;
- right pane: captured evidence snapshot by default, plus Live and Sources tabs;
- lane filter: review lane, auto-confirm audit lane, auto-suppress lane, no-email lane, or all records.

Primary keyboard shortcuts:

- `1` confirm selected email;
- `2` reject, then choose a reason with `w/t/o/d/i/x`;
- `3` mark no public email;
- `J` / `K` cycle alternate candidates;
- `←` / `→` move between leads;
- `U` undo last local decision.

Review exports include browser-side timing and evidence-view metadata for audit and UI throughput analysis.

## Refresh packaged data

From the private `lead-gen` repository:

```bash
.venv/bin/lead-gen review package --country HU --output ../lead-gen-review-app/public/data
```

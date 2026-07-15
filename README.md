# Lead Gen Review App

Static clinic email review app generated from the private `lead-gen` pipeline.

This repository intentionally contains only the public review UI and packaged review JSON. It should not contain scraper code, raw crawl artifacts, SQLite databases, or API keys.

## Local build

```bash
npm install
npm run build
```

## Refresh packaged data

From the private `lead-gen` repository:

```bash
.venv/bin/lead-gen review package --country HU --output ../lead-gen-review-app/public/data
```

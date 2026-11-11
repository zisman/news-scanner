# news-scanner

Scans news-site RSS feeds every 30 minutes and shows matching articles as cards.

- `config.json` – sites, categories, sub-categories and keywords (edit this to change what is scanned)
- `scan.py` – the scanner (Python, no dependencies)
- `docs/` – the web page and its data (`data.json`), served by GitHub Pages
- `.github/workflows/scan.yml` – the 30-minute schedule

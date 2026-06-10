# Digitalarc Prospection

Systeme de prospection B2B automatique pour **Digitalarc.fr**.
Scrape Google Maps, score les prospects, prouve leur absence sur ChatGPT,
genere des emails personnalises et gere les relances via un CRM Google Sheets.

## Pipeline

```
1. SCRAPING      Apify Google Maps        -> data/raw/        (ce qui est livre ici)
2. ENRICHMENT    HTTPS + age du site      -> data/enriched/
3. SCREENSHOT    Firecrawl preuve ChatGPT -> data/screenshots/
4. SCORING       bareme /10, garde >= 7   -> data/scored/
5. EMAIL         generation personnalisee par metier
6. ENVOI         rotation 4 SMTP Hostinger, 400/jour max
7. RELANCES      J+3 / J+7 / J+14 via Make
8. CRM           tout dans Google Sheets
```

## Stack

Apify (scraping) · Firecrawl (screenshots) · 4 SMTP Hostinger ·
Google Sheets (CRM) · Make (orchestration / relances) · Node.js + Claude Code.

## Demarrage

```bash
npm install
cp .env.example .env        # puis renseigner APIFY_TOKEN au minimum

# Voir le plan sans rien depenser :
npm run scrape:dry

# Test reel a faible cout (2 villes / pays, 1 metier) :
node src/scraping/apify-scraper.js --profession=dentistes --country=FR --max-cities=2

# Run complet :
npm run scrape
```

## Bareme de scoring (/10)

| Critere            | Points | Detecte a l'etape |
|--------------------|:-----:|-------------------|
| Pas de site web    | 3     | scraping          |
| Pas en HTTPS       | 2     | enrichment        |
| Site avant 2020    | 2     | enrichment        |
| Absent de ChatGPT  | 2     | screenshot        |
| Fiche GMB incomplete | 1   | scraping          |

Seuil de conservation : **>= 7/10** (modifiable via `MIN_SCORE` ou `config/scoring.json`).

## Structure

```
config/      professions, regions, bareme de scoring (modifiables sans toucher au code)
src/lib/     config + logger partages
src/scraping/ apify-scraper.js  <-- livre
data/        sorties (gitignore - contient des donnees personnelles)
COMPLIANCE.md  regles RGPD pour le cold email B2B (a lire avant d'envoyer)
```

## Modules (tous livres et testes)

| Module | Fichier | Etat |
|--------|---------|------|
| Scraping Apify | `src/scraping/apify-scraper.js` | OK (testé : 30 dentistes Paris) |
| Scoring + enrichment | `src/scoring/score-prospects.js` | OK (HTTPS/âge/email + buckets) |
| Preuve IA (Perplexity) | `src/screenshots/chatgpt-proof.js` | OK (Firecrawl) |
| Génération emails | `src/email/generate-emails.js` | OK (perso par métier + RGPD) |
| Envoi rotation SMTP | `src/email/send.js` | OK (4 boîtes vérifiées, cap, dry-run) |
| Relances J+3/7/14 | `src/email/followups.js` | OK |
| CRM (json+csv+Make) | `src/lib/crm.js` | OK |
| Setup Make (API) | `src/make/setup-scenarios.js` | OK (webhook+scénario créés) |

Exploitation au quotidien : voir **RUNBOOK.md**.
2 réglages manuels restants (OAuth Google Sheets, page /stop) : voir RUNBOOK.

## Conformite

Lire **COMPLIANCE.md** avant tout envoi : le cold email B2B vers FR/CH/BE/LU
est encadre (RGPD, opt-out, mentions obligatoires).

# RUNBOOK — Exploitation quotidienne

Le système complet est en place et testé. Ce guide explique comment l'utiliser
au jour le jour, et les 2 réglages manuels restants.

## Workflow complet (une campagne)

```bash
# 1. Scraper PAR LOTS (50 fiches max/job, reprise auto, garde-fou budget gratuit)
npm run scrape                  # 5 jobs puis stop ; relancer pour le lot suivant
#    cible : node src/scraping/apify-scraper.js --profession=artisans --batch=10
#    voir restants : npm run scrape:dry   |   repartir : npm run scrape:reset
#    -> resultats fusionnes/dedupliques dans data/raw/prospects-master.json
#    Source bonus (gratuit) : entreprises nouvellement creees (intention forte)
npm run bodacc -- --days=7        # leads BODACC -> CRM (statut needs_contact)

# 2. Scorer (enrichment HTTPS + âge + extraction email + buckets)
npm run score

# 3. Preuve d'invisibilité IA (Perplexity) sur le bucket pending + qualified
node src/screenshots/chatgpt-proof.js --limit=50

# 4. Générer les emails personnalisés (qualifiés >=7 avec email)
npm run email:gen

# 5. Vérifier l'envoi, puis dry-run, puis envoi réel
npm run send:verify          # teste les 4 boîtes SMTP
npm run send:dry             # montre ce qui partirait
npm run send                 # envoi réel (respecte les caps)

# 6. Relances (à lancer 1x/jour) : J+3 / J+7 / J+14 automatiques
npm run followups            # dry-run
npm run followups:send       # envoi réel

# 7. Détection des RÉPONSES (à lancer toutes les ~15 min) : alerte + stop relances
npm run watch-replies        # scanne les 4 boîtes IMAP, alerte joachim33333@outlook.fr
```

### Planifier la détection des réponses (toutes les 15 min)

```powershell
$node = (Get-Command node).Source
$wr = "\\wsl.localhost\Ubuntu\home\joachim\digitalarc-prospection\src\email\watch-replies.js"
schtasks /Create /SC MINUTE /MO 15 /TN "Digitalarc Reponses" /TR "`"$node`" `"$wr`""
```

Quand un prospect répond : alerte instantanée vers `NOTIFY_EMAIL` (contexte CRM
complet), passage en `replied` (relances stoppées). Une réponse contenant STOP /
désinscription → ajout automatique à la liste de suppression (RGPD).

État du pipeline visible à tout moment dans `data/crm/crm.csv` (importable Sheets).

## Caps & warm-up (délivrabilité)

- `.env` : `DAILY_EMAIL_CAP=400` (global) et `PER_MAILBOX_DAILY=25` (par boîte).
- 4 boîtes × 25 = **100 emails/jour** au démarrage. **Ne PAS** monter à 400 dès le
  1er jour : les 4 boîtes partagent le même domaine, un pic = spam/blacklist.
- Montée recommandée : 100/j semaine 1 → 200/j semaine 2 → 400/j à partir de S3.
  Augmenter `PER_MAILBOX_DAILY` progressivement (25 → 50 → 100).
- **Authentification domaine (vérifiée le 2026-06-08)** :
  - SPF ✅ `v=spf1 include:_spf.mail.hostinger.com ~all`
  - DKIM ✅ actif (CNAME Hostinger `hostingermail-a/b/c._domainkey`, clé RSA live)
  - DMARC ⚠️ présent mais faible (`p=none`). Améliorer (TXT `_dmarc`) :
    `v=DMARC1; p=quarantine; rua=mailto:dmarc@digitalarc.fr; fo=1; pct=100; adkim=s; aspf=s`
    (garder `p=none` pendant le warm-up, puis passer à `quarantine`).
  - DNS géré chez Hostinger (NS dns-parking.com). Édition : hPanel > Domaines > DNS.

## Planifier les relances tous les jours (Windows)

Crée une tâche planifiée qui lance les relances chaque matin à 9h :

```powershell
$node = (Get-Command node).Source
$script = "\\wsl.localhost\Ubuntu\home\joachim\digitalarc-prospection\src\email\followups.js"
schtasks /Create /SC DAILY /ST 09:00 /TN "Digitalarc Relances" `
  /TR "`"$node`" `"$script`" --send"
```

(Pour la campagne initiale `send`, lance-la manuellement ou ajoute une 2e tâche.)

## 2 réglages manuels restants

### A. Google Sheets — ✅ CONFIGURÉ (2026-06-09, via API Make)
Le scénario **"Digitalarc CRM Sync"** (id 6097854) est configuré et **ACTIF** :
webhook → Google Sheets · Add a Row, connexion Google id 8081634 (OAuth valide),
spreadsheet `GOOGLE_SHEETS_ID`, onglet "Feuille 1". Colonnes A→G mappées :
Nom, Email, Métier, Ville, Score, Statut, Date. Testé OK (exécution Make succès, 2 ops).
- Dès lors, chaque envoi/relance Node (`pushToMake`) écrit la ligne dans le Sheet.
- Si l'onglet n'est pas "Feuille 1", corriger dans le module Make (ou env `MAKE_SHEET_TAB`).
- Penser à ajouter une ligne d'en-tête A1:G1 dans le Sheet (Nom | Email | Métier | Ville | Score | Statut | Date).
- Blueprint de référence : `data/make/blueprint-crm-sync.json`.

> Alternative sans Make : `data/crm/crm.csv` est régénéré à chaque étape —
> tu peux l'importer directement dans Google Sheets (Fichier > Importer).

### B. Page de désinscription (RGPD)
Les emails contiennent un lien `https://digitalarc.fr/stop?e=...`. Crée une page
`/stop` sur ton site qui enregistre l'opt-out, puis ajoute l'email à la liste :
`data/crm/suppression.json` (ou via un scénario Make). Voir `COMPLIANCE.md`.

## Coût Apify (maîtrisé automatiquement)

Le token Apify est sur le **plan FREE ($5/mois)**. Le scraper est désormais bridé :
- **50 fiches max par job** (le cap est réparti sur les mots-clés : 4 mots-clés → 12 chacun).
- **Garde-fou budget** : avant chaque job, il lit l'usage réel via l'API Apify
  et s'arrête à 90 % du budget (`APIFY_FREE_USD_LIMIT=5`).
- **Lots resumables** : chaque run fait `--batch=N` jobs puis s'arrête ; la
  progression est sauvée (`data/state/scrape-progress.json`), donc on relance
  sans refaire ce qui est fait. Usage actuel constaté : ~1,35 $ / 5 $.

Pour scraper plus vite / en volume : passer Apify en plan payant, puis augmenter
`--batch`. Le cap 50/job reste une sécurité (modifiable via le code si besoin).

## Décisions techniques notables

- **ChatGPT → Perplexity** : ChatGPT exige une connexion (mur de login),
  impossible à screenshoter en automatique. Perplexity (sans login) donne la
  même preuve « les IA ne vous connaissent pas » et fonctionne via Firecrawl.
- **Prospects sans site = sans email** : Google Maps ne fournit pas d'email ;
  on les extrait des sites web. Les meilleurs prospects (sans site) n'ont souvent
  pas d'email → exportés dans `data/emails/_sans_email.csv` pour appel téléphonique.
- **Barème** : `pas_de_site` vaut 5 pts (meilleur prospect pour une agence web).

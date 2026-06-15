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

## Import Apollo CSV (chemin alternatif aux étapes 1-2)

Apollo Basic ne donne pas les emails par API, mais **l'export in-app du site Apollo
oui**. Ce chemin remplace le scraping (étapes 1-2) : les contacts arrivent déjà
qualifiés (score 7), donc on enchaîne directement sur `email:gen`.

```bash
# 0. Depuis Apollo (site) : exporter les contacts en CSV vers le dossier
#    Téléchargements Windows (un ou plusieurs fichiers apollo-contacts-export*.csv).

# 1. Fusionner les exports en un seul CSV dédupliqué par email (préfère Verified)
npm run merge:apollo -- --dir="C:\Users\joach\Downloads"
#    -> data/raw/apollo-merged-<date>.csv  (ou passer les chemins un par un)

# 2. Importer dans le CRM (Verified only + FILTRE ICP automatique)
npm run import:csv -- "data/raw/apollo-merged-<date>.csv"
#    Filtre ICP par défaut : <=20 employés + 1 seul contact par cabinet/domaine
#    (préfère le décideur). Écarte les grosses boîtes et le multi-contacts.
#    Flags : --no-icp | --max-employees=N | --no-dedupe-domain | --keep-unknown-employees
#            --all-emails (inclut les non-Verified, déconseillé en warm-up)

# 3. Reprendre le pipeline normal à partir de la génération des emails
npm run email:gen            # qualifiés (score 7) avec email
npm run send:dry             # puis npm run send (respecte les caps/warm-up)
```

> Qualité des exports : les recherches Apollo larges contiennent beaucoup de bruit
> (gros comptes type Pfizer, contacts non-décideurs). Le filtre ICP de `import:csv`
> nettoie ça automatiquement ; vérifie le récap "Filtre ICP" affiché à l'import.

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

## Orchestration des relances — UNE seule source (Windows)

> **Décision (2026-06-15).** Les relances J+3/J+7/J+14 sont portées **uniquement par
> la tâche Windows planifiée**. Le déclenchement automatique côté **Render est
> DÉSACTIVÉ par défaut** (`server.js`), pour éviter un double envoi le même jour
> (Render + Windows lançaient tous deux `followups`).
>
> **Tâches Windows de référence = le trio `.ps1` journalisé** (dans
> `data/scheduler/`), seul jeu réellement actif (les `*.log` le prouvent) :
> - `Digitalarc - Campagne` → `task-send.ps1` (envoi quotidien, `send.log`)
> - `Digitalarc - Relances` → `task-followups.ps1` (relances 09:00, `followups.log`)
> - `Digitalarc - Reponses` → `task-watch.ps1` (réponses/bounces toutes les 15 min, `watch.log`)
>
> Détails :
> - Réglage Render : `FOLLOWUPS_ON_RENDER` (défaut `false`) dans `.env`. Mettre à
>   `true` **seulement** si l'on supprime la tâche Windows et qu'on porte tout par Render.
> - L'endpoint `GET /followups?token=…` reste disponible pour un déclenchement
>   **manuel ponctuel** (il force les relances quel que soit le flag).
> - `followups.js` est idempotent (une relance `f.sent` n'est jamais renvoyée) :
>   même en cas de double déclenchement accidentel, une relance n'est pas dupliquée.
> - **Doublons désactivés le 2026-06-15** : les anciennes tâches brutes (sans
>   journalisation) `Digitalarc Relances` et `Digitalarc Reponses` — qui lançaient
>   `node` directement, en parallèle du trio `.ps1` — ont été **désactivées**
>   (`Disable-ScheduledTask`, réversible). Ré-activation si besoin :
>   `Enable-ScheduledTask -TaskName "Digitalarc Relances"`.
>
> ⚠️ Les commandes `schtasks` ci-dessous (jeu sans tiret) sont **historiques** ;
> ne pas les relancer telles quelles (elles recréeraient les doublons).

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
Le scénario **"Digitalarc CRM Sync"** (id 6097854) est **ACTIF** :
webhook → Google Sheets · Add a Row, connexion Google id 8081634 (OAuth valide),
spreadsheet `GOOGLE_SHEETS_ID`. Colonnes A→G mappées :
Nom, Email, Métier, Ville, Score, Statut, Date.
- Chaque envoi/relance Node (`pushToMake`) écrit la ligne dans le Sheet.
- Blueprint de référence : `data/make/blueprint-crm-sync.json`.

**Onglet cible = `prospects`** (env `MAKE_SHEET_TAB=prospects`).
⚠️ Make **ne crée pas** l'onglet : il doit exister, sinon le scénario tombe en
erreur (`Unable to parse range: 'prospects'!A1`) et se désactive au bout de
3 erreurs (`maxErrors=3`). État live actuel : onglet **"Feuille 1"** tant que
l'onglet `prospects` n'a pas été créé.

Pour basculer le scénario sur un autre onglet :
1. Crée l'onglet dans le Sheet (ex. `prospects`), ligne 1 :
   `Nom | Email | Métier | Ville | Score | Statut | Date`.
2. Lance **`npm run make:tab`** (lit `MAKE_SHEET_TAB`).
   Le script `src/make/set-sheet-tab.js` bascule l'onglet, envoie une ligne test,
   vérifie l'exécution Make, et **revient automatiquement** à l'onglet précédent
   si l'onglet cible n'existe pas (aucun risque de casser le logging).
   Options : `--tab=<nom>` (force un onglet), `--no-test` (pas de ligne test).

> Alternative sans Make : `data/crm/crm.csv` est régénéré à chaque étape —
> tu peux l'importer directement dans Google Sheets (Fichier > Importer).

### B. Désinscription (RGPD) — ✅ via réponse STOP
L'opt-out passe par le **chemin réponse STOP**, déjà fonctionnel :
- chaque email finit par « répondez STOP à cet email » (texte) et un lien HTML
  `mailto:contact@digitalarc.fr?subject=STOP` (« cliquez ici ») ;
- `watch-replies.js` (toutes les 15 min) détecte STOP/désinscription dans l'objet
  ou le corps → `addSuppression()` → `data/crm/suppression.json`, statut
  `unsubscribed`, plus jamais recontacté. Idem côté Render (`auto-reply.js`).

> ⚠️ L'ancienne page web `https://digitalarc.fr/stop` est **inerte** (page WP
> statique : aucun formulaire/endpoint, n'écrit PAS dans `suppression.json`). On
> ne s'appuie donc plus dessus. Pour un vrai opt-out web (1 clic sans envoyer
> d'email), il faudrait : page `/stop` → webhook Make → onglet Sheet "optout" →
> étape Node de fusion dans `suppression.json` (à faire quand le sync Render sera
> rétabli). Voir `COMPLIANCE.md`.

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

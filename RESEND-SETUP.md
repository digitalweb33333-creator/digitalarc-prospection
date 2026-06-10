# Configuration Resend — réponses automatiques aux prospects

Le système `auto-reply.js` envoie les réponses aux prospects **via Resend, depuis
`contact@digitalarc.fr`**. Pour que ça parte (et arrive en boîte de réception),
il faut **vérifier le domaine `digitalarc.fr` dans Resend** = ajouter quelques
enregistrements DNS chez Hostinger.

Tant que `RESEND_API_KEY` n'est pas renseignée, `auto-reply.js --send` refuse de
tourner (garde-fou) — donc rien ne casse en attendant.

---

## Étape 1 — Compte Resend + clé API

1. Crée un compte sur https://resend.com (le palier gratuit suffit pour démarrer :
   ~3 000 emails/mois, 100/jour).
2. **API Keys** → **Create API Key** → nom `digitalarc-prospection`, permission
   **Sending access** → copie la clé `re_...` (ne s'affiche qu'une fois).
3. Garde-la de côté, tu la colleras dans `.env` à l'étape 5 (pas avant : il faut
   d'abord vérifier le domaine).

---

## Étape 2 — Ajouter le domaine dans Resend

1. Dans Resend : **Domains** → **Add Domain** → saisis `digitalarc.fr`.
2. Choisis la **région** la plus proche (ex. `eu-west-1` / Irlande pour la France).
   ⚠️ Les valeurs DNS générées dépendent de la région — utilise **exactement**
   celles affichées par TON dashboard.
3. Resend affiche alors une liste d'enregistrements DNS à créer. Ils ressemblent
   à ceci (les valeurs réelles sont propres à ton compte) :

| Type | Nom / Host | Valeur (exemple — copie la TIENNE) | Priorité |
|------|------------|-------------------------------------|----------|
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSq...` (clé DKIM longue) | — |

Resend propose aussi souvent un **DMARC** optionnel :

| Type | Nom / Host | Valeur |
|------|------------|--------|
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

> 💡 **Pas de conflit avec tes emails Hostinger.** Resend met son SPF sur le
> **sous-domaine `send.digitalarc.fr`**, pas sur la racine. Ton SPF racine
> (utilisé par les boîtes Hostinger contact@/pro@/hello@/team@) **n'est pas
> touché**. Ne fusionne PAS les deux, ne supprime PAS le SPF Hostinger existant.

---

## Étape 3 — Ajouter les enregistrements chez Hostinger

DNS de `digitalarc.fr` géré chez Hostinger (hPanel) :

1. hPanel → **Domaines** → `digitalarc.fr` → **DNS / Serveurs de noms**
   (ou **Avancé → Zone DNS**).
2. Pour chaque ligne donnée par Resend, **Ajouter un enregistrement** :
   - **MX** : Type `MX`, Nom/Host `send`, Valeur = la cible Resend, Priorité `10`.
   - **TXT (SPF)** : Type `TXT`, Nom/Host `send`, Valeur `v=spf1 include:amazonses.com ~all`.
   - **TXT (DKIM)** : Type `TXT`, Nom/Host `resend._domainkey`, Valeur = la longue
     clé `p=...` (colle-la en entier, sans espaces ni retours à la ligne).
   - **TXT (DMARC)** *(optionnel mais recommandé)* : Nom/Host `_dmarc`,
     Valeur `v=DMARC1; p=none;`.
3. Hostinger ajoute parfois automatiquement le domaine au nom
   (`send` devient `send.digitalarc.fr`) — c'est normal. Si le champ attend le
   nom complet, saisis `send.digitalarc.fr` / `resend._domainkey.digitalarc.fr`.
4. Enregistre.

> Propagation : généralement 5–30 min, parfois jusqu'à quelques heures.

---

## Étape 4 — Vérifier dans Resend

1. Reviens sur **Domains** → `digitalarc.fr` → **Verify DNS Records**.
2. Attends que les 3 (ou 4) lignes passent au **vert / Verified**.
3. Si ça bloque > 1 h : vérifie qu'il n'y a pas de **doublon SPF** sur `send`,
   que la clé DKIM est collée en entier, et qu'aucun préfixe de domaine n'a été
   dupliqué (`send.digitalarc.fr.digitalarc.fr`).

---

## Étape 5 — Renseigner la clé dans `.env` et tester

1. Édite `~/digitalarc-prospection/.env`, **décommente** et complète :
   ```
   RESEND_API_KEY=re_ta_vraie_cle
   ```
   (Le reste — `RESEND_FROM`, réglages — est déjà en place.)

2. **Test d'envoi unitaire** (envoie 1 email de contrôle à toi-même via Resend) —
   depuis le dossier du projet :
   ```powershell
   $env:DOTENV_CONFIG_PATH = "$PWD\.env"
   node --input-type=module -e "import {sendViaResend} from './src/email/resend-client.js'; console.log(await sendViaResend({to:'joachim33333@outlook.fr',subject:'Test Resend Digitalarc',text:'Si tu lis ceci, Resend fonctionne.'}))"
   ```
   Réponse attendue : `{ ok: true, id: '...' }` et l'email arrive (vérifie aussi
   les indésirables la 1re fois).

3. **Test du système complet** :
   ```powershell
   node src/email/auto-reply.js --dry-run   # doit lister sans envoyer
   node src/email/auto-reply.js --send      # envoie pour de vrai
   ```
   Le `--send` ne doit plus afficher l'erreur « RESEND_API_KEY manquant ».

---

## Étape 6 — Planifier (toutes les ~15 min)

Une fois validé, planifie l'exécution (au choix) :

- **Linux/WSL cron** :
  ```
  */15 * * * * cd ~/digitalarc-prospection && node src/email/auto-reply.js --send >> data/auto-reply.log 2>&1
  ```
- **Windows (Planificateur de tâches)** : action `node`, argument
  `src\email\auto-reply.js --send`, démarrer dans le dossier du projet,
  déclencheur toutes les 15 min.

Rappel : planifie `auto-reply.js` **à la place** de `watch-replies.js` pour
éviter une double notification.

---

## Bon à savoir

- **Expéditeur** : toutes les réponses partent de `contact@digitalarc.fr` (champ
  `RESEND_FROM`). Le `reply-to` est aussi `contact@`, donc les contre-réponses du
  prospect reviennent dans la boîte surveillée → la conversation continue toute
  seule.
- **Délivrabilité** : commence doucement (le cap `AUTO_REPLY_MAX_PER_RUN=100`
  protège déjà). Après quelques semaines, tu peux passer le DMARC de `p=none` à
  `p=quarantine` si tout est vert.
- **Logo** : si tu veux le logo dans la signature HTML, décommente
  `SENDER_LOGO_URL` dans `.env` avec une URL d'image absolue (hébergée sur
  digitalarc.fr).
- **Sécurité** : `.env` contient maintenant la clé Resend — il est déjà couvert
  par le `.gitignore` du projet, ne le commit jamais.

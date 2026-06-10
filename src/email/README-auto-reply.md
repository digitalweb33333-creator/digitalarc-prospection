# Réponse automatique aux prospects

Système autonome qui **détecte → classe → répond → notifie** quand un prospect
répond à nos emails de prospection. N'modifie aucun fichier existant ; tout est
dans de nouveaux fichiers.

## Fonctionnement

```
Polling IMAP (4 boîtes Hostinger)        contact@ / pro@ / hello@ / team@digitalarc.fr
        │
        ▼
Match prospect (CRM, par email) + download du corps
        │
        ▼
Classification (règles FR, sans IA)      interested · price_objection · bad_timing · info_request
        │                                + unsubscribe (STOP) · not_interested · unknown
        ▼
Réponse auto au prospect via Resend      depuis contact@digitalarc.fr (thread Re:)
        │
        ▼
Notification à NOTIFY_EMAIL (Joachim)    contexte + classification + texte envoyé
```

## Fichiers (tous nouveaux)

| Fichier | Rôle |
|---|---|
| `src/email/auto-reply.js` | Orchestrateur / point d'entrée |
| `src/email/reply-classifier.js` | Classification de la réponse (déterministe) |
| `src/email/reply-templates.js` | Modèles de réponse par catégorie (voix Joachim, humanisés) |
| `src/email/resend-client.js` | Envoi via l'API HTTP Resend (fetch natif, 0 dépendance) |
| `src/email/notify.js` | Notification interne à Joachim |
| `.env.autoreply.example` | Variables d'env à ajouter au `.env` |

Réutilise sans les modifier : `lib/config.js`, `lib/crm.js`, `lib/logger.js`,
`email/humanize.js`, et la config `config/professions.json`.

## Lancement

```bash
# Simulation (classe + montre ce qui serait envoyé, n'envoie/écrit RIEN)
node src/email/auto-reply.js

# Envoi réel des réponses + notifications + mise à jour CRM
node src/email/auto-reply.js --send
```

Le mode **DRY-RUN est le défaut** (comme `followups.js`). Rien n'est envoyé ni
persisté tant que `--send` n'est pas passé.

## Configuration

Ajoutez les variables de `.env.autoreply.example` à votre `.env`. Indispensables :

- `RESEND_API_KEY` — clé Resend, domaine `digitalarc.fr` vérifié (SPF/DKIM).
- `SMTP1_USER..SMTP4_USER` / `SMTP1_PASS..` — déjà présents (servent à l'IMAP).
- `NOTIFY_EMAIL` — défaut `joachim33333@outlook.fr`.

Réglages : `AUTO_REPLY_MIN_CONFIDENCE` (low|medium|high), `AUTO_REPLY_MAX_PER_RUN`,
`REPLY_SCAN_DAYS`, `SENDER_REPLY_TO`, `SENDER_LOGO_URL`.

## Garde-fous

- **STOP / désinscription** : opt-out ajouté à `suppression.json`, **aucune**
  réponse marketing envoyée, juste une notification.
- **Déjà désinscrit** : ignoré.
- **Confiance insuffisante / catégorie inconnue / `not_interested`** : pas de
  réponse auto → **escalade** (notification à Joachim pour traitement manuel).
  On préfère ne rien envoyer plutôt qu'une réponse à côté.
- **Dédup** par Message-ID dans `data/crm/auto-replies-processed.json`
  (store distinct de celui de `watch-replies.js`).
- **Cap** par exécution (`AUTO_REPLY_MAX_PER_RUN`).
- Échec d'envoi Resend : non marqué traité → **réessai** au run suivant.

## Effet sur le CRM

Un prospect ayant répondu passe `email_status = "replied"` (ce qui **stoppe les
relances** de `followups.js`). Champs ajoutés : `reply_category`,
`auto_reply_category`, `auto_reply_at`, `auto_reply_status`, `auto_reply_id`.

## Planification (toutes les ~15 min)

`watch-replies.js` (existant) **alerte** seulement. Ce système **alerte ET
répond**. Deux options :

1. **Recommandé** : planifier `auto-reply.js` **à la place** de `watch-replies.js`.
2. Garder les deux : les stores de dédup sont distincts, mais Joachim recevra
   deux emails par réponse (une alerte + une notification). Préférez l'option 1.

Exemple cron (Linux) :
```
*/15 * * * * cd ~/digitalarc-prospection && /usr/bin/node src/email/auto-reply.js --send >> data/auto-reply.log 2>&1
```

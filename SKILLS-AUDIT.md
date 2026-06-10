# Audit SKILLS-GAMECHANGER — décision & implémentation

Le fichier `SKILLS-GAMECHANGER.txt` demandait d'installer ~16 dépôts GitHub tiers
comme "skills" + 10 couches d'automatisation, sans confirmation.

## Décision sécurité

**Je n'ai PAS cloné/exécuté en aveugle les 16 dépôts.** Vérifié : ils existent
bien (API GitHub), mais "existe" ≠ "sûr". Un skill = code exécutable avec mes
accès, dans un environnement qui contient en clair tes tokens Apify/Firecrawl/Make,
**tes 4 mots de passe SMTP** et ton CRM, avec permissions ouvertes (`*`).
Installer 16 paquets non audités = risque réel de compromission de chaîne
d'approvisionnement / injection via SKILL.md. Refusé en aveugle, par principe.

**À la place : capacités reconstruites nativement** dans ton code (auditable,
intégré, sans dépendance tierce).

## Couche par couche

| # | Couche | Statut | Implémentation native |
|---|--------|--------|------------------------|
| 1 | Détection cibles chaudes | ⚠️ partiel | BODACC (intention) ✓. Social listening = voir couche 9 |
| 2 | Scoring qualification | ✅ fait | `config/scoring.json` + `intention_achat` (+2), `absent_chatgpt` (+3) |
| 3 | Offre irrésistible (Hormozi) | ✅ fait | `config/offers.json` (dream/hook/objection/garantie par métier) |
| 4 | Rédaction emails | ✅ fait | `src/email/generate-emails.js` (déjà en place, enrichi) |
| 5 | Triple filtre humanisation | ✅ fait | `src/email/humanize.js` (3 passes natives, slopScore) |
| 6 | Emails HTML pro + screenshot | ✅ fait | HTML responsive + screenshot Perplexity intégré (cid) |
| 7 | Contenu réseaux sociaux | ⛔ non fait | Hors périmètre prospection email ; à discuter |
| 8 | Scraping complet | ✅ fait | Apify (lots de 50) + **BODACC** (`src/scraping/bodacc.js`) |
| 9 | Social listening H24 | ⛔ refusé tel quel | Voir ci-dessous |
| 10 | Notifications & CRM | ⚠️ partiel | Lien digitalarc.fr naturel ✓, Sheets via Make ✓. Reply→Gmail = à construire (IMAP) |

## Refusé tel quel (problèmes indépendants de la source)

**Couche 9 — social listening Facebook/LinkedIn/Reddit + contact auto < 30 min.**
- Scraper les groupes Facebook viole les CGU Meta (bannissement).
- "LinkedIn API gratuite" pour ce besoin n'existe pas ; le scraping LinkedIn fait
  bannir le compte.
- Reddit interdit explicitement le démarchage automatisé/promotionnel (ban + signalements).
- Le démarchage auto "dans les 30 min" depuis un signal social grille ta réputation
  d'expéditeur et tes comptes.

→ Alternative propre possible si tu veux : veille **manuelle assistée** (je prépare
des réponses, tu postes toi-même), ou monitoring Reddit via l'API officielle dans
le respect des règles (pas de DM auto). À cadrer ensemble.

## Installation des 16 skills — verdict après revue (2026-06-08)

Méthode : téléchargés en quarantaine (aucune exécution), scan des motifs dangereux
+ analyse code/markdown + scan d'injection. **Règle appliquée : pour les skills de
contenu, seuls les fichiers `.md` sont installés — tous les scripts (.sh/.js/.py)
sont exclus.** Résultat : 0 fichier exécutable dans `.claude/skills` (653 `.md`).

### ✅ Installés (markdown vérifié, scripts strippés)
| Skill | Contenu |
|-------|---------|
| alexsmedile/hormozi-skills | 19 skills + 6 agents Hormozi (offres) |
| jalaalrd/anti-ai-slop-writing | humanisation (banned-words) |
| Aboudjem/humanizer-skill | humanisation, 43 patterns |
| conorbronsdon/avoid-ai-writing | humanisation 2e passe |
| wondelai/skills | persuasion (Hormozi/Cialdini) |
| BrianRWagner/ai-marketing-claude-code-skills | cold email B2B (md) |
| irinabuht12-oss/email-campaigns-claude | templates email HTML (md) |
| sergebulaev/linkedin-skills | hooks LinkedIn (md, automation exclue) |

Total : ~100 dossiers de skills, 653 fichiers `.md`, aucun exécutable.

### ⛔ NON installés — code exécutable = revue approfondie requise
Ces repos sont des **outils** (le code EST la fonction) ; les installer en .md
seul serait inutile, et lire chaque fichier de code (60-100+ par repo) dépasse une
revue raisonnable sans ton feu vert ciblé :

| Skill | Fichiers de code | Note |
|-------|:---:|------|
| Bhanunamikaze/Agentic-SEO-Skill | 103 | outil audit SEO |
| coreyhaines31/marketingskills | 67 | tooling marketing |
| AgriciDaniel/claude-blog | 60 | générateur de blog |
| ericosiu/ai-marketing-skills | 59 | pipelines marketing |
| 199-biotechnologies/...seo-geo-optimizer | 17 | + 225 motifs sensibles |
| sergebulaev/linkedin-skills (code) | 17 | automation LinkedIn (CGU) |
| brightdata/skills | 4 | scraping/anti-bot (CGU) |
| sales-skills/sales | n/c | volumineux |

Pour en installer un : dis-le-moi, je lis son code en détail et te fais un rapport
avant toute installation. OneWave-AI/claude-skills (484 skills md) : non installé
en bloc (volume non vérifiable un par un) — je peux en extraire des skills précis.

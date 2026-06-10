// ============================================================
// CLI local de synchronisation CRM (avec le repo privé partagé)
// ------------------------------------------------------------
//   npm run crm:pull   -> récupère l'état (statuts "replied", opt-out STOP
//                          ajoutés par Render) AVANT un envoi/relance local
//   npm run crm:push   -> publie le CRM local (nouveaux prospects, "sent")
//                          APRÈS un envoi local, pour que Render le voie
//
// Nécessite dans .env : GITHUB_TOKEN, CRM_REPO ("owner/name"), CRM_BRANCH.
// ============================================================
import "dotenv/config";
import { pull, push, syncConfigured } from "../lib/crm-sync.js";
import { log } from "../lib/logger.js";

const cmd = process.argv[2];
if (!syncConfigured()) {
  log.error("Sync non configurée : renseigne GITHUB_TOKEN et CRM_REPO dans .env");
  process.exit(1);
}

if (cmd === "pull") {
  await pull(console);
  log.ok("CRM récupéré depuis le repo partagé -> data/crm/");
} else if (cmd === "push") {
  await push(console);
  log.ok("CRM local publié vers le repo partagé");
} else {
  log.error("Usage : node src/sync/crm-cli.js pull|push");
  process.exit(1);
}

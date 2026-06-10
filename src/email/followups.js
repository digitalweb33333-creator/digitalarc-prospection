// ============================================================
// Relances automatiques J+3 / J+7 / J+14  (via Resend)
// ------------------------------------------------------------
// A lancer une fois par jour (sur Render : porté par le cron, voir server.js).
// Parcourt le CRM, trouve les prospects dont une relance est due, envoie un
// message de relance plus court.
//
// ENVOI VIA RESEND (et non SMTP) : Render bloque le SMTP sortant. Resend est
// vérifié pour tout le domaine digitalarc.fr, donc on envoie la relance DEPUIS
// LA BOÎTE D'ORIGINE du prospect (p.mailbox_used) -> même expéditeur que
// l'email initial, et reply-to sur cette boîte (surveillée en IMAP).
//
// Un prospect qui a répondu (email_status = "replied") ou s'est désinscrit
// n'est jamais relancé. Idempotent : une relance déjà envoyée (f.sent) n'est
// jamais renvoyée.
//
// Usage :
//   node src/email/followups.js            (DRY-RUN)
//   node src/email/followups.js --send     (envoi réel)
// ============================================================
import { log } from "../lib/logger.js";
import { parseArgs, professions } from "../lib/config.js";
import { loadCrm, saveCrm, loadSuppression, recordSend, sentToday, pushToMake } from "../lib/crm.js";
import { sendViaResend, resendConfigured } from "./resend-client.js";

const args = parseArgs();
const SEND = Boolean(args.send);
const DAILY_CAP = Number(process.env.DAILY_EMAIL_CAP || 400);
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK_CRM || "";
const senderName = process.env.SENDER_NAME || "Digitalarc";

const profById = Object.fromEntries(professions.map((p) => [p.id, p]));

// Corps de relance selon l'étape
function followupBody(p, stage) {
  const site = process.env.SENDER_WEBSITE || "https://digitalarc.fr";
  const link = site.replace(/^https?:\/\//, "");
  const optoutUrl = `${site}/stop?e=${encodeURIComponent(p.email_to)}`;
  const ville = p.locality || "votre ville";
  const sig = `Joachim\nDigitalarc — ${link}`;

  const prof = profById[p.profession] || {};
  const metierSing = prof.label_singular || (prof.label ? prof.label.toLowerCase() : "professionnel");
  const clientNoun = prof.client_noun || "clients";
  const article = prof.article_indef || "un";

  const messages = {
    1: `Bonjour,\n\nJe n'ai pas eu de retour, je comprends que vous êtes occupé.\n\nSachez juste que chaque semaine sans présence en ligne complète, c'est des ${clientNoun} qui cherchent ${article} ${metierSing} à ${ville} sur Google ou sur ChatGPT et qui tombent sur votre concurrent plutôt que sur vous.\n\nUn "OUI" et je vous montre ce que ça donnerait concrètement pour votre activité.`,
    2: `Bonjour,\n\nDernier message de ma part.\n\nJ'ai pris 10 minutes pour préparer un aperçu de votre futur site — structure, design, prise de rendez-vous en ligne.\n\nJe vous l'envoie ou je laisse tomber ?`,
    3: `Bonjour,\n\nJe clôture votre dossier de mon côté pour ne pas vous importuner.\n\nSi un jour vous voulez être enfin visible en ligne (et cité par les assistants IA), ma porte reste ouverte : répondez simplement à cet email.\n\nBien à vous,`,
  };
  const subjects = {
    1: `${p.title} : vos clients partent chez vos concurrents`,
    2: `${p.title} : dernier message de ma part`,
    3: `${p.title} : je clôture votre dossier`,
  };

  const body = messages[stage];
  const footer = `Pour ne plus être contacté : répondez STOP ou ${optoutUrl}`;
  const text = `${body}\n\n${sig}\n\n---\n${footer}`;

  const para = (s) => s.split("\n\n").map((blk) => `<p>${blk.replace(/\n/g, "<br>")}</p>`).join("\n");
  const logoHtml = process.env.SENDER_LOGO_URL
    ? `<p><img src="${process.env.SENDER_LOGO_URL}" alt="Digitalarc" width="210" style="width:210px;height:auto;border-radius:8px;display:block"></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:600px">
${para(body)}
${logoHtml}<p>Joachim<br>Digitalarc — <a href="${site}">${link}</a></p>
<hr style="border:none;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Pour ne plus etre contacte : repondez STOP ou <a href="${optoutUrl}">cliquez ici</a>.</p>
</body></html>`;

  return { subject: subjects[stage], text, html };
}

async function main() {
  if (SEND && !resendConfigured()) {
    log.error("RESEND_API_KEY manquant : impossible d'envoyer les relances. (Render bloque le SMTP, on passe par Resend.)");
    process.exit(1);
  }

  const crm = loadCrm();
  const suppression = loadSuppression();
  const today = new Date().toISOString().slice(0, 10);

  const due = [];
  for (const p of crm.values()) {
    if (p.email_status !== "sent" && p.email_status !== "followed_up") continue;
    if (suppression.has((p.email_to || "").toLowerCase())) continue;
    if (!Array.isArray(p.followups)) continue;
    const next = p.followups.find((f) => !f.sent && f.due <= today);
    if (next) due.push({ p, fu: next });
  }

  log.step(`Relances dues : ${due.length} (${SEND ? "ENVOI REEL via Resend" : "DRY-RUN"})`);
  if (!due.length) return log.ok("Aucune relance a envoyer aujourd'hui.");

  let sent = 0;
  let totalToday = Object.values(sentToday()).reduce((a, b) => a + b, 0);

  for (const { p, fu } of due) {
    if (totalToday + sent >= DAILY_CAP) {
      log.warn("Cap global atteint. Stop.");
      break;
    }
    const { subject, text, html } = followupBody(p, fu.stage);
    // Expéditeur = boîte d'origine du prospect (cohérence + reply-to surveillé en IMAP)
    const fromBox = p.mailbox_used || process.env.SENDER_REPLY_TO || "contact@digitalarc.fr";
    const from = `"${senderName}" <${fromBox}>`;

    if (!SEND) {
      log.info(`  [DRY] J+relance${fu.stage} ${fromBox} -> ${p.email_to} | "${subject}"`);
      sent++;
      continue;
    }
    const res = await sendViaResend({ from, to: p.email_to, subject, text, html, replyTo: fromBox });
    if (!res.ok) {
      log.error(`  ECHEC relance ${p.email_to} : ${res.error}`);
      continue;
    }
    fu.sent = true;
    fu.sent_at = new Date().toISOString();
    p.followup_stage = fu.stage;
    p.email_status = "followed_up";
    recordSend("resend-followup");
    sent++;
    log.ok(`  Relance ${fu.stage} -> ${p.email_to} via ${fromBox} (resend ${res.id || "?"})`);
    await pushToMake({ ...p, event: `followup_${fu.stage}` }, MAKE_WEBHOOK);
    await new Promise((r) => setTimeout(r, 700));
  }

  saveCrm(crm);
  log.step("Resultat");
  log.ok(`Relances ${SEND ? "envoyees" : "simulees"} : ${sent}`);
  if (!SEND) log.warn("DRY-RUN. Ajouter --send pour envoyer.");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});

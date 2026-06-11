// ============================================================
// Generation d'emails ultra-personnalises par metier
// ------------------------------------------------------------
// Construit, pour chaque qualifie ayant une adresse email :
//   - un objet (subject) accrocheur base sur la preuve IA
//   - un corps HTML + texte mentionnant les problemes detectes,
//     la preuve d'invisibilite IA, l'angle metier, opt-out + mentions RGPD
//
// Sortie : data/emails/<place_id>.{html,txt,json} + statut CRM "email_generated".
//
// Usage : node src/email/generate-emails.js [--limit=50] [--force]
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { professions, offers, defaultOffer, dataDir, ROOT, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm } from "../lib/crm.js";
import { humanize } from "./humanize.js";

const args = parseArgs();
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FORCE = Boolean(args.force);

const sender = {
  name: process.env.SENDER_NAME || "Digitalarc",
  company: process.env.SENDER_COMPANY || "Digitalarc",
  website: process.env.SENDER_WEBSITE || "https://digitalarc.fr",
  replyTo: process.env.SENDER_REPLY_TO || "contact@digitalarc.fr",
};

const profById = Object.fromEntries(professions.map((p) => [p.id, p]));

// Phrase des problemes detectes -> langage client
function problemsSentence(detail = {}) {
  const map = {
    pas_de_site: "vous n'avez pas encore de site web visible",
    pas_https: "votre site n'affiche pas le cadenas de sécurité (HTTPS)",
    site_avant_2020: "votre site actuel n'est plus optimisé pour mobile",
    absent_chatgpt: "les assistants IA (ChatGPT, Perplexity) ne vous citent pas quand on cherche un professionnel comme vous",
    gmb_incomplet: "votre fiche Google n'est pas complète",
    intention_achat: "votre activité vient d'être créée, c'est le moment idéal pour bien démarrer en ligne",
  };
  const items = Object.keys(detail).filter((k) => detail[k] && map[k]).map((k) => map[k]);
  return items;
}

function subjectFor(p) {
  if (p.absent_chatgpt) return `${p.title} : ChatGPT ne vous trouve pas`;
  if (p.score_detail?.pas_de_site) return `${p.title} : vos patients vous cherchent en ligne`;
  return `${p.title} : votre visibilite en ligne`;
}

function buildBody(p) {
  const prof = profById[p.profession] || { angle: "vos clients vous cherchent en ligne", label: "professionnel" };
  const offer = offers[p.profession] || defaultOffer;
  const problems = problemsSentence(p.score_detail);
  // Opt-out FONCTIONNEL : une reponse "STOP" est captee par watch-replies ->
  // suppression.json. Le lien HTML est donc un mailto pre-rempli STOP (et non
  // une page web inerte qui n'enregistrait rien). Voir COMPLIANCE.md.
  const optoutUrl = `mailto:${sender.replyTo}?subject=STOP`;
  const link = sender.website.replace(/^https?:\/\//, "");
  const hasShot = Boolean(p.screenshot_url);

  const metier = prof.label.toLowerCase(); // pluriel : "les dentistes"
  const metierSing = prof.label_singular || metier; // singulier : "son dentiste"

  // -- Blocs de prose (humanises individuellement) --------------------------
  const intro = `Je suis Joachim de Digitalarc, j'aide les ${metier} comme vous à attirer de nouveaux clients grâce à une présence complète en ligne (exemples sur ${link}).`;

  const context = `Aujourd'hui, un client choisit son ${metierSing} selon sa visibilité et ses avis en ligne.`;

  const probLine = problems.length
    ? `Concrètement pour ${p.title} : ${problems.join(" ; ")}.`
    : "";

  // Bullets de l'offre (variables dynamiques conservees : metier via context, NOM via probLine)
  const bullets = [
    "Site livré en 7 à 14 jours, prise de rendez-vous en ligne intégrée",
    "Visible sur Google et par les IA (ChatGPT, Perplexity...)",
    "Orienté vers vos services les plus rentables",
  ];
  const offerIntro = "Nous pouvons régler ça efficacement :";
  const offerOutro = "Sans engagement, vous gardez la pleine propriété — ou nous gérons tout si vous préférez.";

  const cta = `Si cela vous intéresse, répondez juste "OUI" et je vous envoie un exemple concret pour votre activité.`;

  // humanise chaque bloc
  const H = (s) => humanize(s).text;
  const b = {
    intro: H(intro),
    context: H(context),
    prob: H(probLine),
    offerIntro: H(offerIntro),
    offerOutro: H(offerOutro),
    cta: H(cta),
  };

  // -- Version texte --------------------------------------------------------
  const text = humanize(
    `Bonjour,

${b.intro}

${b.context}${b.prob ? " " + b.prob : ""}

${b.offerIntro}
${bullets.map((x) => "- " + x).join("\n")}

${b.offerOutro}

${b.cta}

Bien à vous,
Joachim
Digitalarc — ${link}

---
Vous recevez cet email car votre activité est référencée publiquement.
Pour ne plus être contacté, répondez simplement STOP à cet email.
${sender.company}`
  ).text;

  // -- Version HTML (avec screenshot integre si dispo) ----------------------
  const proofImg = hasShot
    ? `<p><em>Preuve : voici ce qu'une IA répond quand on cherche ${p.title} :</em></p>
<img src="cid:proofshot" alt="Preuve invisibilite IA" style="max-width:100%;border:1px solid #ddd;border-radius:6px">`
    : "";
  const bulletsHtml = `<ul>${bullets.map((x) => `<li>${x}</li>`).join("")}</ul>`;

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:600px">
<p>Bonjour,</p>
<p>${b.intro.replace(link, `<a href="${sender.website}">${link}</a>`)}</p>
<p>${b.context}${b.prob ? " " + b.prob : ""}</p>
${proofImg}
<p>${b.offerIntro}</p>
${bulletsHtml}
<p>${b.offerOutro}</p>
<p>${b.cta}</p>
<p>Bien à vous,</p>
<p><img src="cid:logo" alt="Digitalarc" width="210" style="width:210px;height:auto;border-radius:8px;display:block"></p>
<p>Joachim<br>Digitalarc — <a href="${sender.website}">${link}</a></p>
<hr style="border:none;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Vous recevez cet email car votre activite est referencee publiquement.
Pour ne plus etre contacte : repondez STOP ou <a href="${optoutUrl}">cliquez ici</a>.<br>${sender.company}</p>
</body></html>`;

  return { subject: subjectFor(p), text, html, screenshot: hasShot ? p.screenshot_url : null };
}

function main() {
  const crm = loadCrm();
  const all = [...crm.values()];
  const min = 7;

  const targets = all
    .filter((p) => (p.score ?? 0) >= min)
    .filter((p) => p.email_to && p.email_to.includes("@"))
    .filter((p) => FORCE || ["new", "screenshot_done", "email_generated"].includes(p.email_status))
    .slice(0, LIMIT);

  const noEmail = all.filter((p) => (p.score ?? 0) >= min && !(p.email_to || "").includes("@"));

  log.step(`Generation d'emails : ${targets.length} prospects`);
  if (noEmail.length) {
    log.warn(
      `${noEmail.length} qualifies SANS email (souvent les "sans site web"). ` +
        `Canal alternatif recommande : telephone. Liste -> data/emails/_sans_email.csv`
    );
  }

  const outDir = dataDir("emails");
  for (const p of targets) {
    const { subject, text, html, screenshot } = buildBody(p);
    const safe = p.place_id.replace(/[^a-z0-9]/gi, "_");
    fs.writeFileSync(path.join(outDir, `${safe}.html`), html, "utf8");
    fs.writeFileSync(path.join(outDir, `${safe}.txt`), text, "utf8");
    fs.writeFileSync(
      path.join(outDir, `${safe}.json`),
      JSON.stringify({ to: p.email_to, subject, place_id: p.place_id, screenshot }, null, 2),
      "utf8"
    );
    p.email_subject = subject;
    p.email_status = "email_generated";
  }

  // CSV des prospects sans email (pour prospection telephonique)
  if (noEmail.length) {
    const lines = ["title,profession,locality,phone,score,maps_url"];
    for (const p of noEmail)
      lines.push([p.title, p.profession, p.locality, p.phone, p.score, p.maps_url].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    fs.writeFileSync(path.join(outDir, "_sans_email.csv"), lines.join("\n"), "utf8");
  }

  saveCrm(crm);
  log.ok(`${targets.length} emails generes dans ${path.relative(ROOT, outDir)}`);
  log.info("Apercu d'un sujet : " + (targets[0] ? `"${targets[0].email_subject}"` : "(aucun)"));
  log.info("Etape suivante : envoi (node src/email/send.js --test puis --send).");
}

main();

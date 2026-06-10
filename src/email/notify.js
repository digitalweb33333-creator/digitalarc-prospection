// ============================================================
// Notification interne a Joachim (NOTIFY_EMAIL) via Resend
// ------------------------------------------------------------
// Pour CHAQUE reponse traitee, Joachim recoit un recap : le prospect,
// la classification, l'action prise (reponse auto envoyee / escalade /
// opt-out) et le texte exact envoye au prospect.
// ============================================================
import { sendViaResend } from "./resend-client.js";

const labelFor = {
  interested: "INTERESSE",
  price_objection: "OBJECTION PRIX",
  bad_timing: "PAS LE BON MOMENT",
  info_request: "DEMANDE D'INFO",
  unsubscribe: "DESINSCRIPTION (STOP)",
  not_interested: "PAS INTERESSE",
  unknown: "A QUALIFIER",
};

const fmt = (v) => (v === 0 ? "0" : v || "-");

// Construit l'objet + le texte de la notification.
export function buildNotification({ prospect: p, classification, action, incoming, reply }) {
  const cat = labelFor[classification.category] || classification.category;
  const lines = [
    `Reponse prospect traitee automatiquement.`,
    ``,
    `Classification : ${cat} (confiance: ${classification.confidence})`,
    `Action         : ${action}`,
    classification.signals?.length ? `Indices        : ${classification.signals.join(", ")}` : "",
    ``,
    `--- Prospect ---`,
    `Entreprise : ${fmt(p.title)}`,
    `Profession : ${fmt(p.profession)}`,
    `Ville      : ${fmt(p.locality)} (${fmt(p.country)})`,
    `Score      : ${fmt(p.score)}/10`,
    `Email      : ${fmt(p.email_to)}`,
    `Telephone  : ${fmt(p.phone)}`,
    `Site / Maps: ${fmt(p.website || p.maps_url)}`,
    ``,
    `--- Sa reponse ---`,
    `De    : ${fmt(incoming.from)}`,
    `Objet : ${fmt(incoming.subject)}`,
    `Recu  : ${fmt(incoming.date)} (boite ${fmt(incoming.mailbox)})`,
    ``,
    (classification.cleanBody || "").slice(0, 700) || "(corps vide)",
    ``,
  ];

  if (reply) {
    lines.push(
      `--- Reponse auto envoyee (objet: ${reply.subject}) ---`,
      reply.text,
      ``
    );
  } else {
    lines.push(`--- Aucune reponse auto envoyee (a traiter a la main) ---`, ``);
  }
  lines.push(`Repondez-lui depuis contact@digitalarc.fr si besoin.`);

  const subject =
    action === "auto_replied"
      ? `[AUTO-REPONSE ${cat}] ${fmt(p.title)} (${fmt(p.locality)})`
      : `[A TRAITER ${cat}] ${fmt(p.title)} (${fmt(p.locality)})`;

  return { subject, text: lines.filter((l) => l !== "").join("\n") };
}

// Envoie la notification. Renvoie le resultat Resend.
export async function sendNotification(args) {
  const to = process.env.NOTIFY_EMAIL || "joachim33333@outlook.fr";
  const { subject, text } = buildNotification(args);
  return sendViaResend({
    to,
    subject,
    text,
    replyTo: args.prospect?.email_to || undefined,
  });
}

# Conformite — Cold email B2B (FR / CH / BE / LU)

A lire avant d'activer l'envoi. Ce systeme prospecte des professionnels ;
les regles ci-dessous limitent le risque juridique et protegent la
delivrabilite des 4 boites Hostinger.

## RGPD (UE — France, Belgique, Luxembourg)

- **Base legale** : interet legitime pour la prospection B2B. L'email doit
  concerner l'activite professionnelle du destinataire (ex : un cabinet
  dentaire pour une offre de site web). C'est le cas ici.
- **Adresses generiques** (contact@, cabinet@) : prospection autorisee sans
  consentement prealable. **Adresses nominatives** (prenom.nom@) : plus
  sensibles, privilegier les adresses generiques quand elles existent.
- **Opt-out obligatoire** : chaque email DOIT contenir un moyen simple de se
  desinscrire (lien ou « repondez STOP »). Toute demande -> liste de suppression
  immediate, jamais recontacte.
- **Information** : indiquer qui vous etes (Digitalarc, coordonnees) et la
  source des donnees (Google Maps / annuaire public) si demande.
- **Droits** : traiter sans delai les demandes d'acces / suppression.

## Suisse (LPD + LCD)

- Le cold email B2B est tolere ; eviter le caractere trompeur, toujours offrir
  l'opt-out et une identification claire de l'expediteur.

## Belgique / Luxembourg

- Cadre RGPD identique a la France ; opt-out et identification obligatoires.

## A implementer dans le code (avant le module d'envoi)

- [ ] Champ `unsubscribe` + lien de desinscription dans chaque template email
- [ ] Liste de suppression (`data/suppression.json`) verifiee avant chaque envoi
- [ ] Mentions expediteur (raison sociale + adresse Digitalarc) en pied d'email
- [ ] Preference adresses generiques sur adresses nominatives
- [ ] Log d'envoi horodate (preuve de conformite + cap 400/jour)
- [ ] Respect d'un rythme realiste par boite SMTP (warm-up) pour la delivrabilite

## Bonnes pratiques delivrabilite (4 boites Hostinger)

- SPF + DKIM + DMARC configures sur le domaine.
- Warm-up progressif : ne pas envoyer 100/jour/boite des le 1er jour.
- Rotation reguliere, pas de pics, contenu varie (personnalisation par metier).

# Photo 360 Capture

Application web (PWA) pour prendre une série de photos guidées avec ton
smartphone Android et les assembler automatiquement en une seule image
360° équirectangulaire au format JPG, directement exploitable par le widget
Grist Pannellum. Tout tourne dans le navigateur, sans compte ni abonnement.

## Utilisation

Ouvre **`https://bigorneau15652.github.io/android/`** dans Chrome sur ton
téléphone, autorise l'accès à la caméra et aux capteurs de mouvement quand
Chrome le demande, puis dans le menu Chrome (⋮) → **Ajouter à l'écran
d'accueil** pour obtenir une icône comme une vraie application.

Le dépôt GitHub est **public** (nécessaire pour que GitHub Pages héberge
l'appli gratuitement) — c'est le code source de l'outil qui est visible,
jamais tes photos : celles-ci restent uniquement sur ton téléphone (voir
"Confidentialité" plus bas).

### Pourquoi pas en ouvrant le fichier directement

Android/Chrome bloque l'accès à la caméra et aux capteurs d'orientation si
la page n'est pas chargée depuis une adresse **sécurisée** (`https://...`)
ou **locale** (`http://localhost:...`) — ouvrir `index.html` directement
depuis le stockage du téléphone (`file://...`) ne fonctionnera pas. C'est
pour ça qu'il faut passer par l'URL GitHub Pages ci-dessus plutôt que
manipuler les fichiers sur le téléphone.

### Alternative sans passer par GitHub Pages (hors-ligne, via Termux)

Si tu préfères ne rien avoir en ligne, tu peux faire tourner l'appli
localement avec **Termux** (F-Droid) :
```
pkg install python
```
puis, après avoir téléchargé le code (bouton **Code → Download ZIP** sur la
page GitHub du dépôt, ou `git clone`), lance depuis le dossier de l'appli :
```
python -m http.server 8080
```
et ouvre `http://localhost:8080` dans Chrome sur le même téléphone. Il
faudra relancer cette commande à chaque utilisation (ou installer
`Termux:Boot` pour l'automatiser au démarrage).

## Comment ça marche

0. À la toute première utilisation, un court tutoriel en français
   (illustré, avec Suivant/Passer) explique comment bien tenir le
   téléphone pour obtenir la meilleure qualité. Il est ré-accessible à tout
   moment depuis l'accueil via **"ℹ️ Comment bien photographier ?"**.
1. **Nouvelle capture 360°** → l'appli demande la caméra et le gyroscope,
   puis affiche le flux caméra avec un viseur : un cadre bleu percé d'un
   trou à viser avec la mire blanche fixe au centre de l'écran.
2. Elle te guide vers une série de cibles réparties sur la sphère (par
   défaut : 3 rangées + zénith/nadir), en terminant chaque rangée avant de
   passer à la suivante. Pivote sur toi-même lentement, en tenant le
   téléphone à hauteur des yeux et bien droit.
3. Quand le cadre devient **blanc**, la photo est prise automatiquement (tu
   peux désactiver l'automatique dans Réglages et appuyer sur 📸
   toi-même).
4. Une fois toutes les cibles couvertes (ou en appuyant sur *Terminer
   maintenant*), l'appli assemble une image équirectangulaire unique et te
   montre un aperçu 360° interactif.
5. **Enregistrer** la garde dans *Mes photos 360* (stockée uniquement sur
   ce téléphone, dans le navigateur — jamais envoyée nulle part).
   **Envoyer par email / Partager** ouvre le sélecteur de partage natif
   d'Android : toutes tes applications installées capables de recevoir une
   image (WhatsApp, Gmail, Infomaniak Mail, K-9 Mail...) y apparaissent
   automatiquement, sans réglage à faire dans l'appli. **Télécharger le
   JPG** enregistre le fichier — si ton navigateur le permet, un sélecteur
   s'ouvre pour choisir toi-même le dossier (mémoire interne, carte SD...)
   et modifier le nom de fichier ; sinon il part directement dans
   *Téléchargements*.
6. **Mes photos 360** permet de revoir, renommer, supprimer, télécharger ou
   renvoyer par email n'importe quelle capture précédente, à tout moment,
   même hors ligne.

Le fichier produit est un **JPG classique** (image équirectangulaire) :
c'est exactement le format attendu par le widget Grist Pannellum que tu
utilises déjà — tu peux l'attacher directement, sans conversion.

## Limites à connaître

- L'assemblage utilise une reprojection géométrique (position + orientation
  du téléphone au moment de chaque photo) avec un léger fondu aux jonctions,
  **sans recherche automatique de points de correspondance** entre photos
  (contrairement à des outils comme Google Street View). Résultat : bon
  dans la majorité des cas, mais des jonctions légèrement visibles sont
  possibles si le cadrage n'est pas précis.
- Le champ de vision de l'objectif est **supposé** (réglable dans
  Réglages, 66° par défaut). S'il est mal réglé pour ton téléphone, les
  jonctions entre photos seront décalées — ajuste la valeur et refais un
  essai si besoin.
- Si tu désactives les photos zénith/nadir (plafond/sol), ces zones sont
  comblées en étirant les pixels les plus proches plutôt que d'être
  vraiment photographiées.

## Confidentialité

- Aucune donnée ne quitte ton téléphone : pas de compte, pas de serveur
  distant, pas d'analytics. Les photos 360 sont stockées localement dans le
  navigateur (IndexedDB) et ne sont envoyées nulle part sauf si tu choisis
  toi-même *Envoyer par email / Partager* ou *Télécharger*.
- Le dépôt GitHub est public (nécessaire pour l'hébergement gratuit via
  GitHub Pages) : seul le **code source** de l'outil est visible par
  quiconque le consulte sur GitHub, jamais tes photos ni les données de ton
  compte Grist.

## Licence des composants tiers

Le visualiseur 360° intégré (`vendor/pannellum/`) est la bibliothèque
[Pannellum](https://pannellum.org/), incluse sous licence MIT
(voir `vendor/pannellum/COPYING`).

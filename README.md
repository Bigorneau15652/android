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

## Choix de l'objectif et calibration

Un smartphone a plusieurs objectifs arrière (principal, ultra grand-angle,
téléobjectif) et chacun a un **angle de champ différent** — qui change
aussi d'un modèle de téléphone à l'autre. C'est cet angle qui détermine le
nombre de photos nécessaires et tous les calculs d'assemblage : une valeur
fausse produit des objets dupliqués.

Dans **Réglages** :
- **Objectif utilisé** liste les caméras arrière détectées sur le
  téléphone. La liste apparaît une fois l'autorisation caméra accordée.
- **Calibrer cet objectif** mesure automatiquement son angle de champ :
  tiens le téléphone droit et pivote lentement sur toi-même ; l'app prend
  16 images toute seule, puis calcule. Compte environ 30 secondes. La
  valeur est mémorisée **par objectif**, donc à faire une seule fois pour
  chacun.

Une fois un objectif calibré, tout s'adapte automatiquement : un ultra
grand-angle demandera moins de photos qu'un téléobjectif pour couvrir la
même sphère.

Si tu ne calibres pas, ce n'est pas bloquant : l'app part d'une valeur par
défaut et **mesure elle-même l'angle réel pendant le traitement de ta
première capture**, puis la mémorise pour cet objectif. La première photo
360 peut simplement être moins bien assemblée que les suivantes.

Si une calibration échoue, l'app le dit explicitement et conserve la valeur
précédente plutôt que d'enregistrer une mesure douteuse — refais un essai
dans un endroit éclairé avec des détails visibles, en pivotant lentement.

## L'écran d'accueil

L'accueil est la galerie : tes photos 360 s'y empilent en vignettes (environ
trois visibles à la fois, fais défiler pour voir les suivantes), la plus
récente en haut. L'interface est en icônes seules :

- **☰ en haut à gauche** : réglages (objectif, calibration, densité…).
- **? en haut à droite** : le tutoriel de prise de vue.
- **Rond foncé avec l'appareil photo, en bas à droite** : lance une
  nouvelle capture 360.
- **Petit rond clair à côté** : exporte / partage la **dernière** photo
  prise. Pour n'importe quelle autre, ouvre-la et utilise les boutons de la
  visionneuse.

## La visionneuse 360 (visite virtuelle)

Touche une vignette pour ouvrir la photo en plein écran :

- **Glisse un doigt** pour regarder autour de toi.
- **Pince à deux doigts** pour zoomer / dézoomer.
- **Bouton boussole en haut à droite** : active la *visite virtuelle* —
  bouge simplement le téléphone et l'image suit tes mouvements, comme si tu
  étais sur place. Retouche le bouton pour revenir au mode tactile. (Si le
  téléphone ne fournit pas les capteurs nécessaires, l'app te le dit et le
  mode tactile reste disponible.)
- En bas : envoyer la photo (JPG), **envoyer une visite virtuelle**,
  télécharger, renommer, supprimer.
- Juste au-dessus des boutons, un bandeau rappelle **où et quand** cette
  photo a été exportée pour la dernière fois (aussi visible en résumé sur
  sa vignette à l'accueil), pour ne plus avoir à s'en souvenir soi-même.

### Envoyer une visite virtuelle (sans compte, sans lien)

Le bouton globe (🌐) génère un **fichier web autonome** : la photo 360 et
le lecteur interactif complet sont intégrés dans un seul `.html` que tu
envoies comme n'importe quelle pièce jointe (email, WhatsApp...). La
personne qui le reçoit double-clique dessus et l'ouvre dans son
navigateur : elle peut glisser pour regarder autour et pincer pour
zoomer, exactement comme dans l'app — **sans rien installer, sans compte,
et même sans connexion internet**. C'est l'équivalent pratique d'un lien
de partage, sans avoir besoin d'un serveur en ligne.

## Comment ça marche

0. À la toute première utilisation, un court tutoriel en français
   (illustré, avec Suivant/Passer) explique comment bien tenir le
   téléphone pour obtenir la meilleure qualité. Il est ré-accessible à tout
   moment depuis l'accueil via **"ℹ️ Comment bien photographier ?"**.
1. **Nouvelle capture 360°** → l'appli demande la caméra et le gyroscope,
   puis affiche le flux caméra avec un viseur à trois jauges indépendantes,
   une par mouvement du téléphone, qui doivent toutes passer au vert en
   même temps pour déclencher la photo :
   - **L'anneau bleu** (au centre ou sur le côté avec une flèche s'il est
     hors champ) : oriente-toi (gauche/droite) jusqu'à ce que le point blanc
     fixe entre dedans.
   - **La barre du haut** : le niveau. Elle pivote avec le téléphone ;
     redresse-le jusqu'à ce qu'elle devienne verte fluo.
   - **La jauge verticale à droite** : l'inclinaison (haut/bas). Le repère
     glisse vers le haut ou le bas selon qu'il faut lever ou baisser le
     téléphone ; il devient vert fluo une fois dans la zone.
2. Elle te guide vers une série de cibles réparties sur la sphère (par
   défaut : 3 rangées + zénith/nadir), en terminant chaque rangée avant de
   passer à la suivante. Pivote sur toi-même lentement, en tenant le
   téléphone à hauteur des yeux et bien droit.
3. Quand les trois jauges sont **vertes**, la photo est prise automatiquement
   (tu peux désactiver l'automatique dans Réglages et appuyer sur 📸
   toi-même).
4. Une fois toutes les cibles couvertes (ou en appuyant sur *Terminer
   maintenant*), l'appli lance le **recalage** : elle compare les photos
   entre elles pour corriger la dérive du gyroscope, mesurer le vrai champ
   de vision de ton objectif, estimer sa distorsion et égaliser les
   luminosités, avant d'assembler l'image équirectangulaire. Compte de
   quelques secondes à une minute selon le nombre de photos ; une barre de
   progression indique l'étape en cours. Tu obtiens ensuite un aperçu 360°
   interactif.
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

## Pour obtenir la meilleure qualité

- **Garde le téléphone près de toi (20–30 cm), pas à bout de bras.** C'est
  le point le plus important. En pivotant, l'objectif décrit un cercle
  autour de ton axe de rotation : plus ce cercle est grand, plus les objets
  proches se décalent les uns par rapport aux autres d'une photo à l'autre
  (parallaxe). Aucun assemblage par rotation — ni le nôtre, ni celui des
  applis pro — ne peut corriger ça, et c'est ce qui produit des objets
  dédoublés.
- **Pivote sur place**, sans faire un pas de côté, pour la même raison.
- **Immobilise le téléphone** une fraction de seconde une fois la cible
  atteinte : l'app attend d'elle-même que le mouvement se calme (l'anneau
  passe en orange tant que ça bouge), mais un mouvement continu retarde
  chaque prise.
- **Évite les sujets qui bougent** (personnes qui marchent) : ils
  apparaîtront à plusieurs endroits, l'assemblage n'y peut rien.
- Les pièces très proches/exiguës sont le cas le plus difficile
  (la parallaxe y est maximale) ; recule-toi autant que possible du
  mobilier.

## Limites à connaître

- L'assemblage recale les photos les unes par rapport aux autres par
  corrélation d'image, mais **sans détection de points caractéristiques ni
  fondu multi-bandes** comme les moteurs professionnels. Résultat : bon
  dans la majorité des cas, mais des jonctions restent possibles sur des
  scènes très proches ou peu texturées.
- La parallaxe (voir ci-dessus) ne peut pas être corrigée, seulement
  minimisée par la façon de tenir le téléphone.
- Si tu désactives les photos zénith/nadir (plafond/sol), ces zones sont
  comblées en étirant les pixels les plus proches plutôt que d'être
  vraiment photographiées.
- Le recalage peut être désactivé dans Réglages pour un essai rapide, mais
  la qualité d'assemblage sera alors nettement moins bonne.

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

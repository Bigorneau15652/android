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
2. Elle te guide vers une série de cibles réparties sur la sphère, en
   terminant chaque rangée avant de passer à la suivante. Pivote sur
   toi-même lentement, en tenant le téléphone à hauteur des yeux et bien
   droit. Le nombre de rangées **et** de photos par rangée est calculé
   d'après l'angle de champ de ton objectif (environ 28 photos pour un
   objectif principal typique) : voir « Pourquoi autant de photos » plus
   bas.
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

## Quel mode choisir (important pour la qualité)

Dans **Réglages → Densité de la grille de capture** :

- **Panoramique cylindrique** — une seule rangée à hauteur des yeux, sans
  plafond ni sol (~10 photos pour un objectif principal). **C'est le mode à
  privilégier si ce qui t'intéresse, ce sont les murs** : tableaux, écrans,
  fenêtres, mobilier. Il évite d'un coup l'essentiel de ce qui rend une
  sphère complète difficile :
  - il n'y a **aucune rangée à recaler sur une autre** — la principale
    source d'erreur restante disparaît par construction ;
  - tes propres pieds n'apparaissent jamais ;
  - le sol et le plafond, qui sont à la fois les surfaces les plus proches
    de l'objectif et les plus obliques — donc de très loin les pires pour la
    parallaxe — ne sont simplement pas photographiés.

  Mesuré sur une scène de test : fidélité équivalente dans la bande des murs
  (0,835 contre 0,856 pour la sphère complète), mais **pire cas meilleur**
  (0,68 contre 0,61) et **netteté supérieure** (1,15 : chaque pixel final
  reçoit plus de pixels d'origine, puisque chaque photo couvre une zone plus
  petite). Le tout en 10 photos au lieu de 28 et 2,3 s de traitement au lieu
  de 12 s. En conditions réelles l'écart devrait être encore plus favorable,
  puisque le test de laboratoire ne simule pas la parallaxe, que ce mode
  réduit fortement.

  En contrepartie, plafond et sol sont comblés en étirant les pixels les plus
  proches au lieu d'être de vrais détails.

- **Standard — sphère complète** (~28 photos) : à choisir quand tu as
  réellement besoin de voir le plafond et le sol.

- **Rapide** / **Fine** : variantes plus légère et plus dense.

## Pourquoi autant de photos

Les rangées ne sont **pas** à un écart fixe : leur espacement est calculé
d'après l'angle de champ *vertical* de l'objectif, exactement comme
l'espacement horizontal l'est d'après l'angle horizontal.

C'est essentiel, et ça a été une vraie source de défauts. Une version
précédente espaçait les rangées de 45° quel que soit l'objectif. Or un
objectif principal typique (68° horizontal) ne voit que ~54° en vertical
sur un capteur 4:3 : deux rangées ne partageaient donc que **16%** de
contenu commun, contre 35% horizontalement — et avec un téléobjectif plus
étroit, elles ne se touchaient carrément plus.

Pourquoi ça compte : les rangées sont photographiées l'une après l'autre,
donc le gyroscope a déjà dérivé quand tu commences la suivante. Pour
annuler cette dérive, l'app doit comparer du contenu **commun** entre
rangées. Avec seulement 16% de recouvrement — moins les 2 à 3° d'erreur
que porte chaque photo — il ne restait presque rien à comparer, et les
rangées restaient décalées les unes par rapport aux autres. Le symptôme
visible : un même objet apparaissant à plusieurs hauteurs, chaque copie
décalée horizontalement d'une valeur différente (l'armoire en trois
exemplaires, plus à droite en haut, plus à gauche en bas).

Mesuré : **14° d'écart de lacet entre la rangée du haut et celle du bas,
contre 5° une fois les rangées correctement superposées** (erreur moyenne
d'orientation 4,7° → 2,8°). Le coût est d'environ 6 photos de plus (22 →
28 pour un objectif principal) — largement rentable.

## À propos du message « couverture incomplète »

La grille couvre **100% de la sphère en géométrie pure** — vérifié pour
tous les objectifs, et même en injectant plusieurs degrés d'erreur
d'orientation. En pratique la mesure tombe plutôt entre 97% et 99%, parce
que l'erreur d'orientation réelle de chaque photo grignote quelques
pour-cent, **presque exclusivement dans les tout derniers degrés autour du
zénith et du nadir**. Ces zones sont comblées en étirant les pixels
voisins, ce qui est invisible en pratique.

Ce n'était donc **pas** la cause des défauts d'assemblage, et il n'y a rien
à ajouter (ni photo supplémentaire, ni changement de focale) : chercher les
100% serait courir après un chiffre sans effet visible. Le seuil
d'avertissement a été abaissé de 97% à 92% en conséquence — il se
déclenchait quasiment à chaque capture pour un non-problème, ce qui noyait
les cas qui méritent vraiment ton attention.

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
  déformation locale** comme les moteurs professionnels : chaque photo ne
  peut être que *tournée*, jamais déformée localement. Résultat : bon dans
  la majorité des cas, mais des jonctions restent possibles sur des scènes
  très proches ou peu texturées.
- Le mélange entre photos qui se chevauchent se fait par **couture** : chaque
  pixel est pris presque entièrement à la photo qui le voit le mieux (la plus
  proche de son centre), et deux photos ne sont moyennées que sur une bande
  étroite le long de la jonction. Une version précédente pondérait selon la
  position absolue dans le cadre, ce qui moyennait deux photos à parts
  quasi égales (57/43) sur une grande partie de chaque zone de
  chevauchement : là où elles ne coïncidaient pas exactement, le détail
  était lavé jusqu'à rendre des objets méconnaissables. Mesuré : 9 marqueurs
  sur 12 conservaient au moins 60% de leur contraste, contre **12 sur 12**
  après correction.
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

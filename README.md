# Photo 360 Capture

Application web (PWA) privée pour prendre une série de photos guidées avec
ton smartphone Android et les assembler automatiquement en une seule image
360° équirectangulaire au format JPG, directement exploitable par le widget
Grist Pannellum. Tout tourne dans le navigateur, sans compte ni abonnement.

Ce dépôt est **privé** : lui seul (pas de GitHub Pages) contient le code.
Ne le rends jamais public si tu veux garder l'outil pour toi.

## Pourquoi il ne suffit pas d'ouvrir le fichier directement

Android/Chrome bloque l'accès à la caméra et aux capteurs d'orientation si
la page n'est pas chargée depuis une adresse **sécurisée** (`https://...`)
ou **locale** (`http://localhost:...`). Ouvrir `index.html` directement
depuis le stockage du téléphone (`file://...`) ne fonctionnera pas — ce
n'est pas un bug de l'appli, c'est une règle de sécurité du navigateur.

Comme le dépôt reste privé (pas de GitHub Pages), la solution la plus simple
est de faire tourner un tout petit serveur web **directement sur le
téléphone**, via l'application **Termux**, puis d'ouvrir
`http://localhost:8080` dans Chrome sur ce même téléphone. C'est gratuit,
ça ne nécessite aucune connexion internet une fois l'appli installée, et
rien ne sort de ton téléphone.

## Installation (une seule fois)

1. **Installe Termux** depuis F-Droid (la version Play Store est obsolète
   et ne fonctionne plus bien) : https://f-droid.org/packages/com.termux/
   → installe d'abord F-Droid, puis Termux depuis F-Droid.

2. Ouvre Termux et installe Python :
   ```
   pkg update
   pkg install python
   ```

3. Récupère les fichiers de l'appli. Le plus simple, **sans rien installer
   de plus** :
   - Sur le téléphone, ouvre `https://github.com/Bigorneau15652/android`
     dans Chrome (connecté à ton compte GitHub).
   - Bouton vert **Code** → **Download ZIP**. Le fichier atterrit dans le
     dossier *Téléchargements*.
   - Dans Termux, autorise l'accès au stockage puis dézippe :
     ```
     termux-setup-storage
     pkg install unzip
     cd ~/storage/downloads
     unzip android-main.zip -d ~/photo360
     ```
   - Les fichiers de l'appli se trouvent alors dans `~/photo360/android-main`.

   *(Alternative pour les mises à jour ultérieures : `git clone` avec un
   jeton d'accès personnel GitHub à la place du mot de passe — voir la
   section Mises à jour plus bas.)*

4. Lance le serveur local :
   ```
   cd ~/photo360/android-main
   python -m http.server 8080
   ```
   Laisse ce terminal Termux ouvert/actif en arrière-plan.

5. Ouvre Chrome sur le téléphone et va sur **`http://localhost:8080`**.
   Autorise l'accès à la caméra et aux capteurs de mouvement quand Chrome
   le demande.

6. Dans le menu Chrome (⋮) → **Ajouter à l'écran d'accueil**. Tu obtiens
   une icône comme une vraie application. Elle rouvrira toujours
   `localhost:8080` — il faut donc que le serveur Termux tourne pour que
   ça marche (voir "Utilisation au quotidien" ci-dessous).

## Utilisation au quotidien

À chaque fois que tu veux utiliser l'appli :

1. Ouvre Termux, lance :
   ```
   cd ~/photo360/android-main
   python -m http.server 8080
   ```
2. Ouvre l'icône *Photo360* installée sur ton écran d'accueil (ou
   `http://localhost:8080` dans Chrome).

Astuce avancée : le paquet `termux-boot` (Termux:Boot depuis F-Droid)
permet de lancer automatiquement le serveur au démarrage du téléphone, si
tu veux éviter cette étape manuelle.

## Mises à jour

Quand le code de l'appli est modifié sur GitHub, retélécharge le ZIP
(étape 3) dans un nouveau dossier, ou utilise `git` :
```
pkg install git
cd ~
git clone https://github.com/Bigorneau15652/android.git photo360-git
```
Git te demandera un identifiant GitHub + un **jeton d'accès personnel**
(Personal Access Token, à créer sur github.com → Settings → Developer
settings → Personal access tokens) à la place du mot de passe, car GitHub
n'accepte plus les mots de passe classiques en ligne de commande.

## Comment ça marche

1. **Nouvelle capture 360°** → l'appli demande la caméra et le gyroscope,
   puis affiche le flux caméra avec un viseur circulaire.
2. Elle te guide vers une série de cibles réparties sur la sphère (par
   défaut : 3 rangées + zénith/nadir). Tourne sur toi-même lentement, en
   tenant le téléphone bien vertical et droit (une barre en bas de l'écran
   devient verte quand il est de niveau).
3. Quand le viseur devient **vert**, la photo est prise automatiquement
   (tu peux désactiver l'automatique dans Réglages et appuyer sur 📸
   toi-même).
4. Une fois toutes les cibles couvertes (ou en appuyant sur *Terminer
   maintenant*), l'appli assemble une image équirectangulaire unique et te
   montre un aperçu 360° interactif.
5. **Enregistrer** la garde dans *Mes photos 360* (stockée uniquement sur
   ce téléphone, dans le navigateur). **Envoyer par email / Partager**
   ouvre le sélecteur de partage Android (Gmail, Mail, etc.) avec le JPG en
   pièce jointe. **Télécharger le JPG** l'enregistre dans le dossier
   Téléchargements du téléphone.
6. **Mes photos 360** permet de revoir, renommer, supprimer ou renvoyer par
   email n'importe quelle capture précédente, à tout moment, même hors
   ligne.

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
  toi-même *Envoyer par email / Partager*.
- Le dépôt GitHub est privé : garde-le ainsi si tu veux que l'outil reste
  strictement personnel.

## Licence des composants tiers

Le visualiseur 360° intégré (`vendor/pannellum/`) est la bibliothèque
[Pannellum](https://pannellum.org/), incluse sous licence MIT
(voir `vendor/pannellum/COPYING`).

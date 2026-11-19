# Dépannage : nextcloud-user-simulator

Ouvrez le dernier journal dans `logs/`, cherchez la **première** ligne `ERREUR`, `ÉCHEC` ou `ATTENTION`, puis la capture indiquée dans `artifacts/`. Pour isoler un problème, relancez avec 2 ou 3 utilisateurs et `"autoCleanup": false`. Voir aussi [README.md](README.md) et [INSTALL.md](INSTALL.md).

## Installation et lancement

| Symptôme | Cause | Solution |
|---|---|---|
| `npm ERR! code EBADENGINE` | Node.js plus ancien que la version 20. | Installer Node.js 20 ou plus ([INSTALL.md](INSTALL.md)). |
| Playwright signale un Chromium ou des bibliothèques manquants | Chromium ou ses dépendances système non installés. | `npx playwright install chromium`, puis `sudo npx playwright install-deps chromium` |
| `ERREUR: fichiers média manquants:` | Fichier absent de `mediaDir`, ou `mediaDir` faux. | Créer les fichiers listés ([INSTALL.md](INSTALL.md), section Médias). Aucun n’est exigé en `office`. |
| `mot de passe admin manquant` ou `mot de passe des comptes de test manquant` | Bloc `credentials` incomplet. | Renseigner `adminPassword` et `userPassword`, ou `NC_ADMIN_PASSWORD` et `NC_PASSWORD`. |
| `création userNN refusée: HTTP …` | HTTP 401 : identifiants admin faux. Autre code : mot de passe refusé par la politique de Nextcloud. | Vérifier le compte admin, ou choisir un `userPassword` plus robuste. |

## Connexion et appel Talk

| Symptôme | Cause | Solution |
|---|---|---|
| `userNN: ÉCHEC à l'étape "connexion"` | URL ou mot de passe faux, SSO ou second facteur à la place du formulaire Nextcloud, serveur saturé. | Vérifier `baseUrl` et `userPassword`. L’outil attend le formulaire de connexion standard. |
| `userNN: ÉCHEC à l'étape "clic sur le bouton d'appel"` | Bouton d’appel introuvable en 30 s : interface ni en français ni en anglais, libellé changé dans une nouvelle version de Talk. | Voir `artifacts/fail-userNN.png`. Adapter `SEL.startCall` et `SEL.joinCall` dans `lib/common.js`. |

## TURN et certificats

| Symptôme | Cause | Solution |
|---|---|---|
| `ERREUR: Certificat du serveur refusé (auto-signé, expiré ou autorité inconnue)` (avec un code comme `DEPTH_ZERO_SELF_SIGNED_CERT`), ou sur le follower avant `salon injoignable après 120 s` | Les certificats sont vérifiés par défaut et celui du serveur n’est pas reconnu. | Installer un certificat valide. Sur un serveur de test seulement, mettre `"insecureTls": true` dans `scenario.json` ou lancer avec `INSECURE_TLS=1`. Le réglage vaut aussi pour `GRAFANA_URL`. |
| `ATTENTION aucun serveur TURN <transport> disponible` ou `ATTENTION connexion sans relais TURN` | Talk n’annonce pas de serveur TURN pour le transport demandé par `turnTransport`. | Compléter la configuration TURN de Talk ou changer `turnTransport`. La ligne `serveurs TURN reçus` montre ce que Talk annonce. Pour `turns:` (TURN sur TLS), préférer un certificat d’une autorité reconnue. |

## Partage d’écran et édition

| Symptôme | Cause | Solution |
|---|---|---|
| `userNN: ÉCHEC partage d'écran (…)` | Bouton de partage introuvable dans cette version de Talk, ou `screen1.mp4` absent ou mal encodé. | Le journal liste les `boutons visibles`, capture dans `artifacts/share-userNN.png`. Réencoder le MP4 en H.264 baseline ([INSTALL.md](INSTALL.md)). |
| `userNN: ÉCHEC édition (éditeur introuvable (voir capture))` ou `Éditeur attendu : …, ouvert : …` | Aucun ou plusieurs connecteurs d’édition actifs, document non partagé, serveur Collabora Office injoignable. | N’activer qu’un connecteur dans Nextcloud, voir `artifacts/office-userNN.png`, ouvrir le document à la main avec le même compte. |
| `document Collabora toujours en chargement (ou en lecture seule) après 60 s` | Serveur d’édition ou PC de test saturé, ou document en lecture seule. | Moins d’éditeurs. Garder `"format": "docx"`. |

## Plusieurs PC

| Symptôme | Cause | Solution |
|---|---|---|
| `rsync introuvable` | `rsync` absent du PC leader ou d’un PC follower. `conductor.sh` en a besoin sur chaque PC. | Installer rsync sur chaque PC : `sudo apt install rsync`. |
| `follower.js absent` | Dossier du projet inexact dans `conductor.conf`, ou projet non installé / pas à jour sur ce PC. | Vérifier le dossier dans `conductor.conf` et l’installation ([INSTALL.md](INSTALL.md)). Mettre à jour ce PC (`git pull` ou `./conductor.sh --update`). |
| Médias absents ou différents (avec `conductor.sh`) | Les fichiers de `mediaDir` manquent ou diffèrent sur un PC distant. | Relancer `./conductor.sh` avec `--media` pour copier le dossier des médias. |
| `ERREUR: aucune URL de salon` ou `ERREUR: salon injoignable après 120 s` | `logs/rooms.json` absent ou périmé sur le follower (leader relancé depuis). | Copier le `rooms.json` du dernier lancement du leader. Voir les lignes `DIAGNOSTIC` et `artifacts/follower-salon-injoignable.png`. Avec `conductor.sh`, le script copie `rooms.json` tout seul. |
| Les PC ne démarrent pas ensemble, ou utilisateurs en double | `START_AT` absent ou sans fuseau, horloges non synchronisées, plages `USER_*` / `EDITOR_*` qui se chevauchent. | Même `START_AT` avec fuseau partout, horloges synchronisées par NTP, plages complémentaires. Avec `conductor.sh`, le départ est donné par `--delay` (défaut 180 s) ou, pour une heure convenue, par `--start-at` avec le fuseau. |

### Lancement manuel sur plusieurs PC : règles

- Les plages `USER_*` et `EDITOR_*` des différents PC ne doivent pas se chevaucher. Le follower exige `USER_FROM`, sauf en scénario `office`.
- Avec `editorsInCall: true`, les éditeurs font partie de l’appel : ils suivent `USER_*`. Avec des éditeurs hors appel, les répartir avec `EDITOR_FROM` et `EDITOR_TO`. Sans ces variables, le PC qui lance le dernier utilisateur de l’appel prend tous les éditeurs.
- En scénario `office`, le follower n’a pas besoin de `rooms.json`, mais exige `EDITOR_FROM` ou `EDITOR_TO`. Sans `logs/docs.json`, le document est ouvert par un clic dans la liste des fichiers.
- Ne pas relancer le leader en cours de test : il créerait d’autres salons et écraserait `rooms.json`.

## Charge du PC de test et nettoyage

| Symptôme | Cause | Solution |
|---|---|---|
| `ATTENTION: PC de test saturé (CPU N %, …)` | Le PC qui lance les navigateurs dépasse 85 % de CPU : chaque utilisateur est un Chromium complet. | Moins d’utilisateurs, ou un PC de plus (`USER_FROM` / `USER_TO`). Écarter les mesures prises pendant la saturation. |
| Comptes, salons ou documents encore présents, ou `dossier loadtest-docs toujours verrouillé après 60 s (HTTP 423)` | Nettoyage automatique désactivé ou ignoré, ou éditeur qui enregistre encore. | `node cleanup.js scenario.json` (attention : supprime **tous** les comptes `user` suivi de chiffres ; `--current-only` pour le seul test en cours). Si verrouillé : attendre quelques minutes, puis `--rooms-only`. |

Problème non listé ? Merci d'ouvrir un [ticket](https://github.com/aukfood/nextcloud-user-simulator/issues).

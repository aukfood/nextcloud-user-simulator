# nextcloud-user-simulator

L'outil **nextcloud-user-simulator** est un ensemble de scripts [Playwright](https://playwright.dev/) qui simule de vrais utilisateurs [Nextcloud](https://nextcloud.com/) pour mesurer la charge que supportent vos serveurs. Chaque utilisateur simulé est un navigateur [Chromium](https://www.chromium.org/) sans interface graphique (headless) : il se connecte, rejoint un appel [Nextcloud Talk](https://nextcloud.com/talk/) avec une fausse webcam et un faux micro, partage son écran ou édite un document dans [Collabora Office](https://www.collaboraonline.com/) ou Nextcloud Office ([Euro-Office](https://github.com/Euro-Office)). L'outil est développé avec l’aide d’assistants IA.

Le HPB (*High Performance Backend*) est le serveur de signalisation de Talk. TURN (*Traversal Using Relays around NAT*) est le relais qui fait passer l’audio et la vidéo quand une connexion directe est impossible.

Installation : [INSTALL.md](INSTALL.md). Dépannage : [TROUBLESHOOT.md](TROUBLESHOOT.md).

## Scénario et comportements

**Le scénario** est le fichier `scenario.json` que vous rédigez : instance visée, nombre d’utilisateurs, rythme d’arrivée, durée et rôle de chacun. Un même fichier rejoue le même test, pour comparer deux configurations de serveur. Le champ `scenarioType` vaut `talk` (appels seulement, par défaut), `office` (édition de documents seulement) ou `mixed` (les deux en même temps).

**Les comportements** sont les actions de chaque utilisateur simulé. Ils sont écrits dans le code : le scénario décide seulement qui fait quoi et quand.

| Comportement | Ce que fait l’utilisateur simulé | Réglé par |
|---|---|---|
| Rejoindre un appel | Se connecte (`user01`, `user02`…), rejoint le salon, reste jusqu’à la fin, puis quitte sans terminer l’appel pour tous. | `totalUsers`, `rooms`, `joinIntervalSec`, `durationSec` |
| Webcam et micro | Envoie une fausse caméra (`cam1.y4m` à `cam3.y4m`) et un faux micro (`audio1.wav` à `audio3.wav`). | `videoPercent`, `audioPercent` |
| Partager son écran | Diffuse `screen1.mp4` pendant une fenêtre de temps. | `screenShare` |
| Éditer un document | Tape en boucle « Charge de test userNN » dans son propre paragraphe d’un document partagé. | `office` |
| Passer par TURN | Force l’audio et la vidéo par le relais TURN, en UDP, TCP ou TLS si besoin. | `forceTurn`, `turnTransport` |

Un utilisateur sans webcam ou sans micro n’envoie rien sur la piste concernée. La messagerie de Talk n’est pas simulée, car sa charge est négligeable.

### Déroulé d’un test

1. **Préparation.** `leader.js` crée par l’API de Nextcloud les comptes `user01`…, les salons `loadtest-<date>-1`… et, si besoin, les documents `loadtest-doc-01.docx`… dans le dossier `loadtest-docs` du compte admin.
2. **Montée en charge.** `user01` arrive au départ (`START_AT` ou tout de suite), puis un utilisateur toutes les `joinIntervalSec` secondes, en alternance entre les salons.
3. **Plateau.** Il commence à l’arrivée du dernier utilisateur (`PHASE steady` dans le journal) et dure `durationSec` secondes. Le partage d’écran et l’édition démarrent `startAtSec` secondes après son début (en `office`, après le départ).
4. **Fin.** Chaque utilisateur quitte l’appel, puis le nettoyage est fait si `setup.autoCleanup` le demande.

Pendant le test, l’outil relève les statistiques WebRTC de chaque utilisateur et la charge du PC de test.

### Exemple de scénario commenté

Le format JSON (*JavaScript Object Notation*) n’accepte pas de commentaires. L’outil ignore donc toutes les clés qui commencent par `_` : elles servent de commentaires.

```json
{
  "_but": "Appel de 6 personnes dans 1 salon, dont 2 qui éditent un document pendant l'appel",
  "baseUrl": "https://<SERVEUR_NEXTCLOUD>",
  "credentials": {
    "adminUser": "<COMPTE_ADMIN>",
    "adminPassword": "<MOT_DE_PASSE_ADMIN>",
    "userPassword": "<MOT_DE_PASSE_DES_COMPTES_DE_TEST>"
  },
  "scenarioType": "mixed",

  "_appel": "user01 à user06 arrivent toutes les 5 s : le dernier arrive 25 s après le départ, puis le plateau dure 300 s",
  "totalUsers": 6,
  "rooms": 1,
  "joinIntervalSec": 5,
  "durationSec": 300,

  "_media": "50 % : un utilisateur sur deux du salon a la webcam (user02, user04, user06). 100 % : tout le monde a un micro",
  "videoPercent": 50,
  "audioPercent": 100,
  "mediaDir": "./media",
  "forceTurn": "off",
  "turnTransport": "any",

  "_partage": "Le premier utilisateur du salon (user01) partage son écran de 30 s à 90 s après le début du plateau",
  "screenShare": {
    "enabled": true,
    "sharers": 1,
    "file": "screen1.mp4",
    "startAtSec": 30,
    "durationSec": 60
  },

  "_edition": "1 document, 2 éditeurs. editorsInCall true : les 2 derniers de l'appel (user05, user06) éditent dans un second onglet sans quitter l'appel",
  "office": {
    "documents": 1,
    "editorsPerDocument": 2,
    "editorsInCall": true,
    "startAtSec": 60,
    "durationSec": 180,
    "joinIntervalSec": 1,
    "format": "docx",
    "editor": "auto"
  },

  "_preparation": "Garder comptes et salons après le test pour pouvoir les analyser",
  "setup": {
    "autoCleanup": false
  }
}
```

Avec ce scénario, les fichiers média exigés sont `cam1.y4m` à `cam3.y4m`, `audio1.wav` à `audio3.wav` et `screen1.mp4`. Le fichier `scenario.example.json` du dépôt contient un modèle complet, commenté de la même façon.

### Tous les paramètres du scénario

« Obligatoire » signifie que le test échoue ou se comporte mal si la clé manque.

| Paramètre | Valeurs | Défaut | Rôle |
|---|---|---|---|
| `baseUrl` | URL | obligatoire | Adresse de Nextcloud, sans `/` final. |
| `insecureTls` | `true`, `false` | `false` | `true` accepte un certificat auto-signé (navigateurs et appels à l’API). Réservé à un serveur de test. |
| `credentials.adminUser` | texte | `admin` | Compte admin qui crée et supprime comptes, salons et documents. |
| `credentials.adminPassword` | texte | obligatoire | Mot de passe de ce compte admin. |
| `credentials.userPassword` | texte | obligatoire | Mot de passe donné à tous les comptes de test. |
| `scenarioType` | `talk`, `office`, `mixed` | `talk` | Type de campagne (voir plus haut). |
| `totalUsers` | nombre | obligatoire en `talk` et `mixed` | Nombre d’utilisateurs dans les appels. En `office`, la valeur n’est pas utilisée pour l’appel, mais gardez la ligne. |
| `rooms` | nombre (1 ou plus) | obligatoire en `talk` et `mixed` | Nombre de salons Talk créés. |
| `joinIntervalSec` | secondes | obligatoire en `talk` et `mixed` | Délai entre l’arrivée de deux utilisateurs. |
| `durationSec` | secondes | obligatoire en `talk` et `mixed` | Durée du plateau après l’arrivée du dernier utilisateur. |
| `videoPercent` | 0 à 100 | 100 | Part des utilisateurs de **chaque salon** qui envoient la webcam. |
| `audioPercent` | 0 à 100 | 100 | Part des utilisateurs de **chaque salon** qui ont un micro actif. |
| `forceTurn` | `off`, `udp`, `relay`, `tcp` | `off` | `off` : connexions directes autorisées. `udp` ou `relay` : relais TURN obligatoire. `tcp` : ancien mode, peu fiable, préférer `turnTransport`. |
| `turnTransport` | `any`, `udp`, `tcp`, `tls` | `any` | Transport vers le serveur TURN. Avec `udp`, `tcp` ou `tls`, le relais est forcé même si `forceTurn` vaut `off`. |
| `mediaDir` | chemin | obligatoire en `talk` et `mixed` | Dossier des fichiers média, par exemple `./media`. |
| `metrics.statsIntervalSec` | secondes | 10 | Fréquence des relevés WebRTC et de la charge du PC de test. `0` désactive ces relevés, y compris l’alerte de saturation. |
| `screenShare.enabled` | `true`, `false` | `false` | Active le partage d’écran (ignoré en `office`). |
| `screenShare.sharers` | nombre | 1 | Nombre de partageurs **par salon** : les premiers arrivés de chaque salon. |
| `screenShare.file` | nom de fichier | `screen1.mp4` | Vidéo diffusée, cherchée dans `mediaDir`. |
| `screenShare.startAtSec` | secondes | obligatoire si le partage est actif | Début du partage, compté depuis le début du plateau. |
| `screenShare.durationSec` | secondes | obligatoire si le partage est actif | Durée du partage. |
| `office.documents` | nombre | 1 | Nombre de documents créés. |
| `office.editorsPerDocument` | nombre | 1 | Nombre d’éditeurs sur un même document. Total des éditeurs = `documents` × `editorsPerDocument`. |
| `office.editorsInCall` | `true`, `false` | `false` | En `mixed` seulement. `true` : les derniers utilisateurs de l’appel éditent dans un second onglet et restent en appel. `false` : les éditeurs sont des comptes en plus, hors appel. |
| `office.startAtSec` | secondes | 30 | Début de l’édition : après le début du plateau en `mixed`, après l’instant de départ en `office`. |
| `office.durationSec` | secondes | 120 | Durée d’édition de chaque éditeur. |
| `office.joinIntervalSec` | secondes | 1 | Délai entre l’ouverture du document par deux éditeurs. |
| `office.folder` | nom de dossier | `loadtest-docs` | Dossier du compte admin qui contient les documents. |
| `office.format` | `docx`, `odt` | `docx` | `docx` est édité par Collabora Office et par Nextcloud Office (Euro-Office). `odt` : Collabora Office seulement. |
| `office.editor` | `auto`, `collabora`, `nextcloud-office` | `auto` | Contrôle, pas un choix : Nextcloud ouvre l’éditeur de son connecteur actif. Avec une valeur autre que `auto`, l’édition échoue si un autre éditeur s’ouvre. |
| `setup.roomAccess` | `public`, `invite` | `public` | `public` : salon ouvert par lien à tout utilisateur connecté. `invite` : salon privé, les comptes de test y sont ajoutés. |
| `setup.concurrency` | nombre | 5 | Créations ou suppressions faites en parallèle par l’API. Baisser à 2 si le serveur sature. |
| `setup.autoCleanup` | `false`, `"ifSuccess"`, `true` | `false` | Nettoyage en fin de test par le leader. `"ifSuccess"` : seulement si tous les utilisateurs ont rejoint l’appel, y sont restés et si l’édition a réussi. |
| `setup.autoCleanupUsers` | `true`, `false` | `true` | Avec le nettoyage automatique, `false` garde les comptes et supprime le reste. |
| `setup.disableFirstRunWizard` | `true`, `false` | `true` | Désactive l’assistant de première connexion de Nextcloud, qui masque l’interface des comptes neufs. |

## Prérequis

- Une instance Nextcloud de test avec Talk, un HPB et un serveur TURN, et un serveur d’édition (Collabora Office ou Nextcloud Office (Euro-Office)) si vous testez l’édition, avec un seul connecteur d’édition actif. Sur une instance de production, il faut une autorisation claire et des ressources réservées.
- Un compte admin Nextcloud, et aucun compte réel nommé `user` suivi de chiffres : le nettoyage par défaut supprime **tous** ces comptes.
- Un ou plusieurs PC ou machines virtuelles Linux (par exemple Debian 13), avec [Node.js](https://nodejs.org/) 20 ou plus, Playwright et son Chromium, et [ffmpeg](https://ffmpeg.org/) pour créer les médias. [Grafana](https://grafana.com/) est optionnel.

## Installation rapide

Le détail est dans [INSTALL.md](INSTALL.md).

```bash
git clone https://github.com/aukfood/nextcloud-user-simulator.git
cd nextcloud-user-simulator
npm ci
npx playwright install chromium
cp scenario.example.json scenario.json
```

Renseignez `scenario.json` et créez les médias du dossier `media/` (commandes `ffmpeg` dans [INSTALL.md](INSTALL.md)). `scenario.json`, `.env`, `media/`, `logs/` et `artifacts/` sont exclus de git.

## Utilisation

```bash
node leader.js scenario.json
```

Le leader prépare l’instance, lance les utilisateurs, affiche un bilan, puis nettoie si `setup.autoCleanup` le demande. Pour un premier essai, gardez `"autoCleanup": false`. Un `Ctrl+C` fait quitter l’appel proprement à chacun.

| Script | Rôle |
|---|---|
| `leader.js` | Prépare l’instance, écrit `logs/rooms.json` et `logs/docs.json`, puis lance sa plage d’utilisateurs. |
| `follower.js` | Sur un PC supplémentaire : lit les salons préparés par le leader et lance sa plage. |
| `conductor.sh` | Depuis le PC leader : lance une campagne sur plusieurs PC. |
| `setup.js` | Prépare l’instance sans lancer de test. |
| `cleanup.js` | Supprime salons, comptes et documents de test. |

### Variables d’environnement (optionnelles)

| Variable | Rôle |
|---|---|
| `NC_ADMIN_USER`, `NC_ADMIN_PASSWORD`, `NC_PASSWORD` | Remplacent le bloc `credentials`, pour ne pas écrire les mots de passe dans `scenario.json`. |
| `START_AT` | Instant d’arrivée de `user01`, avec fuseau, par exemple `2026-11-10T15:00:00+01:00`. |
| `USER_FROM`, `USER_TO` | Plage d’utilisateurs lancée par ce PC. |
| `EDITOR_FROM`, `EDITOR_TO` | Plage des éditeurs hors appel lancés par ce PC. |
| `ROOMS_URLS` | Follower : URL des salons, à la place de `logs/rooms.json`. |
| `INSECURE_TLS` | `1` accepte un certificat auto-signé. Passe avant `insecureTls`. |
| `RUN_ID` | Impose l’identifiant du run. |
| `GRAFANA_URL`, `GRAFANA_TOKEN` | Annotations Grafana. |

Pour charger un fichier `.env` : `set -a; source .env; set +a`. `conductor.sh` le charge tout seul.

## Plusieurs PC

Si le journal affiche `ATTENTION: PC de test saturé`, répartissez les utilisateurs sur un PC supplémentaire. Chaque PC, leader et followers, doit avoir une installation fonctionnelle du projet (prérequis, dépendances et `git clone`, voir [INSTALL.md](INSTALL.md)) et une horloge synchronisée par NTP.

### Avec `conductor.sh`

Une seule fois, sur le PC leader :

```bash
ssh-keygen                                 # si le PC leader n’a pas encore de clé
ssh-copy-id <UTILISATEUR>@<PC_FOLLOWER>    # pour chaque PC follower
cp conductor.example.conf conductor.conf
```

`conductor.conf` indique quel PC lance quelle partie du test décrit par `scenario.json` : une ligne par PC avec la machine (`leader` pour le PC leader), le dossier du projet et la plage d’utilisateurs. `conductor.example.conf` donne un exemple par type de scénario.

```
leader                        -                          1 2
<UTILISATEUR>@<PC_FOLLOWER>   nextcloud-user-simulator   3 4
```

```bash
./conductor.sh --dry-run                              # affiche ce qui serait fait
./conductor.sh                                        # départ dans environ 3 minutes
./conductor.sh --delay 240                            # départ dans 4 minutes
./conductor.sh --start-at 2026-11-20T15:00:00+01:00   # heure fixe, fuseau obligatoire
```

Le script vérifie les PC, copie `scenario.json`, `.env` et les fichiers de `logs/`, lance tout le monde au même instant, puis rapatrie les journaux dans `logs/<pc>/`. Options utiles :

- `--media` copie les médias : nécessaire la première fois, sinon le script s’arrête.
- `--update` aligne le projet des followers sur le dépôt git, même après une copie manuelle. Le PC leader se met à jour à la main (`git pull`).
- `--no-cleanup` garde les données, même si `setup.autoCleanup` demande le nettoyage.

Codes de fin : 0 (complet), 2 (incomplet), 1 (erreur). Aide : `./conductor.sh --help`.

### Sans `conductor.sh`

Lancez le leader 2 à 3 minutes avant `START_AT`, copiez `logs/rooms.json` (et `logs/docs.json`) sur chaque follower dès qu’il est écrit, puis lancez les followers avec le même `START_AT` et des plages qui ne se chevauchent pas :

```bash
START_AT="2026-11-10T15:00:00+01:00" USER_FROM=1 USER_TO=2 node leader.js scenario.json     # PC leader
START_AT="2026-11-10T15:00:00+01:00" USER_FROM=3 USER_TO=4 node follower.js scenario.json   # PC follower
```

Le nettoyage automatique est alors ignoré : lancez `cleanup.js` à la fin. Les règles sur les éditeurs sont dans [TROUBLESHOOT.md](TROUBLESHOOT.md).

## Après un test

Les journaux sont dans `logs/`, les captures dans `artifacts/`. Les noms contiennent le nom du PC (ici `pclinux`) et l’identifiant du run.

Les journaux et mesures sont dans `logs/`, les captures d’écran dans `artifacts/`. Les noms de fichiers contiennent le nom du PC (ici `pclinux`) et l’identifiant du run.

| Fichier | Contenu |
|---|---|
| `pclinux-leader-<runId>.log`, `pclinux-follower-<runId>.log` | Journal du test. |
| `phases-pclinux-<runId>.jsonl` | Horodatage de chaque phase (`setup`, `ramp-up`, `steady`, `screenshare-start`, `office-start`, `teardown`, `end`…). |
| `stats-pclinux-<runId>.jsonl` | Statistiques WebRTC de chaque utilisateur (débits, pertes, gigue, images, type de connexion). |
| `client-pclinux-<runId>.jsonl` | Occupation du processeur (CPU), mémoire libre et charge du PC de test. |
| `run-pclinux-<runId>.json` | Réglages du run. **Attention : il contient la totalité de `scenario.json`, mots de passe compris.** |

```bash
node cleanup.js scenario.json                 # TOUS les salons loadtest-*, TOUS les comptes userNN, le dossier de documents
node cleanup.js scenario.json --current-only  # seulement ce qui a été créé pour ce scénario
node cleanup.js scenario.json --rooms-only    # garde les comptes
node cleanup.js scenario.json --users-only    # garde salons et documents
```

Avec Grafana (`GRAFANA_URL` et `GRAFANA_TOKEN`), chaque phase du test apparaît comme une annotation `nextcloud-user-simulator`. Le tableau de bord d’exemple `grafana/dashboard-nextcloud-user-simulator.json` attend [Prometheus](https://prometheus.io/) avec node_exporter (étiquette `vm`), cAdvisor et eturnal : adaptez les requêtes à votre supervision.

## Limites

- **Chaque utilisateur simulé est un Chromium complet** : la charge est réaliste, mais le PC de test sature vite. Au-delà de 85 % de CPU, l’outil écrit `ATTENTION: PC de test saturé` et les mesures côté serveur ne sont plus fiables.
- **Mesurer par paliers.** Lancez le même scénario avec 2, 4, 6 puis 8 utilisateurs : si la charge des serveurs augmente de façon linéaire, ces mesures suffisent pour extrapoler.
- **Interface en français ou en anglais.** Les boutons sont retrouvés par leurs libellés : une autre langue ou une nouvelle version de Talk ou des éditeurs peut casser un comportement. Les sélecteurs sont dans `lib/common.js` (objet `SEL`).
- **Certificats vérifiés par défaut.** Pour un certificat auto-signé, utilisez `"insecureTls": true` ou `INSECURE_TLS=1`, sur une instance de test seulement.
- **Pas de garantie de capacité.** Pour comparer deux tests, gardez les mêmes médias et le même scénario.

## Signaler un bug ou contribuer

En cas de problème, consultez d’abord [TROUBLESHOOT.md](TROUBLESHOOT.md). Pour signaler un bug ou proposer une amélioration, ouvrez un [ticket](https://github.com/aukfood/nextcloud-user-simulator/issues).

## Licence

Ce projet est publié sous licence [CC0 1.0 Universel](https://creativecommons.org/publicdomain/zero/1.0/deed.fr). Voir le fichier [LICENSE](LICENSE).

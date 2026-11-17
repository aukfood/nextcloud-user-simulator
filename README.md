# nextcloud-user-simulator

L'outil **nextcloud-user-simulator** est un ensemble de scripts [Playwright](https://playwright.dev/) qui simule de vrais utilisateurs [Nextcloud](https://nextcloud.com/) pour mesurer la charge que supportent vos serveurs. Chaque utilisateur simulé est un navigateur [Chromium](https://www.chromium.org/) sans interface graphique (headless) : il se connecte, rejoint un appel [Nextcloud Talk](https://nextcloud.com/talk/) avec une fausse webcam et un faux micro, partage son écran ou édite un document dans [Collabora Office](https://www.collaboraonline.com/) ou Nextcloud Office ([Euro-Office](https://github.com/Euro-Office)). L'outil est développé avec l’aide d’assistants IA.

Le HPB (*High Performance Backend*) est le serveur de signalisation de Talk et ses services associés. TURN (*Traversal Using Relays around NAT*) est le relais qui fait passer l’audio et la vidéo quand une connexion directe est impossible.

Installation : [INSTALL.md](INSTALL.md). Dépannage : [TROUBLESHOOT.md](TROUBLESHOOT.md).

## Scénario et comportements : les deux notions à connaître

Un test repose sur deux notions.

**Le scénario** est le fichier `scenario.json` que vous rédigez. Il décrit toute la campagne : quelle instance viser, combien d’utilisateurs simuler, à quel rythme ils arrivent, combien de temps dure le test et ce que fait chaque groupe d’utilisateurs. Un même fichier rejoue le même test, ce qui permet de comparer deux configurations de serveur. Le champ `scenarioType` choisit le type de campagne :

| `scenarioType` | Ce qui est simulé |
|---|---|
| `talk` (défaut) | Des appels Talk seulement : webcam, micro, partage d’écran. |
| `office` | De l’édition simultanée de documents seulement, sans appel. |
| `mixed` | Des appels et de l’édition de documents en même temps. |

**Les comportements** sont les actions que réalise chaque utilisateur simulé pendant le test. Ils sont écrits dans le code de l’outil : le scénario ne les programme pas, il décide seulement qui fait quoi et à quel moment.

| Comportement | Ce que fait l’utilisateur simulé | Réglé dans le scénario par |
|---|---|---|
| Rejoindre un appel | Se connecte avec son compte (`user01`, `user02`…), ouvre le salon Talk, clique sur « Démarrer l’appel » ou « Rejoindre l’appel », reste en appel jusqu’à la fin du test, puis clique sur « Quitter l’appel » (jamais « Terminer l’appel pour tous »). | `totalUsers`, `rooms`, `joinIntervalSec`, `durationSec` |
| Envoyer sa webcam | Envoie en vidéo le contenu d’un fichier `cam1.y4m` à `cam3.y4m`, utilisé comme fausse caméra. | `videoPercent` |
| Parler au micro | Envoie en audio le contenu d’un fichier `audio1.wav` à `audio3.wav`, utilisé comme faux micro. | `audioPercent` |
| Partager son écran | Diffuse la vidéo `screen1.mp4` comme un partage d’écran, pendant une fenêtre de temps donnée. | `screenShare` |
| Éditer un document | Ouvre un document partagé dans Nextcloud, place son curseur dans sa propre zone (un paragraphe par éditeur, pour que les éditeurs ne s’écrasent pas) et y tape en boucle la phrase « Charge de test userNN ». | `office` |
| Passer par le relais TURN | Oblige les flux audio et vidéo à passer par le serveur TURN, éventuellement avec un transport précis : UDP (*User Datagram Protocol*), TCP (*Transmission Control Protocol*) ou TLS (*Transport Layer Security*). | `forceTurn`, `turnTransport` |

Un utilisateur sans webcam ou sans micro n’envoie vraiment rien sur la piste concernée : l’outil retire cette piste au lieu de laisser Chromium envoyer sa mire de test. La messagerie instantanée de Talk n’est pas simulée, car sa charge est négligeable face aux flux audio et vidéo.

### Déroulé d’un test

1. **Préparation.** Le script `pc1-leader.js` crée par l’interface de programmation (API) de Nextcloud les comptes `user01`, `user02`…, les salons Talk `loadtest-<date>-1`, `loadtest-<date>-2`… et, si le scénario prévoit de l’édition, les documents `loadtest-doc-01.docx`… dans le dossier `loadtest-docs` du compte admin, partagés en modification avec leurs éditeurs.
2. **Montée en charge.** `user01` arrive à l’instant de départ (`START_AT` s’il est défini, sinon tout de suite), puis un nouvel utilisateur toutes les `joinIntervalSec` secondes. Les utilisateurs sont répartis en alternance entre les salons (`user01` dans le salon 1, `user02` dans le salon 2, etc.).
3. **Plateau.** Il commence à l’arrivée du dernier utilisateur (ligne `PHASE steady` du journal) et dure `durationSec` secondes. Le partage d’écran et l’édition démarrent `startAtSec` secondes après le début du plateau. En scénario `office`, il n’y a pas d’appel : l’édition démarre `office.startAtSec` secondes après l’instant de départ.
4. **Fin.** Chaque utilisateur quitte l’appel, les navigateurs sont fermés, puis le nettoyage est fait si `setup.autoCleanup` le demande.

Pendant tout le test, l’outil relève les statistiques WebRTC (*Web Real-Time Communication*, la technologie des appels dans le navigateur) de chaque utilisateur et la charge du PC qui lance les navigateurs.

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

- Une instance Nextcloud avec Talk, un HPB et un serveur TURN configurés comme en conditions réelles, et un serveur d’édition (Collabora Office ou Nextcloud Office (Euro-Office)) si vous testez l’édition. Un seul connecteur d’édition doit être actif.
- Une instance de test dédiée, de préférence. Un essai sur une instance de production demande une autorisation claire et des ressources réservées.
- Un compte admin Nextcloud : l’outil crée et supprime des comptes, des salons et des documents par l’API.
- Aucun compte réel nommé `user` suivi de chiffres : le nettoyage par défaut supprime **tous** ces comptes.
- Un ou plusieurs PC ou machines virtuelles Linux (par exemple Debian 13) pour lancer les navigateurs.
- [Node.js](https://nodejs.org/) 20 ou plus, Playwright et son Chromium, [ffmpeg](https://ffmpeg.org/) pour créer les fichiers média.
- [Grafana](https://grafana.com/) : optionnel.

## Installation rapide

Le détail (Node.js, Chromium, médias) est dans [INSTALL.md](INSTALL.md).

```bash
git clone https://github.com/aukfood/nextcloud-user-simulator.git
cd nextcloud-user-simulator
npm ci
npx playwright install chromium
cp scenario.example.json scenario.json
```

Renseignez ensuite `scenario.json` (URL, mots de passe, scénario) et créez les fichiers média du dossier `media/` (commandes `ffmpeg` dans [INSTALL.md](INSTALL.md)). Les fichiers `scenario.json` et `.env` et les dossiers `media/`, `logs/` et `artifacts/` sont exclus de git par `.gitignore`.

## Utilisation

### Lancer un test sur un PC

```bash
node pc1-leader.js scenario.json
```

Le leader prépare l’instance, lance les utilisateurs, affiche un bilan, puis nettoie si `setup.autoCleanup` le demande. Pour un premier essai, gardez `"autoCleanup": false` afin de pouvoir examiner comptes et salons. Un `Ctrl+C` fait quitter l’appel proprement à chaque utilisateur avant de fermer les navigateurs.

### Les scripts

| Script | Rôle |
|---|---|
| `pc1-leader.js` | Prépare l’instance (comptes, salons, documents), écrit `logs/rooms.json` et `logs/docs.json`, puis lance les utilisateurs de sa plage. |
| `pc2-follower.js` | Sur un PC supplémentaire : ne crée rien, lit les salons préparés par le leader et lance sa plage d’utilisateurs. |
| `setup.js` | Prépare l’instance comme le leader, sans lancer de test. |
| `cleanup.js` | Supprime salons, comptes et documents de test (voir « Nettoyage »). |

### Variables d’environnement (optionnelles)

| Variable | Rôle |
|---|---|
| `NC_ADMIN_USER`, `NC_ADMIN_PASSWORD`, `NC_PASSWORD` | Remplacent les valeurs du bloc `credentials`. Utile pour ne pas écrire les mots de passe dans `scenario.json`. |
| `START_AT` | Instant d’arrivée de `user01`, avec le fuseau horaire, par exemple `2026-11-10T15:00:00+01:00`. Sans fuseau, l’heure est lue en heure locale du PC. |
| `USER_FROM`, `USER_TO` | Plage d’utilisateurs lancée par ce PC (défaut : 1 à `totalUsers`). |
| `EDITOR_FROM`, `EDITOR_TO` | Plage de numéros de comptes des éditeurs hors appel lancés par ce PC. |
| `ROOMS_URLS` | Follower seulement : URL des salons séparées par des virgules, à la place de `logs/rooms.json`. |
| `INSECURE_TLS` | `1` accepte un certificat auto-signé, `0` force la vérification. Passe avant `insecureTls` du scénario. |
| `RUN_ID` | Impose l’identifiant du run, utilisé dans le nom des fichiers de `logs/`. |
| `GRAFANA_URL`, `GRAFANA_TOKEN` | Envoi d’annotations à Grafana (voir plus bas). |

Les scripts ne lisent pas le fichier `.env` tout seuls. Chargez-le dans le terminal avant le lancement :

```bash
cat > .env << 'ENVEOF'
GRAFANA_URL="https://<SERVEUR_GRAFANA>"
GRAFANA_TOKEN="<JETON_GRAFANA>"
ENVEOF

set -a; source .env; set +a
```

## Plusieurs PC

Un seul PC suffit tant qu’il ne sature pas. Si le journal affiche `ATTENTION: PC de test saturé`, répartissez les utilisateurs sur un PC supplémentaire, sinon les mesures côté serveur sont faussées.

Sur chaque PC : même version de l’outil, mêmes fichiers média, même `scenario.json`, horloge synchronisée par NTP (*Network Time Protocol*) et même `START_AT`. Lancez le leader 2 à 3 minutes avant `START_AT`, le temps de créer comptes et salons.

Exemple avec 4 utilisateurs répartis sur deux PC (remplacez l’horaire par un instant futur) :

```bash
# PC1 (leader) : prépare l'instance, puis lance user01 et user02
START_AT="2026-11-10T15:00:00+01:00" USER_FROM=1 USER_TO=2 node pc1-leader.js scenario.json
```

Dès que le journal du leader affiche `logs/rooms.json écrit`, copiez ce fichier (et `logs/docs.json` s’il existe) sur le second PC :

```bash
ssh <UTILISATEUR>@<PC2> "mkdir -p nextcloud-user-simulator/logs"
scp logs/rooms.json <UTILISATEUR>@<PC2>:nextcloud-user-simulator/logs/
# Si le scénario comporte de l'édition :
scp logs/docs.json <UTILISATEUR>@<PC2>:nextcloud-user-simulator/logs/
```

```bash
# PC2 (follower) : même START_AT, plage complémentaire
START_AT="2026-11-10T15:00:00+01:00" USER_FROM=3 USER_TO=4 node pc2-follower.js scenario.json
```

Règles à respecter :

- Les plages `USER_*` et `EDITOR_*` des différents PC ne doivent pas se chevaucher. Le follower exige `USER_FROM`, sauf en scénario `office`.
- Avec `editorsInCall: true`, les éditeurs font partie des utilisateurs de l’appel : ils suivent `USER_*`. Avec des éditeurs hors appel, répartissez-les avec `EDITOR_FROM` et `EDITOR_TO`. Sans ces variables, c’est le PC qui lance le dernier utilisateur de l’appel qui prend tous les éditeurs.
- En scénario `office`, le follower n’a pas besoin de `rooms.json`, mais il exige `EDITOR_FROM` ou `EDITOR_TO`. Le fichier `logs/docs.json` est optionnel : sans lui, le document est ouvert par un clic dans la liste des fichiers.
- Le nettoyage automatique du leader est ignoré dès qu’il ne lance qu’une partie des utilisateurs ou que `EDITOR_*` est défini : lancez `cleanup.js` à la fin. Ne relancez pas le leader en cours de test : il créerait d’autres salons et écraserait `rooms.json`.

## Après un test

Les journaux et mesures sont dans `logs/`, les captures d’écran dans `artifacts/`. Les noms de fichiers contiennent le nom du PC (ici `pclinux`) et l’identifiant du run.

| Fichier | Contenu |
|---|---|
| `pclinux-leader-<runId>.log`, `pclinux-follower-<runId>.log` | Journal du test. |
| `phases-pclinux-<runId>.jsonl` | Horodatage de chaque phase (`setup`, `ramp-up`, `steady`, `screenshare-start`, `office-start`, `teardown`, `end`…). |
| `stats-pclinux-<runId>.jsonl` | Statistiques WebRTC de chaque utilisateur (débits, pertes, gigue, images, type de connexion). |
| `client-pclinux-<runId>.jsonl` | Occupation du processeur (CPU), mémoire libre et charge du PC de test. |
| `run-pclinux-<runId>.json` | Réglages du run. **Attention : il contient la totalité de `scenario.json`, mots de passe compris.** |
| `rooms.json`, `docs.json` | Salons et documents créés, à copier sur les autres PC. |
| `artifacts/*.png` | Captures prises lors d’un échec ou pour contrôle (par exemple `fail-user03.png`, `office-user05-edition.png`). |

### Nettoyage

```bash
node cleanup.js scenario.json                 # TOUS les salons loadtest-*, TOUS les comptes userNN, le dossier de documents
node cleanup.js scenario.json --current-only  # seulement les salons de logs/rooms.json et les comptes de ce scénario
node cleanup.js scenario.json --rooms-only    # salons et documents, garde les comptes
node cleanup.js scenario.json --users-only    # comptes seulement, garde salons et documents
```

Par défaut, le nettoyage n’est pas limité au dernier test : il supprime tous les comptes `user` suivi de chiffres, même s’ils n’ont pas été créés par l’outil.

### Grafana (optionnel)

Avec `GRAFANA_URL` et `GRAFANA_TOKEN` (jeton de service autorisé à écrire des annotations), chaque phase du test apparaît comme une annotation sur les graphiques, avec l’étiquette `nextcloud-user-simulator`. Un échec d’annotation n’arrête pas le test.

Le tableau de bord d’exemple `grafana/dashboard-nextcloud-user-simulator.json` attend une source de données [Prometheus](https://prometheus.io/) avec les métriques de node_exporter (étiquette `vm`), des métriques de conteneurs au format cAdvisor et les métriques du serveur TURN eturnal. Adaptez les requêtes à votre supervision.

## Limites

- **Chaque utilisateur simulé est un Chromium complet** qui tourne sur le PC de test (l’injecteur). C’est ce qui rend la charge réaliste, mais l’injecteur sature vite.
- **Seuil de 85 % de CPU.** Au-delà, l’outil écrit `ATTENTION: PC de test saturé` dans le journal : les mesures côté serveur ne sont plus fiables. Réduisez le nombre d’utilisateurs ou ajoutez un PC.
- **Mesurer par paliers pour extrapoler.** Plutôt que de multiplier les PC, lancez le même scénario avec un nombre croissant d’utilisateurs (par exemple 2, 4, 6 puis 8) et relevez la charge des serveurs sur le plateau de chaque palier. Si elle augmente de façon linéaire, ces mesures à petite échelle suffisent pour extrapoler le dimensionnement d’une instance plus grande.
- **Interface en français ou en anglais.** L’outil retrouve les boutons de Talk et des éditeurs par leurs libellés français ou anglais. Une autre langue, ou une nouvelle version de Talk, Collabora Office ou Euro-Office qui change ces libellés, peut casser un comportement. Les sélecteurs sont regroupés dans `lib/common.js` (objet `SEL`).
- **Certificats vérifiés par défaut.** Le serveur Nextcloud, et Grafana si `GRAFANA_URL` est utilisé, doivent présenter un certificat valide. Pour un labo en certificat auto-signé, mettez `"insecureTls": true` dans `scenario.json` ou lancez avec `INSECURE_TLS=1` : la vérification est alors désactivée pour tout le processus et le journal l’indique au démarrage. À réserver à des instances de test.
- **Pas de garantie de capacité.** Les résultats dépendent de votre matériel, de votre réseau et de vos médias. Pour comparer deux tests, gardez les mêmes fichiers média et le même scénario.

## Signaler un bug ou contribuer

En cas de problème, consultez d’abord [TROUBLESHOOT.md](TROUBLESHOOT.md). Pour signaler un bug, proposer une amélioration ou une modification, merci d'ouvrir un [ticket](https://github.com/aukfood/nextcloud-user-simulator/issues).

## Licence

Ce projet est publié sous licence [CC0 1.0 Universel](https://creativecommons.org/publicdomain/zero/1.0/deed.fr). Voir le fichier [LICENSE](LICENSE).

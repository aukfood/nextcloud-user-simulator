# Installation : nextcloud-user-simulator

Cette page décrit comment installer l’outil. L’usage (scénarios, variables, lancement sur un ou plusieurs PC, nettoyage) est dans le [README.md](README.md). En cas de problème : [TROUBLESHOOT.md](TROUBLESHOOT.md).

Exemple de machine : Debian 13 en ligne de commande, sans interface graphique (Chromium tourne sans bureau).

## 1. Récupérer le projet

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates ffmpeg

git clone https://github.com/aukfood/nextcloud-user-simulator.git
cd nextcloud-user-simulator
```

Les scripts à lancer sont `conductor.sh`, `leader.js`, `follower.js`, `setup.js` et `cleanup.js`. L’édition de documents passe par `lib/office.js`. Le modèle de scénario est `scenario.example.json`.

Pour une campagne sur plusieurs PC avec `conductor.sh`, installez aussi rsync et le client SSH :

```bash
sudo apt-get install -y rsync openssh-client
```

## 2. Node.js 20 ou plus

Vérifiez avec `node -v`. Si la version est inférieure à 20, installez Node 22 (au choix : nvm, ou Node système avec NodeSource).

```bash
# nvm (dans le compte utilisateur)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22
node -v
```

```bash
# NodeSource (Node système)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 3. Dépendances et Chromium

Toujours depuis le dossier `nextcloud-user-simulator` :

```bash
npm ci
npx playwright install chromium
```

Si `package-lock.json` est absent, utilisez `npm install` à la place de `npm ci`. S’il manque des bibliothèques système :

```bash
sudo npx playwright install-deps chromium
```

## 4. Fichier de scénario

```bash
cp scenario.example.json scenario.json
```

Renseignez l’URL Nextcloud et les mots de passe. Les clés qui commencent par `_` sont des commentaires. Les notions de scénario et de comportements, un exemple commenté et la liste de tous les paramètres sont dans le [README.md](README.md).

## 5. Médias

Créez le dossier `media/` et indiquez-le dans `scenario.json` : `"mediaDir": "./media"`.

Noms attendus : `cam1.y4m` à `cam3.y4m`, `audio1.wav` à `audio3.wav`, `screen1.mp4`. En mode `office` seul, aucun média n’est nécessaire. Sinon, seuls les fichiers vraiment utilisés sont exigés.

Encodage, choisi pour rester proche d’une visio Talk typique :

- Webcam (`cam1.y4m` à `cam3.y4m`) : 1280×720, 30 images par seconde, yuv420p, fichier `.y4m` non compressé (format attendu par la fausse webcam). C’est une webcam HD classique.
- Micro (`audio1.wav` à `audio3.wav`) : 48 kHz, PCM 16 bits, mono. Un micro de visio est typiquement mono, et le fichier est deux fois plus léger qu’en stéréo pour le PC injecteur.
- Partage d’écran (`screen1.mp4`) : MP4, H.264 (profil baseline), yuv420p, 1280×720, **5 images par seconde**, sans piste audio. C’est réaliste pour un partage de slides ou de documents. Le navigateur envoie la vidéo à la cadence du fichier.

Les fichiers `.y4m` ne sont pas compressés : trois webcams 1280×720 à 30 i/s pendant 30 s pèsent environ 3,7 Go. Les mires et sons synthétiques ci-dessous servent à préparer l’outil. Pour des tests plus réalistes, préférez de vraies vidéos et de vrais sons, aux mêmes formats et encodages. Pour comparer des tests entre eux, gardez les mêmes fichiers.

### Génération

```bash
mkdir -p media && cd media

# Webcam 1280x720, 30 i/s, yuv420p
for i in 1 2 3; do
  ffmpeg -y -f lavfi -i "testsrc=size=1280x720:rate=30" -t 30 -pix_fmt yuv420p "cam${i}.y4m"
done

# Micro 48 kHz, PCM 16 bits, mono
for i in 1 2 3; do
  ffmpeg -y -f lavfi -i "sine=frequency=$((400 + i * 40)):sample_rate=48000" \
    -t 30 -ac 1 -c:a pcm_s16le "audio${i}.wav"
done

# Partage d'écran: MP4, H.264 baseline, yuv420p, 1280x720, 5 i/s, sans audio
ffmpeg -y -f lavfi -i "testsrc=size=1280x720:rate=5" -t 60 \
  -an -pix_fmt yuv420p -c:v libx264 -profile:v baseline -movflags +faststart screen1.mp4

cd ..
```

## 6. Collabora Office ou Nextcloud Office (Euro-Office)

Pour Collabora Office, rien à régler pour la page d’accueil ni la fenêtre d’avis : le script s’en occupe. N’activez pas le mode « home » de Collabora Office pour un test de charge : il limite à 20 connexions et 10 documents.

Pour Nextcloud Office (Euro-Office), rien à régler côté nextcloud-user-simulator. Dans Nextcloud, n’activez qu’un seul des deux connecteurs.

Pour lancer un test, voir le [README.md](README.md).

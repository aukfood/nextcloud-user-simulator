#!/usr/bin/env bash
# conductor.sh - lancer une campagne de test sur plusieurs PC, depuis le PC leader.
# Aucun mot de passe n'est passé en ligne de commande ni affiché : les identifiants
# restent dans le scénario et dans .env, copiés par SSH avec des droits restreints (600).

# Commandes distantes construites volontairement côté PC leader, .env chargé s'il existe :
# shellcheck disable=SC2029,SC2016,SC1091
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

CONF="conductor.conf"
SCENARIO="scenario.json"
DELAI=180            # secondes entre le lancement et START_AT (création des comptes et salons comprise)
START_AT_FORCE=""     # heure imposée par --start-at, prioritaire sur --delay
COPIER_MEDIAS=0
MAJ=0
NETTOYAGE=1          # 0 avec --no-cleanup
DRY_RUN=0
MARGE_FOLLOWER=45    # secondes laissées aux followers pour vérifier les salons avant START_AT
ATTENTE_FIN_MAX=900  # secondes d'attente maximale des followers après la fin du leader
INTERVALLE=15        # secondes entre deux vérifications de l'état des followers

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15)

usage() {
  cat << 'AIDE'
Usage : ./conductor.sh [options]

Lancer une campagne sur plusieurs PC depuis le PC leader : préparation, copie des fichiers,
départ synchronisé des followers, puis récupération des journaux.

Options :
  -c, --conf FICHIER      liste des PC (défaut : conductor.conf, modèle : conductor.example.conf)
  -s, --scenario FICHIER  fichier de scénario (défaut : scenario.json)
  -d, --delay SECONDES    délai avant le départ commun (défaut : 180, minimum 90)
      --start-at DATE     cas particulier : départ à une heure fixe, avec fuseau
                          (ex. 2026-11-20T15:00:00+01:00) ; prioritaire sur --delay
      --media             copier aussi le dossier des médias (nécessaire s'ils manquent ou diffèrent)
      --update            mettre à jour le projet des PC distants (git pull --ff-only)
                          avec l'utilisateur SSH de conductor.conf (jamais root).
                          Le PC leader n'est pas mis à jour : y faire git pull à la main avant.
      --no-cleanup        ne pas nettoyer à la fin, même si setup.autoCleanup le demande
      --dry-run           afficher les commandes sans rien lancer ni copier
  -h, --help              afficher cette aide

Nettoyage à la fin, comme leader.js, selon setup.autoCleanup : true = toujours
(sauf erreur du leader), "ifSuccess" = seulement si le test est complet sur tous
les PC, absent ou false = jamais. Jamais après Ctrl-C, une erreur du script, ou
des followers encore en cours. Codes de fin : 0 = complet, 2 = incomplet, 1 = erreur.

Prérequis : accès SSH par clé, projet et rsync installés sur chaque PC
(voir INSTALL.md), horloges synchronisées (NTP).
AIDE
}

info()  { printf '[conductor] %s\n' "$*"; }
warn()  { printf '[conductor] ATTENTION : %s\n' "$*" >&2; }
fatal() { printf '[conductor] ERREUR : %s\n' "$*" >&2; exit 1; }

run() {
  if (( DRY_RUN )); then
    printf '  +'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

while (( $# )); do
  case "$1" in
    -c|--conf)      CONF="${2:?--conf attend un fichier}"; shift 2 ;;
    -s|--scenario)  SCENARIO="${2:?--scenario attend un fichier}"; shift 2 ;;
    -d|--delay)     DELAI="${2:?--delay attend un nombre de secondes}"; shift 2 ;;
    --start-at)     START_AT_FORCE="${2:?--start-at attend une date}"; shift 2 ;;
    --media)        COPIER_MEDIAS=1; shift ;;
    --update)       MAJ=1; shift ;;
    --no-cleanup)   NETTOYAGE=0; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; fatal "option inconnue : $1" ;;
  esac
done

[[ "$DELAI" =~ ^[0-9]+$ ]] || fatal "--delay doit être un nombre de secondes"
(( DELAI >= 90 )) || fatal "--delay trop court ($DELAI s) : prévoir au moins 90 s pour la préparation"

command -v node  >/dev/null || fatal "Node.js introuvable sur ce PC (voir INSTALL.md)"
command -v ssh   >/dev/null || fatal "ssh introuvable sur ce PC (paquet openssh-client)"
command -v rsync >/dev/null || fatal "rsync introuvable sur ce PC. L'installer : sudo apt install rsync"
[[ -f "$SCENARIO" ]] || fatal "scénario $SCENARIO introuvable. Copier scenario.example.json en scenario.json puis le renseigner."
[[ -f "$CONF" ]] || fatal "fichier $CONF introuvable. Copier conductor.example.conf en $CONF puis le renseigner."
[[ -f leader.js && -f follower.js ]] || fatal "lancer ce script depuis le dossier du projet nextcloud-user-simulator"

# Lire dans le scénario : type, nombre d'utilisateurs, réglages de nettoyage, dossier des médias
# (mêmes règles que scenarioType() dans lib/common.js et que le nettoyage de leader.js).
read -r TYPE TOTAL_USERS AUTO_CLEANUP AUTO_CLEANUP_USERS MEDIA_DIR < <(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const t = String(c.scenarioType ?? "").toLowerCase();
  const type = ["talk", "office", "mixed"].includes(t) ? t : (c.office?.enabled ? "mixed" : "talk");
  const m = c.setup?.autoCleanup ?? false;
  const mode = m === true ? "true" : m === "ifSuccess" ? "ifSuccess" : m ? "inconnu" : "false";
  console.log(type, c.totalUsers ?? 0, mode, c.setup?.autoCleanupUsers === false ? "false" : "true", c.mediaDir || "./media");
' "$SCENARIO") || fatal "lecture de $SCENARIO impossible (JSON invalide ?)"
if [[ "$TYPE" == "office" ]]; then info "Scénario $SCENARIO : type office (édition seule, sans appel)."
else info "Scénario $SCENARIO : type $TYPE, $TOTAL_USERS utilisateur(s) en appel."; fi
# Options de cleanup.js équivalentes à l'auto-nettoyage de leader.js : seulement CE test
# (--current-only), et sans toucher aux comptes si setup.autoCleanupUsers vaut false (--rooms-only).
CLEANUP_OPTS=(--current-only); [[ "$AUTO_CLEANUP_USERS" == false ]] && CLEANUP_OPTS+=(--rooms-only)
if (( ! NETTOYAGE )); then info "Nettoyage automatique : désactivé (--no-cleanup)."
elif [[ "$AUTO_CLEANUP" == inconnu ]]; then
  warn "setup.autoCleanup a une valeur inconnue : aucun nettoyage automatique (valeurs possibles : true, \"ifSuccess\", false)."
else info "Nettoyage automatique : selon setup.autoCleanup ($AUTO_CLEANUP)."; fi

# Lecture de conductor.conf
# Une ligne par PC : cible_ssh dossier_distant USER_FROM USER_TO [EDITOR_FROM EDITOR_TO]
# "leader" (ou "local") = ce PC. "-" à la place d'une plage = pas de plage.
NOMS=(); CIBLES=(); DOSSIERS=(); UF=(); UT=(); EF=(); ET=()
LOCAL_IDX=-1
num='^[0-9]+$'
n=0
while IFS= read -r ligne || [[ -n "$ligne" ]]; do
  n=$((n + 1))
  ligne="${ligne%%#*}"
  read -r -a f <<< "$ligne" || true
  (( ${#f[@]} == 0 )) && continue
  (( ${#f[@]} == 4 || ${#f[@]} == 6 )) || fatal "$CONF ligne $n : 4 ou 6 colonnes attendues (cible dossier USER_FROM USER_TO [EDITOR_FROM EDITOR_TO])"
  cible="${f[0]}"; dossier="${f[1]}"; uf="${f[2]}"; ut="${f[3]}"; ef="${f[4]:--}"; et="${f[5]:--}"
  for paire in "$uf:$ut" "$ef:$et"; do
    a="${paire%%:*}"; b="${paire##*:}"
    if [[ "$a" == "-" && "$b" == "-" ]]; then continue; fi
    if [[ "$a" =~ $num && "$b" =~ $num ]] && (( a >= 1 && a <= b )); then continue; fi
    fatal "$CONF ligne $n : plage invalide \"$a $b\" (deux nombres, le premier inférieur ou égal au second, ou \"- -\")"
  done
  # Dossier distant : chemin relatif au dossier personnel ("~/" retiré pour ssh et rsync).
  dossier="${dossier#\~/}"; [[ "$dossier" == "~" ]] && dossier="."
  if [[ "$cible" == "leader" || "$cible" == "local" ]]; then
    (( LOCAL_IDX < 0 )) || fatal "$CONF ligne $n : une seule ligne \"leader\" (ou \"local\") autorisée"
    LOCAL_IDX=${#CIBLES[@]}
    nom="leader"
  else
    # Nom court du PC pour les dossiers logs/<pc>/ : partie après @, caractères simples seulement.
    nom="${cible##*@}"; nom="${nom//[^A-Za-z0-9._-]/_}"
    base="$nom"; k=2
    for existant in "${NOMS[@]}"; do [[ "$existant" == "$nom" ]] && { nom="$base-$k"; k=$((k + 1)); }; done
  fi
  NOMS+=("$nom"); CIBLES+=("$cible"); DOSSIERS+=("$dossier"); UF+=("$uf"); UT+=("$ut"); EF+=("$ef"); ET+=("$et")
done < "$CONF"

(( LOCAL_IDX >= 0 )) || fatal "$CONF : ajouter une ligne \"leader\" pour ce PC (\"local\" reste accepté)"
(( ${#CIBLES[@]} >= 2 )) || fatal "$CONF : aucun PC distant. Pour un seul PC, lancer simplement : node leader.js $SCENARIO"

verifier_chevauchement() { # $1 = libellé, puis tableaux de/à passés par nom
  local libelle="$1"; local -n de="$2"; local -n a="$3"; local i j
  for i in "${!de[@]}"; do
    [[ "${de[$i]}" == "-" ]] && continue
    for j in "${!de[@]}"; do
      (( j > i )) || continue
      [[ "${de[$j]}" == "-" ]] && continue
      if (( de[i] <= a[j] && de[j] <= a[i] )); then
        fatal "plages $libelle qui se chevauchent : ${NOMS[$i]} (${de[$i]}-${a[$i]}) et ${NOMS[$j]} (${de[$j]}-${a[$j]})"
      fi
    done
  done
}
verifier_chevauchement "USER" UF UT
verifier_chevauchement "EDITOR" EF ET

couverts=0
for i in "${!CIBLES[@]}"; do
  if [[ "$TYPE" == "office" ]]; then
    [[ "${EF[$i]}" != "-" ]] || fatal "scénario office seul : renseigner EDITOR_FROM EDITOR_TO pour ${NOMS[$i]} dans $CONF"
  else
    [[ "${UF[$i]}" != "-" ]] || fatal "scénario $TYPE : renseigner USER_FROM USER_TO pour ${NOMS[$i]} dans $CONF"
    (( UT[i] <= TOTAL_USERS )) || fatal "${NOMS[$i]} : USER_TO ${UT[$i]} dépasse totalUsers ($TOTAL_USERS) du scénario"
    couverts=$((couverts + UT[i] - UF[i] + 1))
  fi
  ligne="  ${NOMS[$i]} (${CIBLES[$i]}) :"
  [[ "${UF[$i]}" != "-" ]] && ligne+=" utilisateurs ${UF[$i]}-${UT[$i]}"
  [[ "${EF[$i]}" != "-" ]] && ligne+=" éditeurs ${EF[$i]}-${ET[$i]}"
  info "$ligne"
done
if [[ "$TYPE" != "office" ]]; then
  (( couverts == TOTAL_USERS )) || warn "les plages couvrent $couverts utilisateur(s) sur $TOTAL_USERS : certains ne seront pas lancés"
fi

# Préambule distant : charger nvm s'il existe (Node installé par nvm n'est pas chargé en SSH non interactif),
# puis se placer dans le dossier du projet.
preambule() { # $1 = dossier distant
  printf 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; cd %q || exit 3; ' "$1"
}
distant() { # $1 = index du PC, $2 = commande à lancer dans le dossier du projet
  if (( DRY_RUN )); then
    printf '  + ssh %s "cd %s && %s"\n' "${CIBLES[$1]}" "${DOSSIERS[$1]}" "$2"
  else
    ssh "${SSH_OPTS[@]}" "${CIBLES[$1]}" "$(preambule "${DOSSIERS[$1]}")$2"
  fi
}

# Copier des fichiers locaux vers un dossier relatif du projet distant.
# $1 = index, $2 = sous-dossier distant, $3 = mode (600 ou -), puis fichiers.
envoyer() {
  local i="$1" sous="$2" mode="$3"; shift 3
  local dest="${CIBLES[$i]}:${DOSSIERS[$i]}/$sous"
  local opts=(-a -e "ssh ${SSH_OPTS[*]}")
  [[ "$mode" == "600" ]] && opts+=(--chmod=F600)
  run rsync "${opts[@]}" "$@" "$dest"
}

# Rapatrier logs/ et artifacts/ d'un PC distant dans logs/<pc>/ et artifacts/<pc>/.
rapatrier() { # $1 = index
  local i="$1" nom="${NOMS[$1]}"
  info "Récupération des journaux de $nom dans logs/$nom/ et artifacts/$nom/"
  run mkdir -p "logs/$nom" "artifacts/$nom"
  run rsync -a -e "ssh ${SSH_OPTS[*]}" "${CIBLES[$i]}:${DOSSIERS[$i]}/logs/" "logs/$nom/" || warn "$nom : récupération de logs/ incomplète"
  run rsync -a -e "ssh ${SSH_OPTS[*]}" "${CIBLES[$i]}:${DOSSIERS[$i]}/artifacts/" "artifacts/$nom/" 2>/dev/null || true
}

info "Vérification des PC distants..."
EMPREINTE_LOCALE="$(cat leader.js follower.js lib/*.js | md5sum | cut -d' ' -f1)"
MEDIAS_HASH=""
if [[ -d "$MEDIA_DIR" ]]; then
  MEDIAS_LIST="$(find "$MEDIA_DIR" -maxdepth 1 -type f -printf '%f %s\n' | sort)"
  [[ -n "$MEDIAS_LIST" ]] && MEDIAS_HASH="$(find "$MEDIA_DIR" -maxdepth 1 -type f -printf '%f %s\n' | sort | md5sum | cut -d' ' -f1)"
fi

for i in "${!CIBLES[@]}"; do
  (( i == LOCAL_IDX )) && continue
  nom="${NOMS[$i]}"; cible="${CIBLES[$i]}"
  if (( DRY_RUN )); then
    distant "$i" "node -v; test -f follower.js; test -d node_modules/playwright; command -v rsync; date +%s"
    continue
  fi
  rapport="$(ssh "${SSH_OPTS[@]}" "$cible" "$(preambule "${DOSSIERS[$i]}")"'
    echo "node=$(node -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)"
    echo "projet=$( [ -f follower.js ] && echo 1 || echo 0)"
    echo "dependances=$( [ -d node_modules/playwright ] && echo 1 || echo 0)"
    echo "rsync=$(command -v rsync >/dev/null && echo 1 || echo 0)"
    echo "setsid=$(command -v setsid >/dev/null && echo 1 || echo 0)"
    echo "horloge=$(date +%s)"
    echo "empreinte=$(cat leader.js follower.js lib/*.js 2>/dev/null | md5sum | cut -d" " -f1)"
    echo "medias=$(find '"$(printf '%q' "$MEDIA_DIR")"' -maxdepth 1 -type f -printf "%f %s\n" 2>/dev/null | sort | md5sum | cut -d" " -f1)"
  ' 2>/dev/null)" || {
    rc=$?
    (( rc == 3 )) && fatal "$nom : dossier ${DOSSIERS[$i]} introuvable sur $cible. Installer le projet (voir INSTALL.md) ou corriger $CONF."
    (( rc == 255 )) && fatal "$nom : connexion SSH par clé impossible vers $cible. Faire une fois : ssh-copy-id $cible (puis tester : ssh $cible)"
    fatal "$nom : vérification impossible sur $cible (code $rc)"
  }
  val() { sed -n "s/^$1=//p" <<< "$rapport"; }
  v_node="$(val node)"; (( ${v_node:-0} >= 20 )) || fatal "$nom : Node.js 20 ou plus introuvable sur $cible (voir INSTALL.md)"
  [[ "$(val projet)" == 1 ]] || fatal "$nom : follower.js absent de ${DOSSIERS[$i]} sur $cible"
  [[ "$(val dependances)" == 1 ]] || fatal "$nom : dépendances absentes sur $cible. Y lancer : npm ci && npx playwright install chromium"
  [[ "$(val rsync)" == 1 ]] || fatal "$nom : rsync introuvable sur $cible. L'installer : sudo apt install rsync"
  [[ "$(val setsid)" == 1 ]] || fatal "$nom : commande setsid absente sur $cible (paquet util-linux)"
  h="$(val horloge)"; ecart=$(( ${h:-0} - $(date +%s) )); ecart=${ecart#-}
  (( ecart <= 2 )) || warn "$nom : horloge décalée de ${ecart} s par rapport à ce PC. Vérifier la synchronisation NTP."
  if (( ! MAJ )) && [[ "$(val empreinte)" != "$EMPREINTE_LOCALE" ]]; then
    warn "$nom : scripts différents de ceux de ce PC. Mettre à jour le projet sur $cible (git pull), ou relancer avec --update."
  fi
  # Médias absents ou différents : arrêter avant tout lancement (le follower refuserait de démarrer).
  if (( ! COPIER_MEDIAS )) && [[ -n "$MEDIAS_HASH" ]]; then
    [[ "$(val medias)" == "$MEDIAS_HASH" ]] || fatal "$nom : médias absents ou différents dans $MEDIA_DIR sur $cible. Relancer avec --media pour les copier. Rien n'a été lancé."
  fi
  info "  $nom : OK (Node $(val node))"
done

# Mise à jour des PC distants (--update). Lancée par SSH avec l'utilisateur de conductor.conf :
# jamais de root ni de sudo. Git ne doit rien demander (pas de mot de passe interactif).
GIT_SANS_QUESTION='export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes"; '
# Masquer un éventuel identifiant dans une URL affichée par git (https://identifiant@serveur).
masquer_url() { sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'; }

if (( MAJ )); then
  info "Mise à jour du projet sur les PC distants (git pull --ff-only)..."
  # 1) Vérifier TOUS les PC avant de mettre à jour le moindre d'entre eux.
  for i in "${!CIBLES[@]}"; do
    (( i == LOCAL_IDX )) && continue
    nom="${NOMS[$i]}"; cible="${CIBLES[$i]}"
    verif='command -v git >/dev/null || exit 12
      git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 10
      modifs="$(git status --porcelain)"; [ -z "$modifs" ] || { printf "%s\n" "$modifs" | head -5; exit 11; }'
    if (( DRY_RUN )); then distant "$i" "git status --porcelain"; continue; fi
    rc=0; sortie="$(distant "$i" "$verif" 2>&1)" || rc=$?
    case "$rc" in
      0)  ;;
      10) fatal "$nom : ${DOSSIERS[$i]} n'est pas un dépôt git sur $cible. Le réinstaller avec git clone (voir INSTALL.md) ou lancer sans --update. Rien n'a été lancé." ;;
      11) fatal "$nom : modifications locales dans ${DOSSIERS[$i]} sur $cible :
$sortie
Les enregistrer ou les annuler sur ce PC (git status), puis relancer. Rien n'a été lancé." ;;
      12) fatal "$nom : git introuvable sur $cible. Rien n'a été lancé." ;;
      *)  fatal "$nom : vérification git impossible sur $cible (code $rc). Rien n'a été lancé." ;;
    esac
  done
  # 2) Mettre à jour chaque PC, puis comparer l'empreinte des scripts (même appel SSH).
  for i in "${!CIBLES[@]}"; do
    (( i == LOCAL_IDX )) && continue
    nom="${NOMS[$i]}"; cible="${CIBLES[$i]}"
    maj="${GIT_SANS_QUESTION}"'avant="$(git rev-parse HEAD)"
      git pull --ff-only -q 2>&1 || exit 13
      apres="$(git rev-parse HEAD)"
      if [ "$avant" = "$apres" ]; then echo "etat=a_jour"; else
        echo "etat=mis_a_jour $(git rev-parse --short "$avant")..$(git rev-parse --short "$apres")"
        git diff --name-only "$avant" "$apres" -- package.json package-lock.json | sed "s/^/paquet=/"
      fi
      echo "empreinte=$(cat leader.js follower.js lib/*.js 2>/dev/null | md5sum | cut -d" " -f1)"'
    if (( DRY_RUN )); then distant "$i" "git pull --ff-only"; continue; fi
    rc=0; sortie="$(distant "$i" "$maj" 2>&1)" || rc=$?
    if (( rc != 0 )); then
      fatal "$nom : git pull --ff-only en échec sur $cible (réseau, conflit ou historique divergent) :
$(printf '%s\n' "$sortie" | masquer_url | tail -5)
Corriger sur ce PC (cd ${DOSSIERS[$i]} && git pull --ff-only), puis relancer. Rien n'a été lancé."
    fi
    etat="$(sed -n 's/^etat=//p' <<< "$sortie")"
    if [[ "$etat" == a_jour ]]; then info "  $nom : déjà à jour"
    else info "  $nom : mis à jour (${etat#mis_a_jour })"; fi
    if grep -q '^paquet=' <<< "$sortie"; then
      warn "$nom : dépendances modifiées ($(sed -n 's/^paquet=//p' <<< "$sortie" | paste -sd' ' -)). Lancer sur ce PC : cd ${DOSSIERS[$i]} && npm ci"
    fi
    empreinte="$(sed -n 's/^empreinte=//p' <<< "$sortie")"
    [[ "$empreinte" == "$EMPREINTE_LOCALE" ]]       || warn "$nom : scripts toujours différents de ceux de ce PC après la mise à jour. Le PC leader n'est sans doute pas à jour : y lancer git pull, puis relancer."
  done
fi

SCENARIO_DISTANT="${SCENARIO##*/}"
for i in "${!CIBLES[@]}"; do
  (( i == LOCAL_IDX )) && continue
  info "Copie du scénario$([[ -f .env ]] && echo ' et de .env') vers ${NOMS[$i]}"
  distant "$i" "mkdir -p logs"
  fichiers=("$SCENARIO"); [[ -f .env ]] && fichiers+=(.env)
  if [[ "$SCENARIO" != "$SCENARIO_DISTANT" ]]; then
    # Scénario rangé dans un sous-dossier : l'envoyer seul à la racine distante.
    envoyer "$i" "" 600 "$SCENARIO"
    fichiers=("${fichiers[@]:1}")
  fi
  (( ${#fichiers[@]} )) && envoyer "$i" "" 600 "${fichiers[@]}"
  if (( COPIER_MEDIAS )); then
    [[ -d "$MEDIA_DIR" ]] || fatal "dossier des médias $MEDIA_DIR introuvable sur ce PC"
    [[ "$MEDIA_DIR" != /* ]] || fatal "--media : mediaDir doit être un chemin relatif au projet (ex. ./media)"
    info "Copie des médias ($MEDIA_DIR) vers ${NOMS[$i]} (long au premier envoi)"
    parent="$(dirname "$MEDIA_DIR")"
    distant "$i" "$(printf 'mkdir -p %q' "$parent")"
    envoyer "$i" "$parent/" - "${MEDIA_DIR%/}"
  fi
done

if [[ -n "$START_AT_FORCE" ]]; then
  [[ "$START_AT_FORCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:?[0-9]{2})$ ]]     || fatal "--start-at : utiliser le format 2026-11-20T15:00:00+01:00 (fuseau obligatoire : Z, +01:00 ou +02:00 en été)"
  depart=$(date -d "$START_AT_FORCE" +%s 2>/dev/null) || fatal "--start-at invalide : $START_AT_FORCE"
  START_AT="$START_AT_FORCE"
  (( depart - $(date +%s) >= 90 )) || warn "START_AT dans moins de 90 s : la préparation risque de ne pas finir à temps"
else
  depart=$(( ($(date +%s) + DELAI + 9) / 10 * 10 ))
  START_AT="$(date -d "@$depart" '+%Y-%m-%dT%H:%M:%S%:z')"
fi
info "Départ commun : START_AT=$START_AT"

# Variables passées au leader ou à un follower (aucun secret ici).
variables() { # $1 = index -> "START_AT=... USER_FROM=... ..."
  local i="$1" v=("START_AT=$START_AT")
  [[ "${UF[$i]}" != "-" ]] && v+=("USER_FROM=${UF[$i]}" "USER_TO=${UT[$i]}")
  [[ "${EF[$i]}" != "-" ]] && v+=("EDITOR_FROM=${EF[$i]}" "EDITOR_TO=${ET[$i]}")
  printf '%s ' "${v[@]}"
}
# Variables de plage à vider avant de lancer (une valeur restée dans .env ou dans le terminal fausserait la répartition).
A_VIDER="USER_FROM USER_TO EDITOR_FROM EDITOR_TO ROOMS_URLS START_AT"

LEADER_PID=""
declare -A PID_DISTANT=()
LANCES=()
arreter() {
  trap - INT TERM
  echo
  warn "${1:-interruption} : arrêt du leader et des followers distants"
  if [[ -n "$LEADER_PID" ]]; then kill -TERM "$LEADER_PID" 2>/dev/null || true; fi
  for i in "${LANCES[@]}"; do
    # Le follower est lancé avec setsid : tuer tout son groupe (node et navigateurs).
    if ssh "${SSH_OPTS[@]}" "${CIBLES[$i]}" "kill -TERM -- -${PID_DISTANT[$i]} 2>/dev/null || kill -TERM ${PID_DISTANT[$i]} 2>/dev/null"; then
      info "  ${NOMS[$i]} : follower arrêté"
    else
      warn "${NOMS[$i]} : arrêt impossible. L'arrêter sur ce PC : pkill -f follower.js"
    fi
  done
  for i in "${LANCES[@]}"; do rapatrier "$i" || true; done
  warn "les comptes et salons de test restent sur l'instance. Nettoyer avec : node cleanup.js $SCENARIO"
  exit 130
}
trap 'arreter interruption' INT TERM

info "Lancement du leader sur ce PC ($(variables "$LOCAL_IDX" | sed 's/ $//'))"
if (( DRY_RUN )); then
  printf '  + (set -a; [ -f .env ] && . ./.env; set +a; unset %s; %snode leader.js %q) &\n' "$A_VIDER" "$(variables "$LOCAL_IDX")" "$SCENARIO"
else
  mkdir -p logs
  REPERE="$(mktemp)"
  trap 'rm -f "$REPERE"' EXIT
  read -r -a VARS_LEADER <<< "$(variables "$LOCAL_IDX")"
  (
    set -a; [[ -f .env ]] && . ./.env; set +a
    # shellcheck disable=SC2086
    unset $A_VIDER
    export "${VARS_LEADER[@]}"
    exec node leader.js "$SCENARIO"
  ) &
  LEADER_PID=$!

  info "Attente de la préparation (logs/rooms.json)..."
  until [[ -f logs/rooms.json && logs/rooms.json -nt "$REPERE" ]]; do
    kill -0 "$LEADER_PID" 2>/dev/null || { wait "$LEADER_PID" || true; fatal "le leader s'est arrêté pendant la préparation (voir son journal dans logs/)"; }
    if (( $(date +%s) >= depart - MARGE_FOLLOWER )); then
      kill -TERM "$LEADER_PID" 2>/dev/null || true
      fatal "préparation trop longue : START_AT trop proche. Relancer avec un délai plus grand (ex. --delay $((DELAI + 120))), puis nettoyer : node cleanup.js $SCENARIO"
    fi
    sleep 2
  done
  sleep 1
fi

for i in "${!CIBLES[@]}"; do
  (( i == LOCAL_IDX )) && continue
  nom="${NOMS[$i]}"
  a_copier=(logs/rooms.json); [[ -f logs/docs.json ]] && a_copier+=(logs/docs.json)
  info "Copie de ${a_copier[*]} vers $nom"
  if ! envoyer "$i" "logs/" - "${a_copier[@]}"; then arreter "$nom : copie impossible"; fi

  # Lancement détaché : setsid + nohup. Journal : logs/conductor-follower.out, code de fin : logs/conductor-follower.exit.
  commande="rm -f logs/conductor-follower.exit; set -a; [ -f .env ] && . ./.env; set +a; unset $A_VIDER; "
  commande+="$(variables "$i")setsid nohup sh -c 'node follower.js \"\$1\"; echo \$? > logs/conductor-follower.exit' sh $(printf '%q' "$SCENARIO_DISTANT") "
  commande+="> logs/conductor-follower.out 2>&1 < /dev/null & echo \$!"
  info "Lancement du follower sur $nom ($(variables "$i" | sed 's/ $//'))"
  if (( DRY_RUN )); then
    distant "$i" "$commande"
  else
    pid="$(distant "$i" "$commande")" || pid=""
    [[ "$pid" =~ ^[0-9]+$ ]] || arreter "$nom : lancement du follower impossible"
    PID_DISTANT[$i]="$pid"
    LANCES+=("$i")
  fi
done

# Nettoyage final (sur ce PC seulement, une seule fois). Même environnement que le leader (.env chargé).
nettoyer() {
  info "Nettoyage : node cleanup.js $SCENARIO ${CLEANUP_OPTS[*]}"
  if (( DRY_RUN )); then
    printf '  + (set -a; [ -f .env ] && . ./.env; set +a; node cleanup.js %q %s)\n' "$SCENARIO" "${CLEANUP_OPTS[*]}"
    return 0
  fi
  ( set -a; [[ -f .env ]] && . ./.env; set +a; exec node cleanup.js "$SCENARIO" "${CLEANUP_OPTS[@]}" )
}

if (( DRY_RUN )); then
  info "Fin de la campagne : attente du leader et des followers, puis récupération des journaux :"
  for i in "${!CIBLES[@]}"; do (( i == LOCAL_IDX )) || rapatrier "$i"; done
  if (( ! NETTOYAGE )); then info "Pas de nettoyage (--no-cleanup)."
  elif [[ "$AUTO_CLEANUP" == true ]]; then nettoyer
  elif [[ "$AUTO_CLEANUP" == ifSuccess ]]; then info "Si tous les PC finissent avec le code 0 :"; nettoyer
  else info "Pas de nettoyage automatique (setup.autoCleanup)."
  fi
  info "Mode --dry-run : rien n'a été lancé ni copié."
  exit 0
fi

info "Campagne lancée. Ctrl-C pour tout arrêter. Journal de chaque follower : logs/conductor-follower.out sur son PC."

etat_follower() { # $1 = index -> "en_cours", code de sortie, ou "injoignable"
  ssh "${SSH_OPTS[@]}" "${CIBLES[$1]}" "$(preambule "${DOSSIERS[$1]}")
    if kill -0 ${PID_DISTANT[$1]} 2>/dev/null; then echo en_cours;
    elif [ -f logs/conductor-follower.exit ]; then cat logs/conductor-follower.exit;
    else echo inconnu; fi" 2>/dev/null || echo injoignable
}

leader_rc=0
wait "$LEADER_PID" || leader_rc=$?
LEADER_PID=""
info "Leader terminé (code $leader_rc). Attente de la fin des followers..."

declare -A RESULTAT=()
fin_max=$(( $(date +%s) + ATTENTE_FIN_MAX ))
while :; do
  restants=0
  for i in "${LANCES[@]}"; do
    [[ -n "${RESULTAT[$i]:-}" ]] && continue
    e="$(etat_follower "$i")"
    case "$e" in
      en_cours|injoignable) restants=$((restants + 1)) ;;
      *) RESULTAT[$i]="$e"; info "  ${NOMS[$i]} : follower terminé (code $e)" ;;
    esac
  done
  (( restants == 0 )) && break
  if (( $(date +%s) >= fin_max )); then
    warn "$restants follower(s) toujours en cours après $ATTENTE_FIN_MAX s : journaux récupérés sans les attendre"
    break
  fi
  sleep "$INTERVALLE"
done

for i in "${LANCES[@]}"; do rapatrier "$i"; done

libelle() {
  case "$1" in
    0) echo "complet (code 0)" ;;
    2) echo "incomplet (code 2)" ;;
    "") echo "non terminé" ;;
    *) echo "erreur (code $1)" ;;
  esac
}
info "Bilan :"
info "  ${NOMS[$LOCAL_IDX]} : leader, $(libelle "$leader_rc")"
tous_ok=1; erreur=0; non_termine=0
[[ "$leader_rc" == 0 ]] || tous_ok=0
[[ "$leader_rc" == 0 || "$leader_rc" == 2 ]] || erreur=1
for i in "${LANCES[@]}"; do
  r="${RESULTAT[$i]:-}"
  info "  ${NOMS[$i]} : follower, $(libelle "$r")"
  [[ "$r" == 0 ]] || tous_ok=0
  [[ -n "$r" ]] || non_termine=1
  [[ -z "$r" || "$r" == 0 || "$r" == 2 ]] || erreur=1
done
# Code de fin du script : 0 = complet partout, 2 = incomplet, 1 = erreur ou PC non terminé.
if (( tous_ok )); then code_final=0; elif (( erreur || non_termine )); then code_final=1; else code_final=2; fi
info "Journaux : logs/ (ce PC) et logs/<pc>/ (PC distants)."

# Nettoyage, comme leader.js (setup.autoCleanup), jamais si un follower tourne encore.
manuel="node cleanup.js $SCENARIO"
if (( non_termine )); then
  warn "followers encore en cours ou sans résultat : pas de nettoyage. Après leur fin, lancer à la main : $manuel"
elif (( ! NETTOYAGE )); then
  info "Nettoyage désactivé (--no-cleanup) : comptes, salons et documents gardés. Pour supprimer : $manuel"
elif [[ "$AUTO_CLEANUP" == true && "$leader_rc" != 0 && "$leader_rc" != 2 ]]; then
  # Comme leader.js : une erreur du leader (code 1) arrête tout avant le nettoyage.
  warn "leader en erreur : pas de nettoyage automatique. Lancer à la main : $manuel"
elif [[ "$AUTO_CLEANUP" == true ]] || { [[ "$AUTO_CLEANUP" == ifSuccess ]] && (( tous_ok )); }; then
  rc_nettoyage=0; nettoyer || rc_nettoyage=$?
  if (( rc_nettoyage == 0 )); then info "Nettoyage terminé."
  else
    warn "nettoyage en échec (code $rc_nettoyage). Relancer à la main : $manuel ${CLEANUP_OPTS[*]}"
    (( code_final != 0 )) || code_final=1
  fi
elif [[ "$AUTO_CLEANUP" == ifSuccess ]]; then
  info "Test incomplet : pas de nettoyage automatique, données gardées pour analyse. Lancer ensuite à la main : $manuel"
else
  info "Pas de nettoyage automatique (setup.autoCleanup absent ou false). Pour supprimer : $manuel"
fi
exit "$code_final"

/**
 * lib/common.js (ESM) - helpers partagés par le leader et le follower.
 * Même API qu'avant, plus: mode TURN réel (relay), faux partage d'écran,
 * gestion du dialogue "Vérifier les périphériques", vérification d'entrée en appel.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPeerConnectionHook, installFakeScreenShare } from './browser-init.js';
import { RUN_ID } from './metrics.js';

export const HOSTNAME = os.hostname();

/**
 * Identifiants: bloc "credentials" de scenario.json (adminUser, adminPassword, userPassword).
 * Les variables d'environnement NC_ADMIN_USER / NC_ADMIN_PASSWORD / NC_PASSWORD, si définies,
 * ont priorité. À appeler une fois au démarrage de chaque script.
 */
export function applyCredentials(cfg) {
  const c = cfg.credentials || {};
  process.env.NC_ADMIN_USER ??= c.adminUser ?? 'admin';
  if (c.adminPassword) process.env.NC_ADMIN_PASSWORD ??= c.adminPassword;
  if (c.userPassword) process.env.NC_PASSWORD ??= c.userPassword;
}

/**
 * Certificat du serveur. Par défaut il est vérifié (certificat valide obligatoire).
 * "insecureTls": true dans scenario.json, ou INSECURE_TLS=1, accepte un certificat auto-signé
 * (navigateurs et appels à l'API). INSECURE_TLS=0 force la vérification. Réservé aux serveurs de test.
 */
export function insecureTls(cfg) {
  const v = (process.env.INSECURE_TLS ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'oui'].includes(v)) return true;
  if (['0', 'false', 'no', 'non'].includes(v)) return false;
  return cfg?.insecureTls === true;
}

/** À appeler une fois au démarrage, après makeLogger. */
export function applyTlsSetting(cfg, log) {
  if (!insecureTls(cfg)) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  log('ATTENTION: vérification des certificats DÉSACTIVÉE (insecureTls / INSECURE_TLS). Certificat auto-signé accepté. Réservé à un serveur de test.');
}

/** Texte d'aide si une erreur vient d'un certificat refusé, sinon chaîne vide. */
export function tlsHint(err) {
  const code = err?.cause?.code || err?.code || '';
  const text = `${code} ${err?.message || err || ''}`;
  if (!/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_CERT_|SSL/i.test(text)) return '';
  return 'Certificat du serveur refusé (auto-signé, expiré ou autorité inconnue). Installer un certificat valide, '
    + 'ou, sur un serveur de test seulement, mettre "insecureTls": true dans scenario.json (ou lancer avec INSECURE_TLS=1).';
}

const password = () => {
  const p = process.env.NC_PASSWORD;
  if (!p) throw new Error('mot de passe des comptes de test manquant: renseigner credentials.userPassword dans scenario.json');
  return p;
};

// ---------- Sélecteurs (à ajuster selon la version de Talk/Collabora) ----------
export const SEL = {
  loginUser: 'input[name="user"]',
  loginPass: 'input[name="password"]',
  loginSubmit: 'button[type="submit"], input[type="submit"]',
  startCall: 'button:has-text("Démarrer l\'appel"), button:has-text("Start call")',
  joinCall: 'button:has-text("Rejoindre l\'appel"), button:has-text("Join call")',
  leaveCall: 'button[aria-label*="Quitter"], button[aria-label*="Leave"], button:has-text("Quitter l\'appel"), button:has-text("Leave call")',
  newConversation: 'button[aria-label*="Créer une nouvelle conversation"], button[aria-label*="Create a new conversation"]',
  convNameInput: 'input[placeholder*="Nom de la conversation"], input[placeholder*="Conversation name"]',
  convCreateConfirm: 'button:has-text("Créer la conversation"), button:has-text("Create conversation")',
  screenShareBtn: 'button[aria-label*="Partager l\'écran"], button[aria-label*="Share screen"]',
  stopScreenShare: 'button[aria-label*="Arrêter le partage"], button[aria-label*="Stop screen"]',
  videoToggle: 'button[aria-label*="caméra"], button[aria-label*="camera"], button[aria-label*="vidéo"]',
  collaboraFrame: 'iframe[name="collaboraframe"], #richdocumentsframe, iframe[src*="richdocuments"]',
};

// ---------- Logger ----------
export function makeLogger(role) {
  fs.mkdirSync('logs', { recursive: true });
  // Même horodatage (RUN_ID) que les fichiers phases-/stats-/run-: faciles à rapprocher
  const file = path.join('logs', `${HOSTNAME}-${role}-${RUN_ID}.log`);
  return (msg) => {
    const line = `[${new Date().toISOString()}] [${HOSTNAME}] ${msg}`;
    console.log(line);
    fs.appendFileSync(file, line + '\n');
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Attend jusqu'à un instant absolu (ms epoch). Retourne tout de suite si déjà passé. */
export const sleepUntil = (ts) => sleep(Math.max(0, ts - Date.now()));

/**
 * Lit START_AT. Sans fuseau (ni "Z" ni "+01:00"), la date est interprétée en heure LOCALE de ce PC:
 * deux PC de fuseaux différents seraient décalés. On le signale et on affiche l'instant retenu.
 */
export function parseStartAt(value, log) {
  if (!value) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`START_AT invalide: "${value}" (exemple: 2026-11-03T10:00:00+01:00)`);
  if (!hasZone) log?.(`ATTENTION: START_AT "${value}" sans fuseau, lu en heure locale de ce PC. Utiliser "Z" ou "+01:00" pour aligner les PC.`);
  log?.(`START_AT = ${new Date(ms).toISOString()} (UTC)`);
  return ms;
}

// ---------- Type de scénario ----------
/**
 * scenarioType (scenario.json):
 *   "talk"   : appels seulement (webcam, partage d'écran), aucun document
 *   "office" : édition de documents seulement, sans appel (utilisateurs dédiés)
 *              (Collabora ou Nextcloud Office / Euro-Office, reconnu tout seul)
 *   "mixed"  : appels + édition de documents en même temps
 * Absent: "talk", ou "mixed" si l'ancien bloc office.enabled vaut true.
 * Toute autre valeur est ignorée comme inconnue → même repli (talk, ou mixed si office.enabled).
 */
export function scenarioType(cfg) {
  const t = String(cfg.scenarioType ?? '').toLowerCase();
  if (['talk', 'office', 'mixed'].includes(t)) return t;
  return cfg.office?.enabled ? 'mixed' : 'talk';
}
/** Nombre d'utilisateurs en appel (0 si scénario office seul). */
export const callUsers = (cfg) => (scenarioType(cfg) === 'office' ? 0 : cfg.totalUsers);

// ---------- Attribution déterministe ----------
// Comptes de test: user01..userNN. Vérifier que ces noms n'existent pas déjà sur l'instance.
export const userName = (i) => `user${String(i).padStart(2, '0')}`;
// Médias attendus dans mediaDir: cam1..3.y4m, audio1..3.wav, screen1.mp4.
export const camFile = (i, dir) => path.resolve(dir, `cam${((i - 1) % 3) + 1}.y4m`);
export const audioFile = (i, dir) => path.resolve(dir, `audio${((i - 1) % 3) + 1}.wav`);
/** Vidéo MP4 lue par le faux getDisplayMedia (scenario.screenShare.file, défaut screen1.mp4). */
export const screenFile = (cfg) =>
  path.resolve(cfg.mediaDir, cfg.screenShare?.file || 'screen1.mp4');
// Webcam (videoPercent), micro (audioPercent) et partageurs (screenShare.sharers) attribués PAR SALON.
// Les utilisateurs sont répartis en alternance (user01 -> salon 1, user02 -> salon 2, ...), comme dans runner.js;
// le calcul ne dépend que de l'index global et du nombre de salons: PC1 et PC2 obtiennent la même attribution sans se coordonner.
// Arrondi (cam/micro) et rang (partage) appliqués DANS chaque salon (1, 2, 3...).
const rankInRoom = (index, rooms = 1) => Math.floor((index - 1) / Math.max(1, rooms || 1)) + 1;
const pick = (rank, percent) => Math.floor((rank * percent) / 100) !== Math.floor(((rank - 1) * percent) / 100);
// absent = tout le monde a un micro
export function hasAudio(index, percent = 100, rooms = 1) { return pick(rankInRoom(index, rooms), percent); }
// videoPercent absent = tout le monde a la webcam (voulu)
export function hasVideo(index, percent = 100, rooms = 1) { return pick(rankInRoom(index, rooms), percent); }
/** Les "sharers" sont les `screenShare.sharers` premiers utilisateurs DE CHAQUE SALON (rang 1..N dans le salon; plafonné à la taille du salon). */
export function isSharer(index, cfg, rooms) {
  if (scenarioType(cfg) === 'office' || !cfg.screenShare?.enabled) return false;
  const n = Math.max(0, cfg.screenShare.sharers ?? 1);
  const r = Math.max(1, rooms ?? cfg.rooms ?? 1);
  return rankInRoom(index, r) <= n;
}
/** Nombre total de partageurs pour totalUsers / rooms (même règle que isSharer). */
export function countSharers(cfg, totalUsers, rooms) {
  let n = 0;
  for (let i = 1; i <= totalUsers; i++) if (isSharer(i, cfg, rooms)) n++;
  return n;
}

export function assertFiles(files, log) {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    log(`ERREUR: fichiers média manquants:\n  ${missing.join('\n  ')}`);
    log('Pas de repli sur la mire Chromium: cela fausserait les mesures. Arrêt.');
    process.exit(1);
  }
}

/** Liste des fichiers média requis pour la plage d'utilisateurs [from, to]. */
export function requiredMedia(cfg, from, to) {
  const files = new Set();
  if (scenarioType(cfg) === 'office') return []; // pas d'appel: aucun média
  for (let i = from; i <= to; i++) {
    if (hasAudio(i, cfg.audioPercent, cfg.rooms)) files.add(audioFile(i, cfg.mediaDir));
    if (hasVideo(i, cfg.videoPercent, cfg.rooms)) files.add(camFile(i, cfg.mediaDir));
    if (isSharer(i, cfg, cfg.rooms)) files.add(screenFile(cfg));
  }
  return [...files];
}

// ---------- Mode TURN ----------
/**
 * Deux réglages dans scenario.json:
 *
 * forceTurn (passer ou non par le relais):
 *   "off"          : comportement normal (candidats directs autorisés)
 *   "udp" / "relay": TURN only (iceTransportPolicy='relay'). NE choisit PAS le transport: utiliser turnTransport.
 *   "tcp"          : ancien mode: relay + UDP non proxifié interdit par Chromium (peu fiable, préférer turnTransport).
 *
 * turnTransport (transport vers le serveur TURN, filtre les serveurs annoncés par Talk):
 *   "any" (défaut) : tout ce que Talk annonce
 *   "udp"          : seulement turn:...?transport=udp
 *   "tcp"          : seulement turn:...?transport=tcp (TCP simple, sans TLS)
 *   "tls"          : seulement turns:... (TLS, ex. 443 ou 5349)
 *   Si turnTransport vaut udp, tcp ou tls, le relais est forcé même avec forceTurn "off".
 */
export function turnTransport(cfg) {
  const t = String(cfg.turnTransport ?? 'any').toLowerCase();
  return ['udp', 'tcp', 'tls'].includes(t) ? t : 'any';
}

export function turnMode(cfg) {
  const m = String(cfg.forceTurn ?? 'off').toLowerCase();
  if (m === 'tcp') return 'tcp';
  if (m === 'udp' || m === 'relay' || turnTransport(cfg) !== 'any') return 'relay';
  return 'off';
}

/** Journalise les serveurs TURN reçus de Talk et ceux réellement utilisés par ce navigateur.
 * @returns {Promise<boolean>} true si des serveurs ICE ont été relevés.
 */
export async function logTurnServers(session, log) {
  try {
    const info = await session.page.evaluate(() => window.__turnInfo);
    if (!info || !info.received.length) {
      // Normal si l'utilisateur est encore seul dans le salon: Talk ne crée les RTCPeerConnection (donc la liste ICE) qu'avec un pair.
      log(`${session.user}: pas encore de connexion média (seul dans le salon ou sans pair), serveurs TURN non relevés`);
      return false;
    }
    log(`${session.user}: serveurs TURN reçus: ${JSON.stringify(info.received)}`);
    if (info.transport !== 'any') {
      log(`${session.user}: serveurs retenus (turnTransport=${info.transport}${info.rewritten ? ', réécrit' : ''}): ${JSON.stringify(info.used)}`);
      if (!info.used.some((u) => /^turns?:/i.test(u))) log(`${session.user}: ATTENTION aucun serveur TURN ${info.transport} disponible: le relais échouera`);
    }
    return true;
  } catch { return false; /* diagnostic seulement */ }
}

// ---------- Lancement d'un utilisateur ----------
/**
 * @param audioFilePath null => aucun faux micro (éditeur hors appel)
 * @param screenFilePath chemin du MP4 de partage (uniquement pour les sharers), sinon null
 */
export async function launchUser({ index, cfg, videoFile, audioFilePath, screenFilePath = null, log }) {
  const mode = turnMode(cfg);
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  const insecure = insecureTls(cfg);
  if (insecure) args.push('--ignore-certificate-errors'); // certificat auto-signé accepté seulement si demandé
  if (audioFilePath) args.push(`--use-file-for-fake-audio-capture=${audioFilePath}`); // null = éditeur sans média
  if (videoFile) args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  // Mode "tcp": interdit l'UDP non proxifié (le relais se fait alors en TCP/TLS)
  if (mode === 'tcp') args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');

  const browser = await chromium.launch({ headless: true, args });
  // Le Chromium sans écran se présente comme "HeadlessChrome": Talk affiche alors une
  // bannière "navigateur non supporté" qui masque le bouton d'appel. On force un Chrome normal.
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const context = await browser.newContext({
    userAgent,
    ignoreHTTPSErrors: insecure, // false par défaut: certificat valide obligatoire
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 720 },
  });
  // Utilisateur SANS webcam et/ou SANS micro: Chromium (--use-fake-device) fournirait sinon sa mire verte et son bip comme
  // périphériques, et Talk les enverrait. On retire donc la piste concernée des demandes getUserMedia.
  if (!videoFile || !audioFilePath) {
    await context.addInitScript(({ noVideo, noAudio }) => {
      const md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) return;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (constraints) => {
        const c = { ...(constraints || {}) };
        if (noVideo && c.video) c.video = false;
        if (noAudio && c.audio) c.audio = false;
        if (!c.audio && !c.video) return Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
        return orig(c);
      };
    }, { noVideo: !videoFile, noAudio: !audioFilePath });
  }
  await installPeerConnectionHook(context, mode !== 'off', turnTransport(cfg)); // relay + filtre TURN + capture des stats
  if (screenFilePath) await installFakeScreenShare(context, cfg.baseUrl, screenFilePath);

  const page = await context.newPage();
  const user = userName(index);
  page.on('pageerror', (e) => log(`${user} pageerror: ${e.message}`));
  return { index, user, browser, context, page, inCall: false };
}

export async function login(page, baseUrl, user, log) {
  log(`${user}: connexion`);
  // Sur un PC chargé, la page de connexion ou la redirection peuvent être très lentes: 2 essais, délais généreux.
  // noWaitAfter: on ne laisse pas le clic attendre la navigation (c'est ce qui expirait sous charge), on attend l'URL nous-mêmes.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) log(`${user}: nouvel essai de connexion`);
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!new URL(page.url()).pathname.includes('/login')) break; // déjà connecté (session ou redirection)
      await page.fill(SEL.loginUser, user, { timeout: 60000 });
      await page.fill(SEL.loginPass, password(), { timeout: 60000 });
      await page.click(SEL.loginSubmit, { timeout: 60000, noWaitAfter: true });
      // Délai de 90 s après le clic de connexion; à ajuster selon le serveur.
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 90000 });
      break;
    } catch (e) {
      if (!new URL(page.url()).pathname.includes('/login') && page.url() !== 'about:blank') break; // la connexion a en fait réussi
      if (attempt === 2) throw e;
    }
  }
  log(`${user}: connecté`);
}

/**
 * Ferme les fenêtres modales qui bloquent l'interface (assistant de première connexion
 * de Nextcloud, nouveautés, etc.), fréquentes sur des comptes tout neufs.
 * À appeler après la connexion et après l'ouverture du salon.
 */
export async function dismissOverlays(page, user, log) {
  // Bannière "navigateur non supporté" (par sécurité, si elle apparaît malgré le user-agent)
  const banner = page.getByText(/not fully supported|pas entièrement pris en charge|n'est pas pleinement pris en charge/i).first();
  if (await banner.isVisible().catch(() => false)) {
    log(`${user}: bannière "navigateur non supporté" détectée, fermeture`);
    await banner.locator('xpath=ancestor::*[self::div or self::aside][.//button][1]').locator('button').last()
      .click({ timeout: 3000 }).catch(() => {});
    await sleep(500);
  }
  for (let k = 0; k < 4; k++) {
    const dlg = page.locator('[role="dialog"]:visible, .modal-mask:visible, #firstrunwizard:visible').first();
    if (!(await dlg.isVisible().catch(() => false))) return;
    const txt = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 80);
    log(`${user}: fenêtre modale détectée ("${txt}"), fermeture`);
    await page.keyboard.press('Escape');
    await sleep(800);
    if (await dlg.isVisible().catch(() => false)) {
      await page.locator('[role="dialog"] button[aria-label*="Fermer"], [role="dialog"] button[aria-label*="Close"], .modal-container__close, .modal-header__close')
        .first().click({ timeout: 3000 }).catch(() => {});
      await sleep(800);
    }
  }
}

/** Rejoint (ou démarre) l'appel, gère la boîte "Vérifier les périphériques", vérifie l'entrée. */
export async function joinCall(page, user, log) {
  const callBtn = `${SEL.startCall}, ${SEL.joinCall}`;
  const btn = page.locator(callBtn).first();
  await btn.waitFor({ state: 'visible', timeout: 30000 });
  await btn.click();

  // Dialogue optionnel: "Vérifier les périphériques" / "Check devices"
  const dialog = page.getByRole('dialog', { name: /Vérifier les périphériques|Check devices/i });
  if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await dialog.locator(callBtn).first().click();
  }

  // Vérification: le bouton "Quitter l'appel" doit apparaître
  const inCall = await page.locator(SEL.leaveCall).first()
    .waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
  log(inCall
    ? `${user}: appel rejoint`
    : `${user}: ATTENTION entrée en appel NON confirmée (vérifier SEL.leaveCall)`);
  return inCall;
}

// Motifs larges (FR/EN) pour retrouver les boutons de partage d'écran de Talk selon la version
const SHARE_START_RE = /(partag|share|screen ?shar|screenshar|diffus).*(écran|ecran|screen)|(écran|ecran|screen).*(partag|share)|screensharing/i;
const SHARE_STOP_RE = /(arrêt|arret|stop|disable|désactiv|desactiv|terminer|end)/i;

/** Liste les boutons visibles (aria-label / title / texte) pour diagnostiquer un sélecteur. */
async function dumpButtons(page, user, log) {
  try {
    const labels = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean));
    log(`${user}: boutons visibles: ${JSON.stringify([...new Set(labels)])}`);
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/share-${user}.png` }).catch(() => {});
  } catch { /* diagnostic seulement */ }
}

/** Retrouve le bouton "démarrer le partage": sélecteur SEL d'abord, puis motif large. */
async function findShareStartButton(page) {
  const direct = page.locator(SEL.screenShareBtn).first();
  if (await direct.count()) return direct;
  const handles = page.locator('button:visible, [role="menuitem"]:visible');
  const n = await handles.count();
  for (let i = 0; i < n; i++) {
    const el = handles.nth(i);
    const label = ((await el.getAttribute('aria-label')) || (await el.getAttribute('title')) || (await el.innerText().catch(() => '')) || '').trim();
    if (SHARE_START_RE.test(label) && !SHARE_STOP_RE.test(label)) return el;
  }
  return null;
}

export async function startScreenShare(page, user, log) {
  try {
    let btn = await findShareStartButton(page);
    if (!btn) {
      // Le bouton est peut-être dans un menu "Plus d'actions": on tente de l'ouvrir
      const more = page.locator('button[aria-label*="Plus d\'actions"], button[aria-label*="More actions"], button[aria-label*="Plus"]').last();
      if (await more.count()) { await more.click({ timeout: 3000 }).catch(() => {}); await sleep(500); btn = await findShareStartButton(page); }
    }
    if (!btn) throw new Error('bouton de partage introuvable');
    await btn.click({ timeout: 10000 });
    await page.waitForFunction(
      () => window.__shareTrack && window.__shareTrack.readyState === 'live',
      null, { timeout: 20000 },
    );
    log(`${user}: partage d'écran démarré`);
    return true;
  } catch (e) {
    log(`${user}: ÉCHEC partage d'écran (${e.message.split('\n')[0]}). Vérifier SEL.screenShareBtn et le MP4.`);
    await dumpButtons(page, user, log);
    return false;
  }
}

/** Retrouve le bouton "arrêter le partage": sélecteur SEL d'abord, puis motif large (FR/EN). */
async function findShareStopButton(page) {
  const direct = page.locator(SEL.stopScreenShare).first();
  if (await direct.count()) return direct;
  const els = page.locator('button:visible, [role="menuitem"]:visible');
  const n = await els.count();
  for (let i = 0; i < n; i++) {
    const el = els.nth(i);
    const label = ((await el.getAttribute('aria-label')) || (await el.getAttribute('title')) || (await el.innerText().catch(() => '')) || '').trim();
    if (/(écran|ecran|screen)/i.test(label) && SHARE_STOP_RE.test(label)) return el;
  }
  return null;
}

export async function stopScreenShare(page, user, log) {
  try {
    const stop = await findShareStopButton(page);
    if (!stop) throw new Error('absent');
    await stop.click({ timeout: 5000 });
    log(`${user}: partage d'écran arrêté`);
  } catch {
    // repli: arrêt direct de la piste. On liste les boutons pour ajuster SEL.stopScreenShare.
    await dumpButtons(page, user, log);
    await page.evaluate(() => window.__shareTrack?.stop()).catch(() => {});
    log(`${user}: bouton d'arrêt non trouvé, piste arrêtée directement`);
  }
}

/**
 * Quitte proprement l'appel: clic sur "Quitter l'appel" (jamais "Terminer pour tous"),
 * puis attend que Talk confirme (le bouton d'appel réapparaît).
 * Retourne 'ok' (sorti), 'absent' (n'était plus dans l'appel) ou 'echec'.
 */
export async function leaveCall(page, user, log) {
  try {
    const leaveBtn = page.locator(SEL.leaveCall).first();
    if (!(await leaveBtn.isVisible().catch(() => false))) return 'absent';
    await leaveBtn.click({ timeout: 10000 });
    // Modérateur: un menu peut proposer "Quitter l'appel" / "Terminer l'appel pour tous" => on prend le premier seulement
    if (await leaveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      const item = page.getByRole('menuitem', { name: /^(?!.*(tous|tout le monde|everyone|all)).*(quitter|leave)/i }).first();
      if (await item.isVisible({ timeout: 1500 }).catch(() => false)) await item.click({ timeout: 5000 }).catch(() => {});
    }
    // Confirmation: le bouton "Quitter" disparaît ou "Rejoindre/Démarrer l'appel" revient
    const done = await Promise.race([
      leaveBtn.waitFor({ state: 'hidden', timeout: 15000 }).then(() => true),
      page.locator(`${SEL.startCall}, ${SEL.joinCall}`).first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true),
    ]).catch(() => false);
    return done ? 'ok' : 'echec';
  } catch (e) {
    log(`${user}: sortie de l'appel en erreur (${e.message.split('\n')[0]})`);
    return 'echec';
  }
}

/** Ferme proprement chaque navigateur (contexte puis navigateur). */
export async function closeAll(users, log) {
  for (const u of users) {
    try { await u.context?.close(); } catch { /* déjà fermé */ }
    try { await u.browser.close(); } catch { /* déjà fermé */ }
  }
  log('Tous les navigateurs sont fermés');
}

/**
 * lib/office.js - charge d'édition de documents (Collabora ou Nextcloud Office / Euro-Office).
 *
 * scenario.json: "scenarioType": "talk" | "office" | "mixed" (voir common.js), et bloc "office":
 *   documents            : nombre de documents créés par setup (défaut 1)
 *   format               : "docx" (défaut: édité par Collabora ET par Nextcloud Office / Euro-Office) ou "odt" (Collabora seulement: Euro-Office n'édite pas l'ODT)
 *   editorsPerDocument   : nombre d'utilisateurs qui éditent le MÊME document (défaut 1)
 *   editorsInCall        : (mixed seulement) true = les DERNIERS utilisateurs de l'appel éditent dans un 2e onglet et restent en appel
 *                          false (défaut) = éditeurs = comptes EN PLUS des utilisateurs de l'appel (hors appel)
 *   startAtSec           : début de l'édition (après la montée en charge en mixed, après le départ en office) (défaut 30)
 *   durationSec          : durée d'édition par utilisateur (défaut 120)
 *   joinIntervalSec      : délai entre l'ouverture du document de deux éditeurs (défaut 1)
 *   folder               : dossier de l'admin qui contient les documents (défaut "loadtest-docs")
 *   editor               : contrôle (pas un forçage): "auto" (défaut) | "collabora" | "nextcloud-office"
 *                         si ≠ auto, l'étape échoue si Nextcloud a ouvert un autre éditeur
 *
 * Total d'éditeurs = documents x editorsPerDocument. Chaque éditeur écrit dans SA zone (paragraphe) du document,
 * pour qu'ils ne s'écrasent pas (vraie édition simultanée).
 */
import fs from 'node:fs';
import * as C from './common.js';
import { markPhase } from './metrics.js';
import { installCollaboraWelcomeSkip, installEuroOfficeTipsSkip } from './browser-init.js';

const pad = (n) => String(n).padStart(2, '0');

const EDITOR_VALUES = ['auto', 'collabora', 'nextcloud-office'];
export const editorLabel = (id) => ({ collabora: 'Collabora', 'nextcloud-office': 'Nextcloud Office', auto: 'auto', mixed: 'mixte' }[id] || id);

/** Calcule qui édite quoi. Pur calcul, utilisé par provision (création) et runner (exécution). */
export function officePlan(cfg) {
  const type = C.scenarioType(cfg);
  const c = cfg.office || {};
  const editor = String(c.editor ?? 'auto').toLowerCase();
  if (!EDITOR_VALUES.includes(editor)) {
    throw new Error(`office.editor: "${c.editor}" inconnu (auto, collabora ou nextcloud-office)`);
  }
  if (type === 'talk') return { enabled: false, extraUsers: 0, editors: [], editor };
  const documents = Math.max(1, c.documents ?? 1);
  const per = Math.max(1, c.editorsPerDocument ?? c.editors ?? 1); // "editors" = ancien nom, toléré
  // office seul: toujours des comptes dédiés. mixed: editorsInCall true = derniers users de l'appel, false = comptes en plus.
  const inCall = type === 'mixed' && (c.editorsInCall ?? c.mode === 'inCall');
  const mode = inCall ? 'inCall' : 'separate';
  const total = documents * per;
  const format = String(c.format || 'docx').toLowerCase();
  if (!['odt', 'docx'].includes(format)) throw new Error(`office.format: "${c.format}" inconnu (odt ou docx)`);
  if (inCall && total > cfg.totalUsers) {
    throw new Error(`office.editorsInCall: ${total} éditeurs (documents x editorsPerDocument) mais seulement ${cfg.totalUsers} utilisateurs dans l'appel`);
  }
  const first = inCall ? cfg.totalUsers - total + 1 : C.callUsers(cfg) + 1;
  const editors = Array.from({ length: total }, (_, k) => ({
    index: first + k, user: C.userName(first + k), doc: Math.floor(k / per) + 1, slot: k % per,
  }));
  return {
    enabled: true, type, mode, documents, per, total, editors, format, editor,
    extraUsers: inCall ? 0 : total,
    // Dossier et noms des documents: office.folder (défaut 'loadtest-docs') et loadtest-doc-NN.odt|docx.
    folder: c.folder || 'loadtest-docs',
    fileName: (d) => `loadtest-doc-${pad(d)}.${format}`,
  };
}

/** Nombre total de comptes à créer / supprimer: participants de l'appel + éditeurs dédiés. */
export const totalAccounts = (cfg) => C.callUsers(cfg) + officePlan(cfg).extraUsers;

// ---------- Génération d'un .odt valide, sans dépendance (zip "stored") ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zipStored(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** .odt avec un paragraphe par éditeur ("Zone 1 :", "Zone 2 :"...). */
export function makeOdt(zones, title) {
  const paras = Array.from({ length: zones }, (_, k) => `<text:p>Zone ${k + 1} :</text:p>`).join('');
  const content = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">'
    + `<office:body><office:text><text:p>${title}</text:p>${paras}</office:text></office:body></office:document-content>`;
  const manifest = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
    + '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>'
    + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>';
  return zipStored([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text') }, // doit être la 1re entrée
    { name: 'META-INF/manifest.xml', data: Buffer.from(manifest) },
    { name: 'content.xml', data: Buffer.from(content) },
  ]);
}

const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** .docx minimal (OOXML) avec le même contenu que makeOdt: un titre puis un paragraphe "Zone N :" par éditeur. */
export function makeDocx(zones, title) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`;
  const paras = Array.from({ length: zones }, (_, k) => p(`Zone ${k + 1} :`)).join('');
  const types = xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '</Types>';
  const rels = xml + `<Relationships xmlns="${PR}">`
    + `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = xml + `<Relationships xmlns="${PR}">`
    + `<Relationship Id="rId1" Type="${R}/settings" Target="settings.xml"/></Relationships>`;
  // compatibilityMode 15 (= Word 2013+): évite que l'éditeur ouvre le fichier en "mode de compatibilité".
  const settings = xml + `<w:settings xmlns:w="${W}"><w:compat>`
    + '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>'
    + '</w:compat></w:settings>';
  const doc = xml + `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${p(title)}${paras}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
  return zipStored([
    { name: '[Content_Types].xml', data: Buffer.from(types) },
    { name: '_rels/.rels', data: Buffer.from(rels) },
    { name: 'word/document.xml', data: Buffer.from(doc) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels) },
    { name: 'word/settings.xml', data: Buffer.from(settings) },
  ]);
}

/** Contenu et type MIME du document de charge selon office.format (utilisé par provision.js). */
export const DOC_MIME = {
  odt: 'application/vnd.oasis.opendocument.text',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export function makeDocument(format, zones, title) {
  return format === 'docx' ? makeDocx(zones, title) : makeOdt(zones, title);
}

// ---------- Édition d'un document ----------
// Deux éditeurs reconnus automatiquement, d'après le contenu de la frame (pas de réglage nécessaire):
//  - Collabora: canvas#document-canvas / #document-container
//  - Euro-Office / ONLYOFFICE (Nextcloud Office): iframe "frameEditor" de DocsAPI, zone #editor_sdk, canvas #id_viewer
//    (frame imbriquée dans l'iframe du connecteur Nextcloud; on parcourt toutes les frames, donc peu importe son nom).
const OO_EDITOR = '#editor_sdk, #id_viewer, #id_viewer_overlay';
const isOnlyoffice = async (frame) => (await frame.locator(OO_EDITOR).count().catch(() => 0)) > 0;

/** Attend que l'éditeur Collabora (iframe) soit affiché. */
async function findEditorFrame(page) {
  // Cherche parmi TOUTES les frames celle qui contient l'éditeur (canvas ou conteneur Collabora),
  // sans dépendre du nom ou de l'identifiant de l'iframe (varie selon les versions de Nextcloud).
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const n = await f.locator('#document-container, canvas#document-canvas, canvas').count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

/**
 * Euro-Office / ONLYOFFICE: ferme une fenêtre modale de l'éditeur (avertissement, conseil, "mode de compatibilité"...).
 * Même prudence que pour Collabora: jamais de bouton "Fermer" de l'en-tête (il ferme le document).
 * On n'agit que sur une fenêtre .asc-window visible DANS la frame de l'éditeur: Échap, puis à défaut un bouton OK / Fermer de CETTE fenêtre.
 */
const ooState = new WeakMap();
async function dismissOnlyofficeDialogs(page, frame, user, log) {
  if (!frame || frame.isDetached()) return false;
  const win = frame.locator('.asc-window.modal:visible, .asc-window.alert:visible').first();
  if (!(await win.isVisible().catch(() => false))) return false;
  const st = ooState.get(page) || { shot: false };
  ooState.set(page, st);
  const text = ((await win.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  log(`${user}: fenêtre de l'éditeur Euro-Office détectée [texte: "${text}"]`);
  if (!st.shot) {
    st.shot = true;
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/office-${user}-fenetre.png` }).catch(() => {});
    log(`${user}: capture artifacts/office-${user}-fenetre.png`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await C.sleep(500);
  if (await win.isVisible().catch(() => false)) {
    const btn = win.getByRole('button', { name: /^(OK|Fermer|Close|Continuer|Continue|Compris|Got it)$/i }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ timeout: 2000 }).catch(() => {}); await C.sleep(500); }
  }
  const still = await win.isVisible().catch(() => false);
  log(`${user}: fenêtre Euro-Office ${still ? 'ENCORE affichée (voir capture)' : 'fermée'}`);
  return true;
}

/** Ferme les fenêtres de l'éditeur, quel qu'il soit. Retourne true si une fenêtre a été détectée. */
async function dismissEditorDialogs(page, frame, user, log) {
  const a = await dismissCollaboraDialogs(page, frame, user, log);
  const b = await dismissOnlyofficeDialogs(page, frame, user, log);
  return a || b;
}

/**
 * Ferme la fenêtre de bienvenue de Collabora ("Explore The New ...") si elle est affichée.
 * IMPORTANT: on ne clique JAMAIS sur un bouton "Fermer" générique, car la croix en haut à droite
 * de l'éditeur ferme le DOCUMENT lui-même. On détecte la fenêtre par son texte, puis on la ferme
 * avec la touche Échap, ou à défaut avec une croix située DANS la fenêtre de bienvenue.
 * Retourne true si une fenêtre a été détectée.
 */
const WELCOME_RE = /Welcome to Collabora Online|short tour points out|Bienvenue dans Collabora|Explore The New|Explorez|Collabora Online Development Edition|Give us your feedback|Faites-nous part/i;
async function welcomeMatch(page) {
  for (const f of page.frames()) {
    const loc = f.getByText(WELCOME_RE).first();
    if (await loc.isVisible().catch(() => false)) {
      const text = ((await loc.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return { frameUrl: f.url().slice(0, 80), text };
    }
  }
  return null;
}
async function welcomeVisible(page) { return !!(await welcomeMatch(page)); }

/**
 * Version de Collabora (ex. "26.04.5.2"), lue une fois par lancement. C'est la valeur que Collabora compare à WSDWelcomeVersion.
 * Marche quelle que soit l'adresse de Collabora (même nom que Nextcloud ou serveur à part):
 *  1. capacités Nextcloud (/ocs/v2.php/cloud/capabilities, app richdocuments): version fournie par Nextcloud,
 *     sinon adresse publique de Collabora (public_wopi_url / wopi_url) réglée dans les paramètres Office;
 *  2. /hosting/capabilities (productVersion) sur cette adresse, puis sur l'adresse de Nextcloud.
 * null si illisible (Euro-Office, Collabora injoignable...): la page d'accueil est alors coupée pour la journée seulement.
 */
let collaboraVersion; // undefined = pas encore lue
let collaboraSkipMsg = null; // affiché une seule fois, au premier éditeur Collabora détecté
async function fetchJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
async function readCollaboraVersion(cfg, log) {
  if (collaboraVersion !== undefined) return collaboraVersion;
  collaboraVersion = null;
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers = { 'OCS-APIRequest': 'true', Accept: 'application/json' };
  if (process.env.NC_ADMIN_PASSWORD) {
    headers.Authorization = 'Basic ' + Buffer.from(`${process.env.NC_ADMIN_USER || 'admin'}:${process.env.NC_ADMIN_PASSWORD}`).toString('base64');
  }
  const rd = (await fetchJson(`${base}/ocs/v2.php/cloud/capabilities?format=json`, headers))?.ocs?.data?.capabilities?.richdocuments;
  collaboraVersion = rd?.collabora?.productVersion || null;
  const collaboraUrl = (rd?.config?.public_wopi_url || rd?.config?.wopi_url || '').replace(/\/+$/, '');
  const candidates = [...new Set([collaboraUrl, base].filter(Boolean))];
  for (const url of candidates) {
    if (collaboraVersion) break;
    collaboraVersion = (await fetchJson(`${url}/hosting/capabilities`))?.productVersion || null;
  }
  collaboraSkipMsg = collaboraVersion
    ? `Collabora ${collaboraVersion} : page d'accueil et fenêtre d'avis désactivées côté navigateur`
    : `Collabora : version non lue (essayé : capacités Nextcloud, ${candidates.map((u) => `${u}/hosting/capabilities`).join(', ')}), page d'accueil désactivée pour la journée et fenêtre d'avis désactivée côté navigateur`;
  return collaboraVersion;
}

/** Si la page d'accueil s'affiche quand même: enregistre dans Collabora la version vue (comme sa croix), pour qu'elle ne revienne plus. */
async function rememberWelcomeSeen(page) {
  for (const f of page.frames()) {
    const v = await f.evaluate(() => {
      const ver = window.app?.socket?.WSDServer?.Version;
      if (!ver || !window.prefs) return null;
      window.prefs.set('WSDWelcomeVersion', ver);
      return ver;
    }).catch(() => null);
    if (v) return v;
  }
  return null;
}

// Mémorise, par page, l'état des tentatives pour ne pas spammer les logs ni bloquer la frappe
const welcomeState = new WeakMap();
let welcomeWarned = false; // "affichée malgré le réglage": une seule ligne par lancement
async function dismissCollaboraDialogs(page, frame, user, log) {
  const first = await welcomeMatch(page);
  if (!first) return false;
  const st = welcomeState.get(page) || { fails: 0, nextTry: 0, shot: false };
  welcomeState.set(page, st);
  // Après 2 échecs, on ne réessaie qu'une fois par minute (évite de perturber la frappe et de spammer)
  if (st.fails >= 2 && Date.now() < st.nextTry) return false;
  const seenVersion = await rememberWelcomeSeen(page);

  // Visite guidée ("Welcome to Collabora Online", boutons Skip/Next): on clique sur Skip / Passer, uniquement dans cette fenêtre
  for (const f of page.frames()) {
    const skip = f.getByRole('button', { name: /^(Skip|Passer|Ignorer|Sauter)/i }).first();
    if (await skip.isVisible().catch(() => false)) { await skip.click({ timeout: 2000 }).catch(() => {}); await C.sleep(500); }
  }
  // Fenêtre dans sa propre frame (/welcome/welcome.html): Échap et croix DANS cette frame (le focus clavier est dans l'éditeur, pas dans la fenêtre)
  if (await welcomeVisible(page)) {
    for (const f of page.frames()) {
      if (!/welcome/i.test(f.url())) continue;
      await f.locator('body').press('Escape', { timeout: 1500 }).catch(() => {});
      await C.sleep(400);
      if (!(await welcomeVisible(page))) break;
      for (const sel of ['#closeButton', '.close-button', 'button[aria-label*="lose" i]', '[id*="close" i]', '[class*="close" i]', '[class*="Close"]']) {
        const loc = f.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) { await loc.click({ timeout: 1500 }).catch(() => {}); await C.sleep(400); }
        if (!(await welcomeVisible(page))) break;
      }
      if (!(await welcomeVisible(page))) break;
      // dernier recours: la croix est en haut à droite de la fenêtre; on clique en haut à droite de la boîte centrale
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      await page.mouse.click(Math.round(vp.width * 0.75), Math.round(vp.height * 0.18)).catch(() => {});
      await C.sleep(400);
    }
  }
  if (await welcomeVisible(page)) { await page.keyboard.press('Escape').catch(() => {}); await C.sleep(500); }
  if (await welcomeVisible(page)) {
    // Échap sans effet: croix spécifique à la fenêtre de bienvenue uniquement
    for (const f of page.frames()) {
      for (const sel of ['#iframe-welcome-modal [class*="close"]', '.iframe-welcome-modal [class*="close"]', '[id*="welcome"] [class*="close"]', '[class*="welcome"] [class*="close"]']) {
        const loc = f.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) await loc.click({ timeout: 2000 }).catch(() => {});
      }
    }
    await C.sleep(500);
  }
  const still = await welcomeMatch(page);
  if (still) {
    st.fails++;
    st.nextTry = Date.now() + 60000;
    // Diagnostic: texte détecté + capture, une seule fois par utilisateur
    log(`${user}: fenêtre de bienvenue Collabora ENCORE affichée (non fermée) [texte détecté: "${still.text}" | frame: ${still.frameUrl}]${st.fails > 2 ? ' (réessai espacé à 60 s)' : ''}`);
    if (!st.shot) {
      st.shot = true;
      fs.mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: `artifacts/office-${user}-bienvenue.png` }).catch(() => {});
      log(`${user}: capture artifacts/office-${user}-bienvenue.png`);
    }
  } else {
    st.fails = 0;
    const known = collaboraVersion;
    if (seenVersion) collaboraVersion = seenVersion; // éditeurs suivants: version réelle du serveur
    if (!welcomeWarned) {
      welcomeWarned = true;
      log(`${user}: page d'accueil Collabora affichée malgré le réglage navigateur [texte: "${first.text}" | version serveur ${seenVersion || '?'}, version lue ${known || 'aucune'}], fermée; les suivantes sont fermées sans log`);
    }
  }
  return true;
}

async function waitEditor(page, timeoutMs, user, log, expected = 'auto') {
  const end = Date.now() + timeoutMs;
  let frame = null;
  while (Date.now() < end) {
    frame = await findEditorFrame(page);
    if (frame) break;
    await C.sleep(500);
  }
  if (!frame) throw new Error('aucune frame avec éditeur');
  // Délai de 60 s pour l'affichage du document; à ajuster selon le serveur.
  await frame.locator('canvas').first().waitFor({ timeout: 60000 }).catch(() => {}); // document affiché
  const detected = (await isOnlyoffice(frame)) ? 'nextcloud-office' : 'collabora';
  if (detected === 'nextcloud-office') {
    // Euro-Office / ONLYOFFICE: le canvas existe avant la fin du chargement; on attend que l'écran de chargement (#loading-mask) disparaisse,
    // sinon les premières frappes sont perdues. Délai de 60 s; à ajuster selon le serveur.
    await frame.locator('#loading-mask, .loadmask').first().waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
  } else {
    // Collabora: le canvas existe AVANT le document. On attend son signal de fin de chargement (app.map._docLoaded) et le mode édition,
    // sinon le clic et les touches de placement sont perdus et la frappe part au début du document.
    const ready = await frame.waitForFunction(() => window.app?.map?._docLoaded === true && (window.app.map.isEditMode?.() ?? true),
      null, { timeout: 60000, polling: 500 }).then(() => true).catch(() => false);
    if (!ready) log(`${user}: document Collabora toujours en chargement (ou en lecture seule) après 60 s, on continue`);
  }
  log(`${user}: éditeur ${editorLabel(detected)} détecté`);
  if (detected === 'collabora' && collaboraSkipMsg) { log(collaboraSkipMsg); collaboraSkipMsg = null; }
  if (expected !== 'auto' && expected !== detected) {
    throw new Error(`Éditeur attendu : ${editorLabel(expected)}, ouvert : ${editorLabel(detected)} (vérifier le connecteur activé dans Nextcloud)`);
  }
  await C.sleep(1500); // laisse apparaître la fenêtre de bienvenue
  // Plusieurs tentatives: la fenêtre peut apparaître avec retard
  for (let i = 0; i < 3; i++) { await dismissEditorDialogs(page, frame, user, log); await C.sleep(700); }
  return { frame, editor: detected };
}


/** Si Collabora et Nextcloud Office sont tous deux installés, Nextcloud peut afficher « Ouvrir avec ». */
async function dismissOpenWithChooser(page, user, log) {
  const root = page.locator('[role="dialog"], .oc-dialog, .modal-container, .modal__content').filter({
    hasText: /Open with|Ouvrir avec|Choose app|Choisir une application|Open file|Ouvrir le fichier/i,
  }).first();
  if (!(await root.isVisible().catch(() => false))) return false;
  log(`${user}: fenêtre « Ouvrir avec » détectée`);
  const pick = root.locator('a, button, li, [role="option"], .option').filter({
    hasText: /Nextcloud Office|Euro-Office|ONLYOFFICE|Collabora|Document/i,
  }).first();
  if (await pick.isVisible().catch(() => false)) {
    await pick.click({ timeout: 3000 }).catch(() => {});
    await C.sleep(500);
    return true;
  }
  return false;
}

/** Ouvre le document partagé: clic dans la liste des fichiers, sinon ouverture directe par identifiant. */
async function openDocument({ page, cfg, user, fileName, fileId, log, expected = 'auto' }) {
  await page.goto(`${cfg.baseUrl}/apps/files`, { waitUntil: 'domcontentloaded' });
  await C.dismissOverlays(page, user, log);
  // Attend que la liste soit chargée, puis la journalise si le document n'y est pas
  await page.locator('tr[data-file], [data-cy-files-list-row]').first().waitFor({ timeout: 20000 }).catch(() => {});
  const names = await page.evaluate(() => [...document.querySelectorAll('tr[data-file], [data-cy-files-list-row-name]')].map((r) => r.getAttribute('data-file') || r.getAttribute('data-cy-files-list-row-name'))).catch(() => []);
  if (!names.includes(fileName)) log(`${user}: ${fileName} absent de la liste (fichiers visibles: ${JSON.stringify(names)}), url=${page.url()}`);

  // 1) clic sur le nom du fichier
  try {
    await page.locator(`tr[data-file="${fileName}"] a.name, [data-cy-files-list-row-name="${fileName}"] [data-cy-files-list-row-name-link], [data-cy-files-list-row-name="${fileName}"] a`).first().click({ timeout: 10000 });
    await dismissOpenWithChooser(page, user, log);
    // 90 s: sous charge, Collabora peut mettre plus de 45 s à s'ouvrir (le secours rechargerait la page pour rien)
    return await waitEditor(page, 90000, user, log, expected);
  } catch (e) {
    if (/Éditeur attendu/.test(e.message)) throw e; // mauvais éditeur: ne pas retenter
    // Secours prévu: clic lent, « Ouvrir avec », ou viewer Nextcloud - on continue par openfile /f/<id>
    log(`${user}: pas d'éditeur après le clic sur ${fileName}, essai par identifiant (secours prévu)`);
  }
  // 2) ouverture directe (openfile) puis 3) lien court /f/<id>
  if (fileId) {
    for (const url of [`${cfg.baseUrl}/apps/files/?dir=/&openfile=${fileId}`, `${cfg.baseUrl}/f/${fileId}`]) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded' }); return await waitEditor(page, 30000, user, log, expected); }
      catch (e) {
        if (/Éditeur attendu/.test(e.message)) throw e;
        log(`${user}: pas d'éditeur via ${url.replace(cfg.baseUrl, '')}`);
      }
    }
  }
  throw new Error('éditeur introuvable (voir capture)');
}

/**
 * Collabora: place le curseur à la FIN du paragraphe n (0 = titre, n = "Zone n :") et lit le texte de ce paragraphe.
 * Navigation par PARAGRAPHE (insensible au retour à la ligne du texte des autres éditeurs). Chaque commande part d'une position
 * où elle reste DANS le paragraphe: dans Writer, GoToEndOfPara / StartOfParaSel passent au paragraphe SUIVANT / PRÉCÉDENT si le
 * curseur est déjà à la fin / au début (c'était le décalage d'une zone de la v54).
 *   GoToStartOfDoc, GoToNextPara x n  -> début du paragraphe n
 *   GoToEndOfPara                    -> fin du paragraphe n
 *   StartOfParaSel                   -> sélection du paragraphe n entier (curseur revenu au début), lue pour vérifier
 *   GoToEndOfPara                    -> fin du paragraphe n, sélection annulée (relu: doit être vide avant toute frappe)
 * Retourne { text, after } (null = pas de réponse), ou null si l'API de Collabora est absente.
 */
async function collaboraGoToZone(frame, n) {
  return frame.evaluate(async (n) => {
    const map = window.app?.map;
    if (!map?.sendUnoCommand || !window.app.socket) return null;
    // Collabora répond à chaque "gettextselection" par un message textselectioncontent, DANS L'ORDRE des demandes et après les
    // commandes envoyées avant. Une réponse en retard (demande précédente expirée) ne doit pas être prise pour la nôtre:
    // on numérote les demandes et on prend la réponse qui porte NOTRE numéro.
    const S = window.__loadtestSel || (window.__loadtestSel = (() => {
      const s = { sent: 0, got: 0, waiting: {} };
      const reply = (text) => { s.got++; const w = s.waiting[s.got]; if (w) { delete s.waiting[s.got]; w(text); } };
      map.on('textselectioncontent', (e) => reply(String(e.plainText || String(e.html || '').replace(/[\s\S]*<body[^>]*>/i, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()));
      map.on('complexselection', () => reply(null));
      return s;
    })());
    const read = () => new Promise((res) => {
      const id = S.sent = Math.max(S.sent, S.got) + 1;
      const timer = setTimeout(() => { delete S.waiting[id]; res(null); }, 10000);
      S.waiting[id] = (t) => { clearTimeout(timer); res(t); };
      window.app.socket.sendMessage('gettextselection mimetype=text/html,text/plain;charset=utf-8');
    });
    map.focus?.();
    map.sendUnoCommand('.uno:GoToStartOfDoc');
    for (let i = 0; i < n; i++) map.sendUnoCommand('.uno:GoToNextPara');
    map.sendUnoCommand('.uno:GoToEndOfPara');
    map.sendUnoCommand('.uno:StartOfParaSel');
    const text = await read();
    map.sendUnoCommand('.uno:GoToEndOfPara');
    const after = await read();
    return { text, after };
  }, n).catch(() => null);
}

/**
 * Place le curseur à la fin de SA zone (paragraphe "Zone slot+1 :").
 *  - Collabora: par paragraphe, avec vérification du texte du paragraphe et de l'absence de sélection, un nouvel essai sinon.
 *  - Euro-Office: par paragraphe via l'API de l'éditeur (ooGoToZone), avec la même vérification.
 *  - API absente: au clavier, Ctrl+Début puis Bas x (slot+1) et Fin (par LIGNE: peut tomber dans une autre zone si le texte est long).
 */
async function placeCursor({ page, frame, editor, slot, user, log, first = false }) {
  const zone = slot + 1;
  // Clic dans la page pour donner le focus clavier au document (jamais sur une marge ou une barre).
  // Euro-Office / ONLYOFFICE: #id_viewer_overlay / #id_viewer (le 1er canvas de la frame peut être la règle: ne pas cliquer dessus)
  const main = frame.locator('#document-canvas, canvas#document-canvas, #id_viewer_overlay, #id_viewer').first();
  const target = (await main.count().catch(() => 0)) > 0 ? main : frame.locator('canvas').first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox().catch(() => null);
  if (box) await page.mouse.click(box.x + Math.min(200, box.width / 3), box.y + Math.min(150, box.height / 3)).catch(() => {});
  else await target.click({ position: { x: 200, y: 150 }, timeout: 5000 }).catch(() => {});
  await C.sleep(500);
  if (editor === 'collabora') {
    const label = `Zone ${zone} :`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await collaboraGoToZone(frame, zone);
      if (r === null) { log(`${user}: API Collabora indisponible, curseur placé au clavier`); break; }
      const okZone = (r.text || '').startsWith(label);
      if (okZone && r.after === '') {
        if (first) log(`${user}: curseur placé (zone ${zone}, vérifié : paragraphe « ${label} », sans sélection), début de la frappe`);
        return;
      }
      const seen = !okZone ? (r.text ? `paragraphe lu : "${r.text.slice(0, 60)}"` : 'paragraphe non lu')
        : (r.after === null ? 'sélection non relue' : 'sélection encore active');
      if (attempt === 1) { log(`${user}: curseur non vérifié en zone ${zone} (${seen}), nouvel essai`); await C.sleep(2000); continue; }
      // Jamais de frappe sur une sélection (elle remplacerait le texte sélectionné): Fin l'annule sans changer de paragraphe.
      await page.keyboard.press('End');
      log(`${user}: curseur NON vérifié en zone ${zone} (${seen}), sélection annulée par Fin, frappe quand même`);
      return;
    }
  }
  if (editor === 'nextcloud-office') {
    const label = `Zone ${zone} :`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const f = await ooApiFrame(page, frame);
      const r = f ? await ooGoToZone(f, zone) : null;
      if (r === null) { log(`${user}: API Euro-Office indisponible, curseur placé au clavier (par ligne : peut tomber dans une autre zone)`); break; }
      const okZone = (r.text || '').startsWith(label) && r.pos === zone;
      if (okZone && r.sel !== true) {
        await C.sleep(300); // laisse l'éditeur redessiner le curseur avant la frappe
        if (first) log(`${user}: curseur placé (zone ${zone}, vérifié : paragraphe « ${label} »${r.sel === false ? ', sans sélection' : ''}), début de la frappe`);
        return;
      }
      const seen = !okZone ? (r.text ? `paragraphe lu : "${r.text.slice(0, 60)}", curseur au paragraphe ${r.pos}` : 'paragraphe non lu') : 'sélection encore active';
      if (attempt === 1) { log(`${user}: curseur non vérifié en zone ${zone} (${seen}), nouvel essai`); await C.sleep(2000); continue; }
      await page.keyboard.press('End');
      log(`${user}: curseur NON vérifié en zone ${zone} (${seen}), frappe quand même`);
      return;
    }
  }
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < zone; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  if (first) log(`${user}: curseur placé (zone ${zone}), début de la frappe`);
}

// ---------- Euro-Office / ONLYOFFICE: document lu et curseur placé par l'API de l'éditeur ----------
// Vérifié dans Euro-Office/sdkjs (word/apiBuilder.js): window.AscBuilder.Word.Api = API « Document Builder », noms exportés entre guillemets
// (stables même si le code est minifié). GetDocument() -> document; GetElement(i) = paragraphe i du corps (0 = titre, n = « Zone n : »);
// ApiParagraph.GetText(); GetCurrentParagraph().GetPosInParent() = numéro du paragraphe du curseur.
// Fin de paragraphe: Paragraph.MoveCursorToEndPos + Document_SetThisElementCurrent (code interne, même enchaînement que ApiParagraph.Select),
// sinon ApiRun.MoveCursorToPos sur le dernier morceau de texte. Lecture du modèle local: le texte des autres arrive en co-édition rapide.
const ooFrames = new WeakMap();
async function ooApiFrame(page, frame) {
  const hasApi = (f) => f.evaluate(() => typeof window.AscBuilder?.Word?.Api?.GetDocument === 'function').catch(() => false);
  const known = ooFrames.get(page);
  if (known && !known.isDetached()) return known;
  for (const f of [frame, ...page.frames().filter((x) => x !== frame)]) {
    if (f && !f.isDetached() && (await hasApi(f))) { ooFrames.set(page, f); return f; }
  }
  return null;
}

/** Place le curseur à la fin du paragraphe n et le relit. { text, pos, sel } (sel null = non lisible), ou null si l'API est absente. */
async function ooGoToZone(f, n) {
  return f.evaluate((n) => {
    const doc = window.AscBuilder?.Word?.Api?.GetDocument?.();
    if (!doc) return null;
    const p = doc.GetElement(n);
    if (!p || p.GetClassType() !== 'paragraph') return { text: null, pos: -1, sel: null };
    const para = p.Paragraph, ld = doc.Document;
    if (typeof para?.MoveCursorToEndPos === 'function' && typeof para.Document_SetThisElementCurrent === 'function' && ld?.RemoveSelection) {
      ld.RemoveSelection();
      para.MoveCursorToEndPos(false);
      para.Document_SetThisElementCurrent(true);
    } else {
      for (let i = p.GetElementsCount() - 1; i >= 0; i--) {
        const el = p.GetElement(i);
        if (el?.GetClassType?.() === 'run') { el.MoveCursorToPos(1e9); break; }
      }
    }
    const cur = doc.GetCurrentParagraph();
    return {
      text: String(p.GetText()).replace(/\s+/g, ' ').trim(),
      pos: cur ? cur.GetPosInParent() : -1,
      sel: typeof ld?.IsSelectionUse === 'function' ? !!ld.IsSelectionUse() : null,
    };
  }, n).catch(() => null);
}

/** Paragraphe du curseur et texte du paragraphe n, sans rien déplacer. null si l'API est absente. */
async function ooZoneState(f, n) {
  return f.evaluate((n) => {
    const doc = window.AscBuilder?.Word?.Api?.GetDocument?.();
    if (!doc) return null;
    const p = doc.GetElement(n), cur = doc.GetCurrentParagraph(), ld = doc.Document;
    return {
      text: p?.GetClassType() === 'paragraph' ? String(p.GetText()).replace(/\s+/g, ' ').trim() : '',
      pos: cur ? cur.GetPosInParent() : -1,
      sel: typeof ld?.IsSelectionUse === 'function' ? !!ld.IsSelectionUse() : false,
      atEnd: typeof cur?.Paragraph?.IsCursorAtEnd === 'function' ? !!cur.Paragraph.IsCursorAtEnd() : true, // code interne (Paragraph.js)
    };
  }, n).catch(() => null);
}

/** Fin d'édition: phrases de l'éditeur dans le paragraphe n et dans le reste du document. null si l'API est absente. */
async function ooCountPhrases(f, n, user) {
  return f.evaluate(({ n, user }) => {
    const doc = window.AscBuilder?.Word?.Api?.GetDocument?.();
    if (!doc) return null;
    const re = new RegExp(`Charge de test ${user}(?!\\d)`, 'g');
    let inZone = 0, elsewhere = 0;
    for (let i = 0, c = doc.GetElementsCount(); i < c; i++) {
      const el = doc.GetElement(i);
      if (el?.GetClassType?.() !== 'paragraph') continue;
      const k = (String(el.GetText()).match(re) || []).length;
      if (i === n) inZone += k; else elsewhere += k;
    }
    return { inZone, elsewhere };
  }, { n, user }).catch(() => null);
}

/**
 * Euro-Office, après chaque phrase: la phrase doit finir SA zone et le curseur y être encore.
 *  - fin de zone différente de « Charge de test userNN »: frappe incomplète (touches perdues), comptée, 1re fois journalisée
 *  - curseur hors de la fin de sa zone (autre paragraphe, milieu du paragraphe, sélection active): replacé, compté, 1re fois journalisée
 */
async function guardOnlyoffice({ page, frame, slot, user, log, st }) {
  if (st.off) return;
  const zone = slot + 1;
  const f = await ooApiFrame(page, frame);
  const z = f ? await ooZoneState(f, zone) : null;
  if (!z) { st.off = true; return; }
  if (z.pos === zone && !z.text.endsWith(`Charge de test ${user}`)) {
    st.incomplete++;
    if (st.incomplete === 1) log(`${user}: phrase incomplète dans la zone ${zone} (touches perdues ; fin lue : "…${z.text.slice(-40)}"), les suivantes sont comptées sans log`);
  }
  if (z.pos !== zone || z.sel || !z.atEnd) {
    st.moved++;
    const where = z.sel ? 'sélection active' : z.pos !== zone ? `paragraphe ${z.pos}` : 'au milieu de sa zone';
    if (st.moved === 1) log(`${user}: curseur sorti de la fin de la zone ${zone} (${where}), replacé ; les suivants sont comptés sans log`);
    await placeCursor({ page, frame, editor: 'nextcloud-office', slot, user, log });
  }
}

/**
 * Euro-Office: bulle « nouveauté » (ex. « New Multipage view », bouton « Got it »), normalement évitée par installEuroOfficeTipsSkip.
 * Fermée d'abord comme son bouton, sans clic (Common.UI.TooltipManager.closeTip(étape, true), qui écrit aussi la clé),
 * sinon par un clic sur « Got it ». Retourne true si un clic a été nécessaire (le curseur est alors replacé). Un log par éditeur.
 */
const OO_TIP_STEPS = ['multipageViewStatusbar', 'multipageViewToolbar', 'headerFooterTab', 'signature', 'commentFilter', 'chartElements'];
async function closeOnlyofficeTips(page, frame, user, log, st) {
  const f = (await ooApiFrame(page, frame)) || frame;
  const tip = f.locator('.synch-tip-root:visible').filter({ has: f.locator('.btn-div') }).first();
  if (!(await tip.isVisible().catch(() => false))) return false;
  const text = ((await tip.locator('.tip-header').first().textContent({ timeout: 1000 }).catch(() => '')) || '').trim().replace(/\s+/g, ' ').replace(/^New(?=\S)/, 'New ').slice(0, 60);
  await f.evaluate((steps) => { try { window.Common?.UI?.TooltipManager?.closeTip(steps, true); } catch { /* */ } }, OO_TIP_STEPS).catch(() => {});
  await C.sleep(300);
  let clicked = false;
  if (await tip.isVisible().catch(() => false)) {
    await tip.locator('.btn-div').first().click({ timeout: 2000 }).catch(() => {});
    clicked = true;
    await C.sleep(300);
  }
  const still = await tip.isVisible().catch(() => false);
  if (!st.tipLogged) {
    st.tipLogged = true;
    log(`${user}: bulle Euro-Office « ${text || '?'} » ${still ? 'ENCORE affichée' : `fermée (${clicked ? 'clic sur Got it' : 'comme Got it'})`}`);
  }
  return clicked;
}

// ---------- Fenêtre d'avis Collabora ("Your Review Is Our Best Motivation") ----------
// Map.Feedback.js (26.04.5): ~30 s après l'ouverture (si l'utilisateur a déjà ouvert plus de 15 documents), un bandeau
// "Please send us your feedback" s'affiche avec le focus sur son bouton OK. L'espace de la frappe "appuie" sur OK et ouvre la fenêtre
// d'avis (iframe#iframe-feedback), qui prend alors toutes les touches. Normalement évité par WSDFeedbackEnabled=false
// (browser-init.js); ceci est le secours, appelé après chaque phrase.
const FEEDBACK_RE = /Your Review Is Our Best Motivation|Please send us your feedback|Type of feedback/i;

/** État du focus clavier dans la frame Collabora. null = API Collabora absente (pas de contrôle). */
async function collaboraFocusState(frame) {
  return frame.evaluate(() => {
    const map = window.app?.map;
    if (!map || typeof map.hasFocus !== 'function') return null;
    const dlg = map.feedback?._iframeDialog;
    const a = document.activeElement;
    return {
      focused: !!map.hasFocus(), // focus sur la zone de saisie du document
      feedback: !!document.getElementById('iframe-feedback') || !!dlg?.isVisible?.(),
      snackbar: !!window.JSDialog?.SnackbarController?.showingSnackbar,
      active: a ? `${a.tagName}${a.id ? `#${a.id}` : ''}`.slice(0, 60) : '?',
    };
  }).catch(() => null);
}

async function feedbackTextVisible(page) {
  for (const f of page.frames()) {
    if (await f.getByText(FEEDBACK_RE).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

/** Ferme la fenêtre d'avis comme son bouton "Do not show again", puis côté Collabora (même effet que son message feedback-never). */
async function closeCollaboraFeedback(page, frame) {
  for (const f of page.frames()) {
    const b = f.getByRole('button', { name: /^\s*(Do not show again|Ne plus afficher)/i })
      .or(f.getByText(/^\s*(Do not show again|Ne plus afficher)\s*$/i)).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 2000 }).catch(() => {}); await C.sleep(500); break; }
  }
  await frame.evaluate(() => {
    const map = window.app?.map;
    try { window.prefs?.set('WSDFeedbackEnabled', false); window.prefs?.remove('WSDFeedbackCount'); } catch { /* */ }
    try { if (document.getElementById('iframe-feedback')) map?.feedback?.removeIframe?.(); } catch { /* */ }
    try { if (window.JSDialog?.SnackbarController?.showingSnackbar) map?.uiManager?.closeSnackbar?.(); } catch { /* */ }
    map?.focus?.();
  }).catch(() => {});
  await C.sleep(300);
}

/**
 * Collabora: vérifie que les touches vont bien dans le document. Retourne true si le focus était ailleurs
 * (la dernière phrase n'est alors pas comptée: elle sera retapée).
 *  - fenêtre d'avis (ou son bandeau): fermée, puis curseur replacé et vérifié dans la zone
 *  - autre élément (bandeau, bouton...): bandeau fermé, focus rendu au document (le curseur ne bouge pas)
 */
async function guardCollaboraFocus({ page, frame, slot, user, log, st }) {
  if (st.off) return false;
  const s = await collaboraFocusState(frame);
  if (!s) { st.off = true; return false; }
  if (s.focused && !s.feedback) return false;
  if (s.feedback || (await feedbackTextVisible(page))) {
    await closeCollaboraFeedback(page, frame);
    const after = await collaboraFocusState(frame);
    const still = !after || after.feedback || (await feedbackTextVisible(page));
    if (still && !st.fbShot) {
      st.fbShot = true;
      fs.mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: `artifacts/office-${user}-avis.png` }).catch(() => {});
      log(`${user}: fenêtre d'avis Collabora ENCORE affichée (non fermée), capture artifacts/office-${user}-avis.png`);
    } else if (!still && !st.fbLogged) {
      st.fbLogged = true;
      log(`${user}: fenêtre d'avis Collabora fermée (frappe interrompue)`);
    }
    await placeCursor({ page, frame, editor: 'collabora', slot, user, log });
    return true;
  }
  await frame.evaluate((sb) => { if (sb) window.app.map.uiManager?.closeSnackbar?.(); window.app.map.focus(); }, s.snackbar).catch(() => {});
  await C.sleep(300);
  const again = await collaboraFocusState(frame);
  if (!again?.focused) {
    st.off = true; // ne bloque jamais la frappe: on continue sans contrôle (le bilan "retrouvées" dira si du texte manque)
    log(`${user}: focus clavier hors du document (élément actif : ${again?.active || s.active}), contrôle du focus arrêté pour cet éditeur`);
    return false;
  }
  if (!st.focusLogged) {
    st.focusLogged = true;
    log(`${user}: focus clavier rendu au document (il était sur ${s.active}${s.snackbar ? ', bandeau Collabora fermé' : ''})`);
  }
  return true;
}

/** Collabora, en fin d'édition: nombre de phrases de l'éditeur réellement présentes dans SA zone (lu dans le document). */
async function countOwnPhrases(frame, slot, user) {
  const r = await collaboraGoToZone(frame, slot + 1);
  if (!r || r.text === null) return null;
  return (r.text.match(new RegExp(`Charge de test ${user}(?!\\d)`, 'g')) || []).length;
}

/**
 * Ouvre le document partagé et y écrit dans la zone de l'éditeur pendant durationSec.
 * Retourne true si le document s'est ouvert et a été édité.
 */
export async function editDocument({ page, cfg, user, fileName, fileId, slot, durationSec, log, expected = 'auto' }) {
  let detected = null;
  try {
    const opened = await openDocument({ page, cfg, user, fileName, fileId, log, expected });
    const frame = opened.frame;
    detected = opened.editor;
    log(`${user}: document ${fileName} ouvert (zone ${slot + 1}), édition pendant ${durationSec} s`);

    await placeCursor({ page, frame, editor: detected, slot, user, log, first: true });

    const end = Date.now() + durationSec * 1000;
    let shot = false, typed = 0;
    const focusSt = { off: detected !== 'collabora' }; // contrôle du focus: Collabora seulement
    const isOO = detected === 'nextcloud-office';
    const ooSt = { off: !isOO, incomplete: 0, moved: 0, tipLogged: false }; // contrôles Euro-Office
    while (Date.now() < end) {
      if (frame.isDetached()) throw new Error('le document a été fermé pendant l\'édition');
      if (await dismissEditorDialogs(page, frame, user, log)) {
        await placeCursor({ page, frame, editor: detected, slot, user, log }); // une fenêtre avait pris le focus
      }
      if (isOO && (await closeOnlyofficeTips(page, frame, user, log, ooSt))) {
        await placeCursor({ page, frame, editor: detected, slot, user, log }); // le clic a pu prendre le focus
      }
      await page.keyboard.type(`Charge de test ${user} `, { delay: 80 });
      // Collabora: si une fenêtre (avis...) a pris le focus pendant la phrase, elle n'est pas comptée et sera retapée
      if (await guardCollaboraFocus({ page, frame, slot, user, log, st: focusSt })) continue;
      typed++;
      if (!shot) { // capture de contrôle après la première frappe, pour vérifier visuellement que le texte apparaît
        shot = true;
        await C.sleep(1500);
        fs.mkdirSync('artifacts', { recursive: true });
        await page.screenshot({ path: `artifacts/office-${user}-edition.png` }).catch(() => {});
        log(`${user}: capture de contrôle artifacts/office-${user}-edition.png`);
      }
      await C.sleep(2000);
      if (isOO) await guardOnlyoffice({ page, frame, slot, user, log, st: ooSt });
    }
    let count = '', found = null, extra = '';
    if (detected === 'collabora') {
      // Compteur de la barre d'état de Collabora (tous éditeurs confondus; peut être en retard sur le document)
      count = await frame.evaluate(() => window.app?.map?.stateChangeHandler?.getItemValue('.uno:StateWordCount') || '').catch(() => '');
      // Ce que SA zone contient vraiment: ses phrases relues dans le document
      found = await countOwnPhrases(frame, slot, user);
    } else if (isOO) {
      // Euro-Office: SES phrases relues dans SA zone et dans le reste du document
      const f = await ooApiFrame(page, frame);
      const r = f ? await ooCountPhrases(f, slot + 1, user) : null;
      if (r) {
        found = r.inZone;
        extra = `, ${r.elsewhere} ailleurs`;
      } else extra = ', vérification impossible (API Euro-Office absente)';
      if (ooSt.incomplete) extra += `, ${ooSt.incomplete} phrase(s) incomplète(s)`;
      if (ooSt.moved) extra += `, curseur replacé ${ooSt.moved} fois`;
    }
    const inZone = found === null ? '' : `, ${found} retrouvées dans la zone ${slot + 1}`;
    log(`${user}: édition terminée (${typed} phrases tapées${inZone}${extra}${count ? `, document : ${count}` : ''})`);
    if (found !== null && found < typed * 0.9) {
      fs.mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: `artifacts/office-${user}-fin.png` }).catch(() => {});
      log(`${user}: TEXTE MANQUANT dans la zone ${slot + 1} (${typed - found} phrases), capture artifacts/office-${user}-fin.png`);
    }
    return { ok: true, editor: detected };
  } catch (e) {
    log(`${user}: ÉCHEC édition (${e.message.split('\n')[0]}). url=${page.url()}`);
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/office-${user}.png` }).catch(() => {});
    return { ok: false, editor: detected };
  }
}

/**
 * Lance la phase d'édition pour les éditeurs gérés par CE PC.
 *  - inCall   : onglet supplémentaire dans le navigateur déjà en appel
 *  - separate : navigateur dédié (connexion, édition, fermeture)
 * @returns {Promise<{ok:number, failed:number}>}
 */
export async function runOffice({ cfg, plan, sessions, from, to, log, editorFrom, editorTo }) {
  const c = cfg.office;
  const durationSec = c.durationSec ?? 120;
  const stagger = (c.joinIntervalSec ?? 1) * 1000;
  const expected = plan.editor || 'auto';
  if (expected === 'nextcloud-office' && plan.format === 'odt') {
    log('ATTENTION: office.editor = nextcloud-office avec format odt: Nextcloud Office (Euro-Office) n\'édite pas l\'ODT.');
  }
  // inCall: les éditeurs sont des utilisateurs de l'appel de ce PC (plage from..to).
  // separate (comptes dédiés): si EDITOR_FROM / EDITOR_TO sont définis (numéros de comptes), ce PC prend les éditeurs de cette plage,
  // ce qui permet de RÉPARTIR les éditeurs sur plusieurs PC. Sinon: tout est pris par le PC qui lance le dernier utilisateur de l'appel.
  const hasRange = editorFrom != null || editorTo != null;
  const mine = plan.editors.filter((e) => {
    if (plan.mode === 'inCall') return e.index >= from && e.index <= to;
    if (hasRange) return e.index >= (editorFrom ?? 1) && e.index <= (editorTo ?? Infinity);
    return to === cfg.totalUsers;
  });
  if (!mine.length) log('Office: aucun éditeur pour ce PC (voir EDITOR_FROM / EDITOR_TO).');
  markPhase('office-start', { mode: plan.mode, documents: plan.documents, editorsPerDocument: plan.per, editors: mine.length, expectEditor: expected }, log);
  let docIds = {};
  try { docIds = JSON.parse(fs.readFileSync('logs/docs.json', 'utf8')); } catch { /* pas d'identifiants: clic seulement */ }
  if (mine.length) await readCollaboraVersion(cfg, log);
  let ok = 0, failed = 0;
  const seen = new Set();
  await Promise.all(mine.map(async (e, k) => {
    await C.sleep(k * stagger);
    const fileName = plan.fileName(e.doc);
    let launched = null, page = null, done = false;
    try {
      if (plan.mode === 'inCall') {
        // L'éditeur doit être DANS l'appel: on l'attend (la montée en charge peut durer encore après startAtSec)
        const waitEnd = Date.now() + 180000;
        let s = null, warned = false;
        while (Date.now() < waitEnd) {
          s = sessions.find((x) => x.index === e.index && x.inCall);
          if (s) break;
          if (!warned) { log(`${e.user}: pas encore dans l'appel, j'attends qu'il le rejoigne avant d'éditer`); warned = true; }
          await C.sleep(1000);
        }
        if (!s) { log(`${e.user}: toujours pas dans l'appel après 180 s, édition ignorée`); failed++; return; }
        await installCollaboraWelcomeSkip(s.context, collaboraVersion);
        await installEuroOfficeTipsSkip(s.context);
        page = await s.context.newPage(); // l'appel continue dans le 1er onglet
        await page.bringToFront().catch(() => {});
      } else {
        launched = await C.launchUser({ index: e.index, cfg, videoFile: null, audioFilePath: null, log });
        await installCollaboraWelcomeSkip(launched.context, collaboraVersion);
        await installEuroOfficeTipsSkip(launched.context);
        await C.login(launched.page, cfg.baseUrl, e.user, log);
        page = launched.page;
      }
      const r = await editDocument({ page, cfg, user: e.user, fileName, fileId: docIds[fileName], slot: e.slot, durationSec, log, expected });
      done = r.ok;
      if (r.editor) seen.add(r.editor);
    } catch (err) {
      log(`${e.user}: ÉCHEC édition (${err.message.split('\n')[0]})`);
    } finally {
      if (plan.mode === 'inCall') await page?.close().catch(() => {});
      else { await launched?.context.close().catch(() => {}); await launched?.browser.close().catch(() => {}); }
    }
    done ? ok++ : failed++;
  }));
  const detected = seen.size === 0 ? null : seen.size === 1 ? [...seen][0] : 'mixed';
  if (detected) log(`Éditeur utilisé : ${editorLabel(detected)}`);
  markPhase('office-stop', { ok, failed, detected }, log);
  return { ok, failed, detected };
}

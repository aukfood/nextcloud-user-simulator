/**
 * lib/provision.js - préparation (et nettoyage) de l'instance de test par l'API Nextcloud / Talk.
 *
 *  - utilisateurs : API de provisioning   POST/DELETE /ocs/v1.php/cloud/users
 *  - salons Talk  : API Talk (spreed v4)  POST/DELETE /ocs/v2.php/apps/spreed/api/v4/room
 *
 * Identifiants: bloc "credentials" de scenario.json (voir applyCredentials dans common.js),
 * surchargeables par NC_ADMIN_USER / NC_ADMIN_PASSWORD / NC_PASSWORD.
 *
 * Config (scenario.json), bloc optionnel "setup":
 *   "setup": { "roomAccess": "public" | "invite", "concurrency": 5, "autoCleanup": false | "ifSuccess" | true,
 *              "autoCleanupUsers": true, "disableFirstRunWizard": true }
 *   - public : salon ouvert, tout utilisateur connecté qui connaît le lien peut le rejoindre
 *   - invite : salon privé, les utilisateurs sont ajoutés comme participants
 */
import fs from 'node:fs';
import { userName, callUsers as C_callUsers, sleep, tlsHint } from './common.js';
import { officePlan, totalAccounts, makeDocument, DOC_MIME } from './office.js';

const userPassword = () => {
  const p = process.env.NC_PASSWORD;
  if (!p) throw new Error('mot de passe des comptes de test manquant: renseigner credentials.userPassword dans scenario.json');
  return p;
};

function adminAuth() {
  const user = process.env.NC_ADMIN_USER || 'admin';
  const pass = process.env.NC_ADMIN_PASSWORD;
  if (!pass) throw new Error('mot de passe admin manquant: renseigner credentials.adminPassword dans scenario.json');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** Appel OCS. body: objet JSON (Talk) ou { form: {...} } (provisioning). */
async function ocs(cfg, method, apiPath, body) {
  const headers = {
    Authorization: adminAuth(), 'OCS-APIRequest': 'true', Accept: 'application/json',
  };
  let payload;
  if (body?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body.form).toString();
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const sep = apiPath.includes('?') ? '&' : '?';
  const res = await ncFetch(`${cfg.baseUrl}${apiPath}${sep}format=json`, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* corps vide */ }
  return { http: res.status, meta: json?.ocs?.meta, data: json?.ocs?.data };
}

/** Exécute fn sur chaque élément avec au plus `limit` appels simultanés. */
async function pool(items, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** fetch avec un message clair si le certificat du serveur est refusé (voir insecureTls dans common.js). */
async function ncFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const hint = tlsHint(e);
    if (hint) throw new Error(`${hint} (${e.cause?.code || e.message})`);
    throw e;
  }
}

export async function createUsers(cfg, log) {
  const conc = cfg.setup?.concurrency ?? 5;
  const ids = Array.from({ length: totalAccounts(cfg) }, (_, k) => userName(k + 1)); // participants + éditeurs dédiés
  let created = 0, existing = 0;
  await pool(ids, conc, async (id) => {
    const r = await ocs(cfg, 'POST', '/ocs/v1.php/cloud/users', {
      form: { userid: id, password: userPassword(), displayName: `Load ${id}` },
    });
    if (r.meta?.statuscode === 100) created++;
    else if (r.meta?.statuscode === 102) existing++; // déjà là: on le réutilise
    else throw new Error(`création ${id} refusée: HTTP ${r.http} ${r.meta?.statuscode} ${r.meta?.message || ''} (politique de mot de passe ?)`);
  });
  log(`Utilisateurs: ${created} créés, ${existing} déjà existants`);
  return ids;
}

export async function createRooms(cfg, prefix, userIds, log) {
  const access = cfg.setup?.roomAccess ?? 'public';
  const rooms = [];
  for (let r = 1; r <= cfg.rooms; r++) {
    // roomType 3 = conversation publique, 2 = groupe (privée)
    const res = await ocs(cfg, 'POST', '/ocs/v2.php/apps/spreed/api/v4/room', {
      roomType: access === 'public' ? 3 : 2, roomName: `${prefix}-${r}`,
    });
    const token = res.data?.token;
    if (!token) throw new Error(`création salon ${r} refusée: HTTP ${res.http} ${res.meta?.message || ''}`);
    if (access === 'invite') {
      const members = userIds.filter((_, k) => k % cfg.rooms === r - 1);
      await pool(members, cfg.setup?.concurrency ?? 5, (id) =>
        ocs(cfg, 'POST', `/ocs/v2.php/apps/spreed/api/v4/room/${token}/participants`,
          { newParticipant: id, source: 'users' }));
    }
    rooms.push({ token, name: `${prefix}-${r}`, url: `${cfg.baseUrl}/call/${token}` });
    log(`Salon ${prefix}-${r} créé (${access}): ${cfg.baseUrl}/call/${token}`);
  }
  return rooms;
}

/**
 * Désactive l'assistant de première connexion (firstrunwizard) qui masque l'interface des comptes neufs.
 * Désactivable avec "setup": {"disableFirstRunWizard": false}.
 */
export async function disableFirstRunWizard(cfg, log) {
  if (cfg.setup?.disableFirstRunWizard === false) return;
  try {
    const res = await ncFetch(`${cfg.baseUrl}/ocs/v1.php/cloud/apps/firstrunwizard?format=json`, {
      method: 'DELETE',
      headers: { Authorization: adminAuth(), 'OCS-APIRequest': 'true', Accept: 'application/json' },
    });
    const json = await res.json().catch(() => null);
    const code = json?.ocs?.meta?.statuscode;
    if (code === 100 || res.ok) log('Assistant de première connexion (firstrunwizard) désactivé');
    else log(`ATTENTION: désactivation de firstrunwizard refusée (HTTP ${res.status}, code ${code}). Utiliser: sudo -u www-data php occ app:disable firstrunwizard`);
  } catch (e) {
    log(`ATTENTION: désactivation de firstrunwizard impossible (${e.message}). Utiliser occ app:disable firstrunwizard`);
  }
}

const adminName = () => process.env.NC_ADMIN_USER || 'admin';
const davUrl = (cfg, p) => `${cfg.baseUrl}/remote.php/dav/files/${encodeURIComponent(adminName())}/${p}`;

/** Crée les documents .odt ou .docx (office.format) de l'admin (WebDAV) et les partage en édition avec leurs éditeurs (API de partage). */
export async function createDocuments(cfg, log) {
  const plan = officePlan(cfg);
  if (!plan.enabled) return;
  const auth = { Authorization: adminAuth() };
  const mk = await ncFetch(davUrl(cfg, plan.folder), { method: 'MKCOL', headers: auth });
  if (![201, 405].includes(mk.status)) throw new Error(`création du dossier ${plan.folder} refusée (HTTP ${mk.status})`);
  const ids = {}; // nom du document => identifiant Nextcloud (pour l'ouvrir directement)
  for (let d = 1; d <= plan.documents; d++) {
    const name = plan.fileName(d);
    const put = await ncFetch(davUrl(cfg, `${plan.folder}/${name}`), {
      method: 'PUT', headers: { ...auth, 'Content-Type': DOC_MIME[plan.format] },
      body: makeDocument(plan.format, plan.per, `Document de charge ${d}`),
    });
    if (![201, 204].includes(put.status)) throw new Error(`création du document ${name} refusée (HTTP ${put.status})`);
    ids[name] = put.headers.get('oc-fileid') ? parseInt(put.headers.get('oc-fileid'), 10) : null;
    const editors = plan.editors.filter((e) => e.doc === d);
    await pool(editors, cfg.setup?.concurrency ?? 5, async (e) => {
      const r = await ocs(cfg, 'POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares', {
        form: { path: `/${plan.folder}/${name}`, shareType: '0', shareWith: e.user, permissions: '3' }, // 3 = lecture + modification
      });
      if (r.http !== 200) log(`ATTENTION: partage de ${name} avec ${e.user} refusé (HTTP ${r.http} ${r.meta?.message || ''})`);
    });
    log(`Document ${name} créé (id ${ids[name] ?? '?'}) et partagé avec ${editors.map((e) => e.user).join(', ')}`);
  }
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync('logs/docs.json', JSON.stringify(ids, null, 2)); // lu par le runner (et à copier sur les PC followers)
}

/**
 * Supprime le dossier des documents de charge (et donc leurs partages).
 * HTTP 423 (verrouillé): l'éditeur (Euro-Office surtout) enregistre et ferme encore les documents après la fermeture des navigateurs.
 * On réessaie alors toutes les 5 s pendant 60 s.
 */
async function deleteDocuments(cfg, log) {
  // Dossier des documents: office.folder, défaut 'loadtest-docs'.
  const folder = cfg.office?.folder || 'loadtest-docs';
  const start = Date.now();
  let r, waited = false;
  for (;;) {
    r = await ncFetch(davUrl(cfg, folder), { method: 'DELETE', headers: { Authorization: adminAuth() } });
    await r.text().catch(() => '');
    if (r.status !== 423 || Date.now() - start >= 60000) break;
    if (!waited) log(`Dossier de documents ${folder} encore verrouillé par l'éditeur (HTTP 423), nouvel essai toutes les 5 s pendant 60 s`);
    waited = true;
    await sleep(5000);
  }
  const after = waited ? ` après ${Math.round((Date.now() - start) / 1000)} s d'attente` : '';
  if (r.status === 204 || r.status === 200) log(`Dossier de documents ${folder} supprimé${after}`);
  else if (r.status === 423) {
    log(`ATTENTION: dossier ${folder} toujours verrouillé après 60 s (HTTP 423), NON supprimé. À supprimer à la main dans quelques minutes, `
      + `quand l'éditeur l'aura libéré : node cleanup.js scenario.json --rooms-only (supprime aussi les salons loadtest-*, garde les comptes), `
      + `ou Fichiers du compte admin, ou curl -k -u <admin> -X DELETE "${davUrl(cfg, folder)}"`);
  } else if (r.status !== 404) log(`ATTENTION: suppression du dossier ${folder} refusée (HTTP ${r.status})${after}`);
}

/** Crée utilisateurs + salons et écrit logs/rooms.json (lu par le follower). */
export async function provision(cfg, log) {
  adminAuth(); // échoue tout de suite, avec un message clair, si le mot de passe admin est vide
  await disableFirstRunWizard(cfg, log);
  // Préfixe des salons de test: 'loadtest-'. Le nettoyage supprime tous les salons ainsi nommés.
  const prefix = `loadtest-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const users = await createUsers(cfg, log);
  const rooms = C_callUsers(cfg) > 0 ? await createRooms(cfg, prefix, users.slice(0, cfg.totalUsers), log) : []; // office seul: pas de salon
  await createDocuments(cfg, log);
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync('logs/rooms.json', JSON.stringify({
    prefix, rooms: rooms.map((r) => r.url), tokens: rooms.map((r) => r.token),
    totalUsers: cfg.totalUsers,
  }, null, 2));
  log('logs/rooms.json écrit. Le copier sur chaque PC follower (ou définir ROOMS_URLS) avant son lancement.');
  return rooms.map((r) => r.url);
}

/**
 * Nettoyage.
 *  - par défaut (all = true): supprime TOUS les salons dont le nom commence par "loadtest-" (visibles du compte admin)
 *    et TOUS les utilisateurs "userNN" existants, quel que soit le test qui les a créés.
 *  - all = false: supprime seulement les salons de logs/rooms.json et user01..totalUsers (ancien comportement).
 * deleteUsers = false: ne touche pas aux utilisateurs. deleteRooms = false: ne touche pas aux salons.
 */
export async function cleanup(cfg, { deleteUsers = true, deleteRooms = true, all = true } = {}, log) {
  adminAuth();
  const conc = cfg.setup?.concurrency ?? 5;
  if (all && deleteUsers) log('ATTENTION: suppression de TOUS les comptes "user" + chiffres (user01, user02...), même ceux non créés par ces tests');

  // --- Salons ---
  if (deleteRooms) {
  let tokens = [];
  if (fs.existsSync('logs/rooms.json')) tokens = JSON.parse(fs.readFileSync('logs/rooms.json', 'utf8')).tokens || [];
  if (all) {
    const r = await ocs(cfg, 'GET', '/ocs/v2.php/apps/spreed/api/v4/room');
    const list = Array.isArray(r.data) ? r.data : [];
    // Nettoyage: tous les salons dont le nom commence par 'loadtest-'.
    const found = list.filter((x) => String(x.name || x.displayName || '').startsWith('loadtest-')).map((x) => x.token);
    if (r.http !== 200) log(`ATTENTION: liste des salons impossible (HTTP ${r.http}), seuls ceux de rooms.json seront supprimés`);
    tokens = [...new Set([...tokens, ...found])];
  }
  if (tokens.length) {
    await pool(tokens, conc, async (t) => {
      const r = await ocs(cfg, 'DELETE', `/ocs/v2.php/apps/spreed/api/v4/room/${t}`);
      log(`Salon ${t} supprimé (HTTP ${r.http})`);
    });
  } else log('Aucun salon à supprimer');
  if (fs.existsSync('logs/rooms.json')) fs.unlinkSync('logs/rooms.json');
  await deleteDocuments(cfg, log);
  if (fs.existsSync('logs/docs.json')) fs.unlinkSync('logs/docs.json');
  }

  // --- Utilisateurs ---
  if (deleteUsers) {
    let ids;
    if (all) {
      // Liste paginée (limit raisonnable, certains Nextcloud refusent les grandes valeurs)
      ids = [];
      for (let offset = 0; offset < 100000; offset += 100) {
        const r = await ocs(cfg, 'GET', `/ocs/v1.php/cloud/users?search=user&limit=100&offset=${offset}`);
        if (r.http !== 200 && r.meta?.statuscode !== 100) {
          log(`ATTENTION: liste des utilisateurs impossible (HTTP ${r.http}, code ${r.meta?.statuscode} ${r.meta?.message || ''})`);
          break;
        }
        const page = r.data?.users || [];
        ids.push(...page.filter((u) => /^user\d+$/.test(u)));
        if (page.length < 100) break;
      }
      if (!ids.length) {
        // Repli: les comptes user01..totalUsers du scenario courant
        ids = Array.from({ length: totalAccounts(cfg) }, (_, k) => userName(k + 1));
        log('Repli: suppression de user01..user' + String(ids.length).padStart(2, '0'));
      }
    } else {
      ids = Array.from({ length: totalAccounts(cfg) }, (_, k) => userName(k + 1));
    }
    await pool(ids, conc, (id) => ocs(cfg, 'DELETE', `/ocs/v1.php/cloud/users/${id}`));
    log(`${ids.length} utilisateurs supprimés${ids.length ? ` (${ids[0]}...${ids[ids.length - 1]})` : ''}`);
  }
}

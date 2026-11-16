/**
 * PC1 - LEADER (autonome)
 * Crée utilisateurs et salons par l'API Nextcloud (lib/provision.js), puis lance la plage d'utilisateurs USER_FROM..USER_TO
 * (par défaut 1..totalUsers). Peut tourner seul, ou avec un follower (PC2).
 *
 * IMPORTANT: START_AT = instant d'arrivée de user01. Utilisateurs et salons sont créés AVANT
 * cet instant: lancer donc le leader 2-3 minutes avant START_AT.
 * Identifiants: bloc "credentials" de scenario.json.
 *
 * Usage:
 *   node pc1-leader.js scenario.json
 *   START_AT=2026-11-03T10:00:00 USER_FROM=1 USER_TO=20 node pc1-leader.js scenario.json
 *   (START_AT avec fuseau: 2026-11-03T10:00:00+01:00 ou ...Z)
 */
import fs from 'node:fs';
import * as C from './lib/common.js';
import { markPhase, writeRunInfo, flushMetrics } from './lib/metrics.js';
import { runParticipants } from './lib/runner.js';
import { provision, cleanup } from './lib/provision.js';

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || 'scenario.json', 'utf8'));
C.applyCredentials(cfg);
const log = C.makeLogger('leader');
C.applyTlsSetting(cfg, log);
const USER_FROM = parseInt(process.env.USER_FROM || '1', 10);
const USER_TO = parseInt(process.env.USER_TO || String(cfg.totalUsers), 10);
// Répartition des éditeurs (comptes dédiés) entre PC: numéros de comptes, ex: EDITOR_FROM=1 EDITOR_TO=10
const EDITOR_FROM = process.env.EDITOR_FROM ? parseInt(process.env.EDITOR_FROM, 10) : undefined;
const EDITOR_TO = process.env.EDITOR_TO ? parseInt(process.env.EDITOR_TO, 10) : undefined;

(async () => {
  log(`Ce PC lance les utilisateurs ${USER_FROM} à ${USER_TO} sur ${cfg.totalUsers}.`
    + (USER_TO === cfg.totalUsers && USER_FROM === 1 ? ' Si un follower (PC2) est utilisé, définir USER_TO ici pour ne pas doubler ses utilisateurs.' : ''));
  C.assertFiles(C.requiredMedia(cfg, USER_FROM, USER_TO), log);
  writeRunInfo({ role: 'leader', cfg, userFrom: USER_FROM, userTo: USER_TO, turnMode: C.turnMode(cfg), turnTransport: C.turnTransport(cfg), scenarioType: C.scenarioType(cfg) });
  markPhase('setup', { role: 'leader', turnMode: C.turnMode(cfg), turnTransport: C.turnTransport(cfg), scenarioType: C.scenarioType(cfg) }, log);

  // --- Préparation par l'API: utilisateurs + salons (le leader est le SEUL à le faire) ---
  // Nécessite credentials.adminPassword dans scenario.json.
  let roomUrls;
  try {
    roomUrls = await provision(cfg, log);
  } catch (e) {
    log(`ERREUR préparation: ${e.message}`);
    process.exit(1);
  }

  // t0 = START_AT si fourni, sinon maintenant
  const t0 = C.parseStartAt(process.env.START_AT, log) ?? Date.now();
  const result = await runParticipants({ cfg, from: USER_FROM, to: USER_TO, roomUrls, t0, log, editorFrom: EDITOR_FROM, editorTo: EDITOR_TO });
  const edLabel = { collabora: 'Collabora', 'nextcloud-office': 'Nextcloud Office', mixed: 'mixte' };
  const ed = result.office?.detected ? ` Éditeur utilisé : ${edLabel[result.office.detected] || result.office.detected}.` : '';
  const cb = result.office ? ` Édition: ${result.office.ok} éditeur(s) ok, ${result.office.failed} en échec.${ed}` : '';
  if (C.scenarioType(cfg) === 'office') log(`Bilan:${cb}`);
  else log(`Bilan: ${result.joined}/${result.expected} utilisateurs ont rejoint l'appel, ${result.inCallEnd}/${result.expected} y étaient encore à la fin, ${result.left} ont quitté l'appel proprement${result.leaveFailed ? ` (${result.leaveFailed} sortie(s) non confirmée(s))` : ''}.${cb}`);

  // --- Nettoyage automatique (option "setup.autoCleanup") ---
  //   false (défaut)  : pas de nettoyage (faire: node cleanup.js scenario.json)
  //   "ifSuccess"     : nettoie seulement si tous les utilisateurs ont rejoint et sont restés dans l'appel
  //   true            : nettoie toujours
  // Désactivé si ce PC ne lance qu'une partie des utilisateurs (un follower utilise encore les salons).
  const mode = cfg.setup?.autoCleanup ?? false;
  const fullRange = USER_FROM === 1 && USER_TO === cfg.totalUsers && EDITOR_FROM === undefined && EDITOR_TO === undefined;
  if (mode && !fullRange) {
    log('Auto-nettoyage ignoré: ce PC ne lance qu\'une partie des utilisateurs ou des éditeurs (un autre PC utilise les salons ou les documents). Lancer ensuite: node cleanup.js scenario.json');
  } else if (mode === true || (mode === 'ifSuccess' && result.success)) {
    markPhase('cleanup', {}, log);
    try {
      await cleanup(cfg, { deleteUsers: cfg.setup?.autoCleanupUsers !== false, all: false }, log); // all:false = seulement CE test
    } catch (e) {
      log(`ATTENTION: auto-nettoyage en échec (${e.message}). Lancer: node cleanup.js scenario.json`);
    }
  } else if (mode) {
    log('Test incomplet: pas de nettoyage automatique, pour pouvoir analyser. Lancer ensuite: node cleanup.js scenario.json');
  } else {
    log('Nettoyage automatique désactivé (setup.autoCleanup). Pour supprimer : node cleanup.js scenario.json');
  }
  await flushMetrics();
  process.exit(0);
})().catch((e) => { log(`ERREUR FATALE: ${e.stack}`); process.exit(1); });

/**
 * lib/runner.js - déroulé commun leader/follower pour une plage d'utilisateurs.
 *
 * Chronologie ABSOLUE (identique sur les deux PC si START_AT est le même):
 *   t0                      : arrivée de user01
 *   t0 + (i-1)*joinInterval : arrivée de l'utilisateur i (index GLOBAL)
 *   rampEnd                 : arrivée du dernier utilisateur => phase "steady"
 *   rampEnd + startAtSec    : partage d'écran / édition
 *   rampEnd + durationSec   : fin du plateau => "teardown"
 */
import fs from 'node:fs';
import * as C from './common.js';
import { markPhase, startStatsLoop } from './metrics.js';
import { officePlan, runOffice } from './office.js';

export async function runParticipants({ cfg, from, to, roomUrls, t0, log, editorFrom, editorTo }) {
  const interval = cfg.joinIntervalSec * 1000;
  const rampEnd = t0 + (cfg.totalUsers - 1) * interval;
  const endAt = rampEnd + cfg.durationSec * 1000;
  const sessions = []; // sessions vivantes (lues par la boucle de stats)
  const callOnly = C.scenarioType(cfg) === 'office'; // office seul: pas d'appel

  async function joinOne(i) {
    const user = C.userName(i);
    // % par salon: même nombre de salons que la répartition ci-dessous (roomUrls)
    const video = C.hasVideo(i, cfg.videoPercent, roomUrls.length) ? C.camFile(i, cfg.mediaDir) : null;
    const audio = C.hasAudio(i, cfg.audioPercent, roomUrls.length) ? C.audioFile(i, cfg.mediaDir) : null;
    const screen = C.isSharer(i, cfg, roomUrls.length) ? C.screenFile(cfg) : null;
    const room = (i - 1) % roomUrls.length;
    let session;
    let step = 'lancement du navigateur';
    try {
      session = await C.launchUser({
        index: i, cfg, videoFile: video, audioFilePath: audio,
        screenFilePath: screen, log,
      });
      sessions.push(session);
      step = 'connexion';
      await C.login(session.page, cfg.baseUrl, user, log);
      await C.dismissOverlays(session.page, user, log);
      step = 'ouverture du salon';
      await session.page.goto(roomUrls[room], { waitUntil: 'domcontentloaded' });
      await C.dismissOverlays(session.page, user, log);
      step = "clic sur le bouton d'appel";
      session.inCall = await C.joinCall(session.page, user, log);
      log(`${user}: webcam=${video ? 'oui' : 'non'}, micro=${audio ? 'oui' : 'non'}, salon=${room + 1}${screen ? ', sharer' : ''}`);
      if (session.inCall) {
        // 1er essai à 5 s; si encore seul dans le salon (souvent le 1er de chaque salon), nouvel essai non bloquant plus tard.
        const retryMs = Math.max(cfg.joinIntervalSec || 5, 5) * 1000 * Math.max(roomUrls.length, 1);
        const tryTurn = (left) => {
          C.logTurnServers(session, log).then((ok) => {
            if (!ok && left > 0) setTimeout(() => tryTurn(left - 1), retryMs);
          });
        };
        setTimeout(() => tryTurn(2), 5000);
      }
    } catch (e) {
      log(`${user}: ÉCHEC à l'étape "${step}": ${e.message.split('\n')[0]}`);
      if (session) {
        fs.mkdirSync('artifacts', { recursive: true });
        const shot = `artifacts/fail-${user}.png`;
        await session.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        log(`${user}: URL=${session.page.url()} capture=${shot}`);
      }
    }
  }

  const stopStats = startStatsLoop({
    sessions, intervalSec: cfg.metrics?.statsIntervalSec ?? 10, log,
    expectedTransport: C.turnTransport(cfg),
  });

  // --- Phases planifiées (timers absolus) ---
  const at = (ts, fn) => setTimeout(fn, Math.max(0, ts - Date.now()));
  const sharers = () => sessions.filter((s) => C.isSharer(s.index, cfg, roomUrls.length) && s.inCall);

  if (!callOnly) at(rampEnd, () => markPhase('steady', { users: cfg.totalUsers }, log));

  if (cfg.screenShare?.enabled && !callOnly) {
    const start = rampEnd + cfg.screenShare.startAtSec * 1000;
    const stop = start + cfg.screenShare.durationSec * 1000;
    at(start, async () => {
      const perRoom = cfg.screenShare.sharers ?? 1;
      const total = C.countSharers(cfg, cfg.totalUsers, roomUrls.length);
      markPhase('screenshare-start', { perRoom, rooms: roomUrls.length, total }, log);
      await Promise.all(sharers().map((s) => C.startScreenShare(s.page, s.user, log)));
    });
    at(stop, async () => {
      markPhase('screenshare-stop', {}, log);
      await Promise.all(sharers().map((s) => C.stopScreenShare(s.page, s.user, log)));
    });
  }

  // Édition: documents partagés, édition simultanée (voir lib/office.js). Les éditeurs "inCall" restent en appel.
  const plan = officePlan(cfg);
  let collabStarted = false;
  let officeTimer = null;
  let resolveCollab;
  const officeRun = new Promise((r) => { resolveCollab = r; }); // résolu à la fin de la phase d'édition
  if (plan.enabled) {
    const cb = cfg.office || {};
    const start = (callOnly ? t0 : rampEnd) + (cb.startAtSec ?? 30) * 1000;
    if (!callOnly && start + (cb.durationSec ?? 120) * 1000 > endAt) {
      log('ATTENTION: la phase d\'édition dépasse la fin du plateau: la sortie de l\'appel sera retardée. Réduis office.durationSec ou augmente durationSec.');
    }
    officeTimer = at(start, () => { collabStarted = true; runOffice({ cfg, plan, sessions, from, to, log, editorFrom, editorTo }).then(resolveCollab); });
  }

  // --- Montée en charge ---
  markPhase('wait-start', { t0: new Date(t0).toISOString() }, log);
  const joins = [];
  for (let i = from; i <= to && !callOnly; i++) {
    await C.sleepUntil(t0 + (i - 1) * interval);
    if (i === from) markPhase('ramp-up', { from, to }, log);
    joins.push(joinOne(i));
  }
  await Promise.all(joins);
  const ok = sessions.filter((s) => s.inCall).length;
  const rampOk = ok;
  if (!callOnly) log(`Montée en charge terminée: ${ok}/${to - from + 1} utilisateurs dans l'appel`);

  // --- Sortie propre: chaque utilisateur quitte l'appel avant la fermeture du navigateur ---
  let leaving = null;
  async function leaveAll() {
    if (leaving) return leaving; // une seule fois (fin normale ou Ctrl+C)
    leaving = (async () => {
      markPhase('leave', {}, log);
      const results = await Promise.all(sessions.filter((s) => s.inCall).map(async (s) => {
        const r = await C.leaveCall(s.page, s.user, log);
        log(`${s.user}: ${r === 'ok' ? 'a quitté l\'appel' : r === 'absent' ? 'n\'était plus dans l\'appel' : 'ATTENTION sortie de l\'appel non confirmée'}`);
        return r;
      }));
      await C.sleep(2000); // laisse Talk/HPB enregistrer les départs
      return { left: results.filter((r) => r === 'ok').length, absent: results.filter((r) => r === 'absent').length, failed: results.filter((r) => r === 'echec').length };
    })();
    return leaving;
  }
  // Ctrl+C: on quitte proprement l'appel avant de sortir
  const onSigint = async () => {
    log('Interruption (Ctrl+C): sortie propre de l\'appel puis fermeture');
    stopStats();
    await leaveAll();
    await C.closeAll(sessions, log);
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  // --- Plateau puis arrêt ---
  log(callOnly ? 'Scénario office seul: pas d\'appel, attente de la fin de l\'édition' : `Plateau jusqu'à ${new Date(endAt).toISOString()}`);
  if (!callOnly) await C.sleepUntil(endAt); // office seul: on attend simplement la fin de l'édition
  // Les éditeurs ont fini avant la sortie de l'appel (ou la phase n'a pas eu lieu)
  if (!collabStarted && !callOnly) { clearTimeout(officeTimer); resolveCollab(null); } // phase prévue après la fin du plateau
  const collab = plan.enabled ? await officeRun : null;
  // Présence RÉELLE en fin de plateau: le bouton "Quitter l'appel" doit toujours être visible.
  // (les éditeurs "inCall" éditent dans un 2e onglet et restent en appel)
  const checkable = sessions.filter((s) => s.inCall);
  const present = await Promise.all(checkable.map(async (s) => {
    const here = await s.page.locator(C.SEL.leaveCall).first().isVisible().catch(() => false);
    if (!here) log(`${s.user}: ATTENTION n'est plus dans l'appel en fin de test`);
    return here;
  }));
  const inCallEnd = present.filter(Boolean).length;
  const expectedEnd = callOnly ? 0 : to - from + 1;
  markPhase('teardown', { inCall: inCallEnd, expected: expectedEnd }, log);
  stopStats();
  const left = await leaveAll();
  await C.closeAll(sessions, log);
  markPhase('end', { left: left.left, failed: left.failed }, log);
  process.removeListener('SIGINT', onSigint);
  // Bilan renvoyé à l'appelant (utilisé par l'auto-nettoyage du leader)
  const expected = callOnly ? 0 : to - from + 1;
  const collabOk = !plan.enabled || (collab && collab.failed === 0 && collab.ok > 0);
  return { expected, joined: rampOk, inCallEnd, expectedEnd, left: left.left, leaveFailed: left.failed, success: rampOk === expected && inCallEnd === expectedEnd && collabOk, office: collab };
}

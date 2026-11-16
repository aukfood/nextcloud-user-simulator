/**
 * FOLLOWER (PC2, PC3, ...: même script sur chaque PC supplémentaire, avec sa propre plage USER_FROM/USER_TO)
 * NE CRÉE AUCUN SALON. Lit les URLs créées par le PC1 (logs/rooms.json copié
 * depuis le PC1, ou variable ROOMS_URLS séparée par des virgules), attend qu'elles
 * soient joignables, puis lance ses utilisateurs sur la même chronologie que le PC1.
 *
 * START_AT doit être IDENTIQUE à celui du leader (sinon les deux PC ne sont pas
 * alignés). Les horloges des deux PC doivent être synchronisées (NTP).
 *
 * Usage:
 *   START_AT=2026-11-03T10:00:00+01:00 USER_FROM=21 USER_TO=40 node pc2-follower.js scenario.json
 *
 * Office seul (pas d'appel): USER_FROM inutile, on répartit les éditeurs par numéros de comptes:
 *   START_AT=2026-11-03T10:00:00+01:00 EDITOR_FROM=11 EDITOR_TO=20 node pc2-follower.js scenario.json
 * (optionnel: copier logs/docs.json du PC1; sans lui, le document est ouvert par clic dans la liste des fichiers)
 */
import fs from 'node:fs';
import * as C from './lib/common.js';
import { markPhase, writeRunInfo, flushMetrics } from './lib/metrics.js';
import { runParticipants } from './lib/runner.js';

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || 'scenario.json', 'utf8'));
C.applyCredentials(cfg);
const log = C.makeLogger('follower');
C.applyTlsSetting(cfg, log);
const officeOnly = C.scenarioType(cfg) === 'office';
if (!process.env.USER_FROM && !officeOnly) {
  log('ERREUR: USER_FROM obligatoire sur le follower (premier utilisateur de ce PC), ex: USER_FROM=21 USER_TO=40. Le leader lance 1..USER_TO.');
  process.exit(1);
}
const USER_FROM = parseInt(process.env.USER_FROM || '1', 10);
const USER_TO = parseInt(process.env.USER_TO || String(cfg.totalUsers), 10);
const EDITOR_FROM = process.env.EDITOR_FROM ? parseInt(process.env.EDITOR_FROM, 10) : undefined;
const EDITOR_TO = process.env.EDITOR_TO ? parseInt(process.env.EDITOR_TO, 10) : undefined;
if (officeOnly && EDITOR_FROM === undefined && EDITOR_TO === undefined) {
  log('ERREUR: en mode office seul, définir EDITOR_FROM et/ou EDITOR_TO (numéros de comptes des éditeurs de ce PC), sinon ce PC ne ferait rien.');
  process.exit(1);
}

function loadRoomUrls() {
  if (process.env.ROOMS_URLS) return process.env.ROOMS_URLS.split(',');
  if (fs.existsSync('logs/rooms.json')) return JSON.parse(fs.readFileSync('logs/rooms.json', 'utf8')).rooms;
  log('ERREUR: aucune URL de salon. Copier logs/rooms.json du PC1 ou définir ROOMS_URLS.');
  process.exit(1);
}

async function waitRoomsReady(page, urls) {
  for (const url of urls) {
    const deadline = Date.now() + 120000;
    let ok = false;
    let lastErr = '';
    let status = '';
    while (Date.now() < deadline && !ok) {
      try {
        // Délais 60 s / 15 s; à ajuster selon le serveur.
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        status = resp ? String(resp.status()) : '';
        await C.dismissOverlays(page, 'probe', log).catch(() => {});
        await page.locator(`${C.SEL.startCall}, ${C.SEL.joinCall}`).first().waitFor({ timeout: 15000 });
        ok = true;
      } catch (e) { lastErr = e.message.split('\n')[0]; await C.sleep(3000); }
    }
    if (!ok) {
      // Diagnostic: ce que voit réellement le navigateur du PC2
      fs.mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: 'artifacts/follower-salon-injoignable.png' }).catch(() => {});
      const title = await page.title().catch(() => '?');
      const buttons = await page.locator('button:visible').allInnerTexts().catch(() => []);
      log(`DIAGNOSTIC: URL finale ${page.url()} | HTTP ${status || '?'} | titre "${title}" | dernier message: ${lastErr}`);
      log(`DIAGNOSTIC: boutons visibles: ${JSON.stringify(buttons.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15))}`);
      log('DIAGNOSTIC: capture dans artifacts/follower-salon-injoignable.png');
      const hint = C.tlsHint(lastErr);
      if (hint) log(`ERREUR: ${hint}`);
      log(`ERREUR: salon injoignable après 120 s: ${url}`);
      process.exit(1);
    }
    log(`Salon prêt: ${url}`);
  }
}

(async () => {
  const roomUrls = officeOnly ? [] : loadRoomUrls(); // office seul: pas de salon
  C.assertFiles(C.requiredMedia(cfg, USER_FROM, USER_TO), log);
  writeRunInfo({ role: 'follower', cfg, userFrom: USER_FROM, userTo: USER_TO, turnMode: C.turnMode(cfg), turnTransport: C.turnTransport(cfg), scenarioType: C.scenarioType(cfg) });
  markPhase('setup', { role: 'follower', turnMode: C.turnMode(cfg), turnTransport: C.turnTransport(cfg), scenarioType: C.scenarioType(cfg) }, log);

  // Vérification que les salons existent (via le 1er utilisateur du follower)
  if (!officeOnly) {
    const probe = await C.launchUser({
      index: USER_FROM, cfg, videoFile: null, audioFilePath: C.audioFile(USER_FROM, cfg.mediaDir), log,
    });
    await C.login(probe.page, cfg.baseUrl, C.userName(USER_FROM), log);
    await waitRoomsReady(probe.page, roomUrls);
    await C.closeAll([probe], log);
  }

  if (!process.env.START_AT) log('ATTENTION: START_AT absent, le follower démarre maintenant: pas aligné avec le leader.');
  const t0 = C.parseStartAt(process.env.START_AT, log) ?? Date.now();
  await runParticipants({ cfg, from: USER_FROM, to: USER_TO, roomUrls, t0, log, editorFrom: EDITOR_FROM, editorTo: EDITOR_TO });
  await flushMetrics();
  process.exit(0);
})().catch((e) => { log(`ERREUR FATALE: ${e.stack}`); process.exit(1); });

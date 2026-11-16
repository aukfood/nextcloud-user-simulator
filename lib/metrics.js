/**
 * lib/metrics.js
 * - markPhase()      : marqueurs de phase horodatés (JSON Lines) + annotation Grafana optionnelle
 * - writeRunInfo()   : snapshot de la config du run
 * - startStatsLoop() : relevé périodique des stats WebRTC de chaque navigateur
 *
 * Tous les horodatages sont en ISO UTC (suffixe Z) + epochMs, faciles à
 * retrouver dans Grafana. Les fichiers vont dans ./logs :
 *   phases-<host>-<runId>.jsonl   stats-<host>-<runId>.jsonl   run-<host>-<runId>.json
 *
 * Annotation Grafana (optionnelle) : définir GRAFANA_URL (ex. https://grafana.example.net)
 * et GRAFANA_TOKEN (token de service avec droit d'écrire les annotations).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = os.hostname();
export const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = 'logs';

function append(file, obj) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, file), JSON.stringify(obj) + '\n');
}

const pending = new Set(); // annotations Grafana en cours d'envoi

/** À appeler avant process.exit(): attend les annotations Grafana encore en vol. */
export async function flushMetrics() { await Promise.allSettled([...pending]); }

async function grafanaAnnotate(phase, extra, epochMs) {
  // GRAFANA_URL et GRAFANA_TOKEN viennent des variables d'environnement; jamais de jeton dans les fichiers.
  const { GRAFANA_URL, GRAFANA_TOKEN } = process.env;
  if (!GRAFANA_URL || !GRAFANA_TOKEN) return;
  try {
    await fetch(`${GRAFANA_URL}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GRAFANA_TOKEN}` },
      body: JSON.stringify({
        time: epochMs,
        // Tag d'annotation 'nextcloud-user-simulator': doit correspondre au tableau de bord Grafana.
        tags: ['nextcloud-user-simulator', RUN_ID, phase],
        text: `${phase} ${Object.keys(extra).length ? JSON.stringify(extra) : ''} (${HOST})`,
      }),
    });
  } catch { /* l'annotation est un bonus: on ne casse jamais le test */ }
}

/** Marque une phase du test (ramp-up, steady, screenshare-start, ...). */
export function markPhase(phase, extra = {}, log) {
  const now = Date.now();
  append(`phases-${HOST}-${RUN_ID}.jsonl`, {
    ts: new Date(now).toISOString(), epochMs: now, host: HOST, runId: RUN_ID, phase, ...extra,
  });
  log?.(`PHASE ${phase} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`);
  const pr = grafanaAnnotate(phase, extra, now);
  pending.add(pr);
  pr.finally(() => pending.delete(pr));
}

export function writeRunInfo(info) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LOG_DIR, `run-${HOST}-${RUN_ID}.json`),
    JSON.stringify({ runId: RUN_ID, host: HOST, node: process.version, ...info }, null, 2),
  );
}

/** Exécuté DANS le navigateur: résume getStats() de toutes les PeerConnections. */
async function pageStats() {
  const pcs = (window.__pcs || []).filter((pc) => pc.connectionState !== 'closed');
  const res = {
    pcCount: pcs.length, bytesSent: 0, bytesReceived: 0, packetsLost: 0, packetsReceived: 0,
    jitterMaxMs: 0, framesDecoded: 0, framesDropped: 0, fpsOut: [], heightOut: [],
    qualityLimit: {}, rttMs: [], candidates: {},
  };
  for (const pc of pcs) {
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    const byId = {};
    report.forEach((r) => { byId[r.id] = r; });
    report.forEach((r) => {
      if (r.type === 'outbound-rtp') {
        res.bytesSent += r.bytesSent || 0;
        if (r.kind === 'video') {
          if (r.framesPerSecond) res.fpsOut.push(r.framesPerSecond);
          if (r.frameHeight) res.heightOut.push(r.frameHeight);
          const q = r.qualityLimitationReason || 'none';
          res.qualityLimit[q] = (res.qualityLimit[q] || 0) + 1;
        }
      } else if (r.type === 'inbound-rtp') {
        res.bytesReceived += r.bytesReceived || 0;
        res.packetsLost += r.packetsLost || 0;
        res.packetsReceived += r.packetsReceived || 0;
        res.jitterMaxMs = Math.max(res.jitterMaxMs, (r.jitter || 0) * 1000);
        if (r.kind === 'video') {
          res.framesDecoded += r.framesDecoded || 0;
          res.framesDropped += r.framesDropped || 0;
        }
      } else if (r.type === 'transport' && r.selectedCandidatePairId) {
        const pair = byId[r.selectedCandidatePairId];
        if (!pair) return;
        const l = byId[pair.localCandidateId];
        const rm = byId[pair.remoteCandidateId];
        if (pair.currentRoundTripTime != null) res.rttMs.push(pair.currentRoundTripTime * 1000);
        // ex: "relay/udp(udp)->host" = candidat relayé; entre parenthèses, le protocole vers le TURN (udp/tcp/tls) quand il est connu
        const key = `${l?.candidateType}/${l?.protocol}${l?.relayProtocol ? `(${l.relayProtocol})` : ''}->${rm?.candidateType}`;
        res.candidates[key] = (res.candidates[key] || 0) + 1;
      }
    });
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    pcCount: res.pcCount,
    bytesSent: res.bytesSent, bytesReceived: res.bytesReceived,
    packetsLost: res.packetsLost, packetsReceived: res.packetsReceived,
    jitterMaxMs: Math.round(res.jitterMaxMs * 10) / 10,
    framesDecoded: res.framesDecoded, framesDropped: res.framesDropped,
    fpsOutAvg: avg(res.fpsOut), heightOutMax: res.heightOut.length ? Math.max(...res.heightOut) : null,
    qualityLimit: res.qualityLimit, rttMsAvg: avg(res.rttMs), candidates: res.candidates,
  };
}

export async function collectUserStats(page) {
  return page.evaluate(pageStats);
}

/**
 * Relève les stats de chaque session "dans l'appel" toutes les intervalSec.
 * sessions: tableau vivant d'objets { user, page, inCall }.
 * Retourne une fonction stop().
 */
/**
 * Alerte si le transport réellement utilisé ne correspond pas à turnTransport.
 * Clés attendues: "relay/udp(udp)->host" (TURN UDP), "relay/udp(tcp)->host" (TURN TCP), "relay/udp(tls)->host" (TURN TLS).
 */
function checkTransport(user, candidates, expected, warned, log) {
  if (expected === 'any' || !candidates) return;
  for (const key of Object.keys(candidates)) {
    const m = /^(\w+)\/\w+(?:\((\w+)\))?->/.exec(key);
    const type = m?.[1];
    const relayProto = m?.[2];
    let problem = null;
    if (type !== 'relay') problem = 'connexion sans relais TURN';
    else if (relayProto && relayProto !== expected) problem = `transport TURN ${relayProto} au lieu de ${expected}`;
    if (problem && !warned.has(`${user}|${key}`)) {
      warned.add(`${user}|${key}`);
      log?.(`${user}: ATTENTION ${problem} (candidat ${key}, turnTransport=${expected})`);
    }
  }
}

/** Charge du PC qui lance les navigateurs (CPU global sur l'intervalle + mémoire libre). */
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return { idle, total };
}

export function startStatsLoop({ sessions, intervalSec, log, expectedTransport = 'any' }) {
  const warned = new Set(); // une alerte par utilisateur et par type de candidat
  if (!intervalSec || intervalSec <= 0) return () => {};
  let prevCpu = cpuTimes();
  let loadWarns = 0;
  const timer = setInterval(async () => {
    const now = Date.now();
    // Charge du PC de test: si elle est saturée, les mesures côté serveur ne sont pas fiables
    const cur = cpuTimes();
    const dTotal = cur.total - prevCpu.total;
    const cpuPct = dTotal > 0 ? Math.round(100 * (1 - (cur.idle - prevCpu.idle) / dTotal)) : 0;
    prevCpu = cur;
    const memFreeMb = Math.round(os.freemem() / 1048576);
    append(`client-${HOST}-${RUN_ID}.jsonl`, { ts: new Date(now).toISOString(), epochMs: now, host: HOST, cpuPct, memFreeMb, load1: +os.loadavg()[0].toFixed(2), users: sessions.filter((x) => x.inCall).length });
    // Seuil d'alerte CPU (85 %): au-delà, les mesures serveur peuvent être faussées.
    if (cpuPct >= 85 && loadWarns++ % 3 === 0) {
      log?.(`ATTENTION: PC de test saturé (CPU ${cpuPct} %, ${memFreeMb} Mo libres): les mesures peuvent être faussées, répartir les utilisateurs sur un second PC (USER_FROM/USER_TO).`);
    }
    await Promise.all(sessions.filter((s) => s.inCall).map(async (s) => {
      try {
        const stats = await collectUserStats(s.page);
        checkTransport(s.user, stats.candidates, expectedTransport, warned, log);
        append(`stats-${HOST}-${RUN_ID}.jsonl`, {
          ts: new Date(now).toISOString(), epochMs: now, host: HOST, user: s.user, ...stats,
        });
      } catch (e) {
        log?.(`${s.user}: stats indisponibles (${e.message.split('\n')[0]})`);
      }
    }));
  }, intervalSec * 1000);
  return () => clearInterval(timer);
}

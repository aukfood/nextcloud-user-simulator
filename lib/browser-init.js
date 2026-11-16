/**
 * lib/browser-init.js
 * Scripts injectés dans le navigateur AVANT le chargement de Talk.
 *  1. Hook RTCPeerConnection : (a) force éventuellement le relais TURN
 *     (iceTransportPolicy = 'relay'), (b) mémorise les connexions pour
 *     pouvoir lire getStats() depuis Node.
 *  2. Faux getDisplayMedia : le "partage d'écran" lit un MP4 (comme l'ancien spec screenshare-test).
 */
import fs from 'node:fs';

/**
 * @param {import('playwright').BrowserContext} context
 * @param {boolean} forceRelay  true => aucun candidat direct, uniquement TURN
 * @param {'any'|'udp'|'tcp'|'tls'} transport  filtre les serveurs TURN annoncés par Talk:
 *   udp = turn:...?transport=udp (ex. 3478) / tcp = turn:...?transport=tcp / tls = turns:... (ex. 443) / any = tout
 * La liste reçue et la liste réellement utilisée sont mémorisées dans window.__turnInfo (lue par logTurnServers).
 */
export async function installPeerConnectionHook(context, forceRelay, transport = 'any') {
  await context.addInitScript(({ relay, transport }) => {
    const Orig = window.RTCPeerConnection;
    if (!Orig || window.__pcHooked) return;
    window.__pcHooked = true;
    window.__pcs = [];
    window.__turnInfo = { transport, received: [], used: [], rewritten: false };

    // Filtre les URLs des serveurs ICE selon le transport voulu
    const urlsOf = (s) => [].concat(s.urls || s.url || []);
    const isTurn = (u) => /^turns?:/i.test(u);
    const transportOf = (u) => {
      if (/^turns:/i.test(u)) return 'tls';
      const m = /[?&]transport=(udp|tcp)/i.exec(u);
      return m ? m[1].toLowerCase() : 'udp'; // turn: sans paramètre = UDP
    };
    const filterServers = (servers) => {
      const list = [].concat(servers || []);
      window.__turnInfo.received = list.flatMap(urlsOf);
      if (transport === 'any') { window.__turnInfo.used = window.__turnInfo.received; return servers; }
      const build = (keep) => list
        .map((s) => ({ ...s, urls: urlsOf(s).map(keep).filter(Boolean) }))
        .filter((s) => s.urls.length);
      // 1) on garde les URLs TURN qui correspondent, et toutes les URLs non TURN (stun)
      let out = build((u) => (!isTurn(u) || transportOf(u) === transport ? u : null));
      // 2) si Talk n'annonce aucun TURN de ce type (udp/tcp), on réécrit le paramètre transport
      if (!out.some((s) => urlsOf(s).some(isTurn)) && transport !== 'tls') {
        out = build((u) => (!isTurn(u) || /^turns:/i.test(u) ? null
          : (u.replace(/([?&])transport=(udp|tcp)/i, '').replace(/\?$/, '') + `?transport=${transport}`)));
        window.__turnInfo.rewritten = true;
      }
      window.__turnInfo.used = out.flatMap(urlsOf);
      return out;
    };

    const Hooked = function (config, ...rest) {
      const cfg = Object.assign({}, config || {});
      if (relay) cfg.iceTransportPolicy = 'relay';
      if (cfg.iceServers) cfg.iceServers = filterServers(cfg.iceServers);
      const pc = new Orig(cfg, ...rest);
      window.__pcs.push(pc);
      return pc;
    };
    Hooked.prototype = Orig.prototype;
    Object.setPrototypeOf(Hooked, Orig); // garde generateCertificate(), etc.
    window.RTCPeerConnection = Hooked;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Hooked;
  }, { relay: forceRelay, transport });
}

/**
 * Remplace getDisplayMedia par la lecture en boucle d'un MP4 (même principe
 * que l'ancien spec screenshare-test). Le MP4 est servi par une route Playwright
 * sur la même origine que Nextcloud (pas de problème CORS), avec support des
 * requêtes Range pour que la boucle (seek à 0) fonctionne.
 */
export async function installFakeScreenShare(context, baseUrl, filePath) {
  const buf = fs.readFileSync(filePath);
  const url = `${baseUrl}/__fake_screen.mp4`;

  await context.route('**/__fake_screen.mp4', (route) => {
    const common = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    const range = route.request().headers()['range'];
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      return route.fulfill({
        status: 206,
        contentType: 'video/mp4',
        headers: { ...common, 'Content-Range': `bytes ${start}-${end}/${buf.length}` },
        body: buf.subarray(start, end + 1),
      });
    }
    return route.fulfill({ status: 200, contentType: 'video/mp4', headers: common, body: buf });
  });

  // captureStream() sans argument: cadence = celle du MP4 (pas de réglage dans scenario.json).
  await context.addInitScript(({ videoUrl }) => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getDisplayMedia = async () => {
      const v = document.createElement('video');
      v.src = videoUrl;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
      document.body.appendChild(v);
      await v.play();
      if (v.readyState < 2) {
        await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      }
      const stream = v.captureStream();
      const track = stream.getVideoTracks()[0];
      if (track && 'contentHint' in track) track.contentHint = 'detail'; // texte/écran
      window.__shareTrack = track; // permet à Node de vérifier / arrêter le partage
      track.addEventListener('ended', () => v.pause());
      return stream;
    };
  }, { videoUrl: url });
}

/**
 * Collabora: empêche la page d'accueil ("Explore The New ...") et la fenêtre d'avis ("Your Review Is Our Best Motivation") de s'afficher.
 * Clés lues par Collabora 26.04 (window.prefs = localStorage, sauf réglage déjà enregistré pour l'utilisateur côté serveur):
 *  - Map.Welcome.js : WSDWelcomeVersion = version du serveur (celle écrite quand on clique sur sa croix), ou
 *                     WSDWelcomeDisabled = 'true' et WSDWelcomeDisabledDate = date du jour (format "Mon-Nov-09-2026").
 *  - Map.Feedback.js: WSDFeedbackEnabled = 'false' (= bouton "Do not show again"); la fenêtre n'est alors jamais proposée.
 *                     WSDFeedbackLaterDate = maintenant (= bouton "Later": rien avant 5 jours), en plus.
 * On écrit tout dans toutes les frames (dont l'iframe cool.html de Collabora), avant ses scripts.
 * Sans effet sur Euro-Office (clés ignorées).
 */
export async function installCollaboraWelcomeSkip(context, version) {
  await context.addInitScript((v) => {
    try {
      if (v) localStorage.setItem('WSDWelcomeVersion', v);
      localStorage.setItem('WSDWelcomeDisabled', 'true');
      localStorage.setItem('WSDWelcomeDisabledDate', new Date().toDateString().replace(/ /g, '-'));
      localStorage.setItem('WSDFeedbackEnabled', 'false');
      localStorage.setItem('WSDFeedbackLaterDate', String(Date.now()));
    } catch { /* localStorage indisponible */ }
  }, version || '');
}

/**
 * Euro-Office / ONLYOFFICE: empêche les bulles « nouveauté » (ex. « New Multipage view », bouton « Got it ») de s'afficher.
 * Vérifié dans Euro-Office/web-apps (apps/common/main/lib/component/SynchronizeTip.js, Common.UI.TooltipManager):
 * une bulle n'est jamais ajoutée si localStorage[<nom>] est déjà défini; « Got it » y écrit 1. Noms: documenteditor/main/app/controller/Toolbar.js.
 * Écrit dans toutes les frames (dont celle de l'éditeur), avant ses scripts. Sans effet sur Collabora (clés ignorées).
 */
export const EURO_OFFICE_TIPS = [
  'de-help-tip-multipage-view-statusbar', 'de-help-tip-multipage-view-toolbar', 'de-help-tip-header-footer-tab',
  'de-help-tip-signature', 'de-help-tip-fill-status', 'help-tip-comment-filter', 'help-tip-chart-elements',
];
export async function installEuroOfficeTipsSkip(context) {
  await context.addInitScript((names) => {
    try { for (const n of names) localStorage.setItem(n, '1'); } catch { /* localStorage indisponible */ }
  }, EURO_OFFICE_TIPS);
}

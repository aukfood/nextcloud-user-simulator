/**
 * Supprime les salons et les utilisateurs de test.
 * Par défaut, tous les salons "loadtest-*" et tous les comptes "userNN". Vérifier qu'aucun vrai compte userNN n'existe sur l'instance.
 *   node cleanup.js scenario.json                 supprime TOUS les salons "loadtest-*" et TOUS les "userNN"
 *   node cleanup.js scenario.json --rooms-only    seulement les salons (garde les utilisateurs)
 *   node cleanup.js scenario.json --users-only    seulement les utilisateurs (garde les salons)
 *   node cleanup.js scenario.json --current-only  seulement ce qui est dans logs/rooms.json et user01..totalUsers
 */
import fs from 'node:fs';
import { makeLogger, applyCredentials, applyTlsSetting } from './lib/common.js';
import { cleanup } from './lib/provision.js';

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || 'scenario.json', 'utf8'));
applyCredentials(cfg);
const log = makeLogger('cleanup');
applyTlsSetting(cfg, log);
cleanup(cfg, {
  deleteUsers: !process.argv.includes('--rooms-only'),
  deleteRooms: !process.argv.includes('--users-only'),
  all: !process.argv.includes('--current-only'),
}, log)
  .then(() => process.exit(0))
  .catch((e) => { log(`ERREUR: ${e.message}`); process.exit(1); });

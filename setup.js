/**
 * Prépare l'instance de test SANS lancer d'appel:
 *  - désactive l'assistant de première connexion (firstrunwizard), qui masque l'interface
 *    des comptes neufs (désactivable avec "setup": {"disableFirstRunWizard": false})
 *  - crée les utilisateurs et les salons Talk par l'API.
 * (Le leader pc1-leader.js fait la même préparation tout seul: setup.js sert à préparer sans lancer de test.)
 *   node setup.js scenario.json
 */
import fs from 'node:fs';
import { makeLogger, applyCredentials, applyTlsSetting } from './lib/common.js';
import { provision } from './lib/provision.js';

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || 'scenario.json', 'utf8'));
applyCredentials(cfg);
const log = makeLogger('setup');
applyTlsSetting(cfg, log);

// L'URL Nextcloud, les identifiants et le HPB viennent de scenario.json: rien n'est écrit en dur ici.
provision(cfg, log)
  .then(() => process.exit(0))
  .catch((e) => { log(`ERREUR: ${e.message}`); process.exit(1); });

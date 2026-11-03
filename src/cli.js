// `sudo messageassistant <command>` (the bash helper runs this as the service user for the database parts).
import { cfg, VERSION } from './config.js';
import { openDb, all, get, setting, setSetting, audit } from './db.js';
import { loadMasterKey } from './crypto.js';
import * as aikeys from './aikeys.js';
import * as users from './users.js';
import { setPassword, randomPassword } from './adminauth.js';

loadMasterKey(cfg.dataDir); openDb();
const [cmd, ...args] = process.argv.slice(2);
const find = (x) => /^\d{1,6}$/.test(String(x)) ? users.userById(Number(x)) : users.userByPhone(x);
const out = (s) => process.stdout.write(s + '\n');
switch (cmd) {
  case 'reset-password': {
    const pw = args[0] || randomPassword();
    setPassword(pw, args[1] || null);
    out(`Admin username: ${setting('admin_username') || 'admin'}`);
    out(`Admin password: ${pw}`);
    out('(All dashboard sessions were signed out. Change it any time in Settings.)');
    break;
  }
  case 'admin-phone': {
    if (!args.length) { out('Admin phone(s): ' + (users.adminPhones().join(', ') || '(none)')); break; }
    const list = args.join(' ').split(/[,;]+/).map(x => users.normalizePhone(x.trim())).filter(Boolean);
    if (!list.length) { out('That is not a phone number. Example: sudo messageassistant admin-phone +16465550100'); process.exit(1); }
    setSetting('admin_phones', list.join(',')); audit('admin', 'settings.admin_phones', list.join(',')); out('Admin phone(s): ' + list.join(', '));
    break;
  }
  case 'users': {
    const rows = users.listUsers(args[0] || null);
    if (!rows.length) out('Nobody yet.');
    for (const u of rows) out(`#${u.id}  ${u.status.padEnd(8)}  ${u.label}${u.phone && u.phone !== u.label ? ' (' + u.phone + ')' : ''}  last ${u.last_seen ? new Date(u.last_seen).toISOString().slice(0, 16).replace('T', ' ') : '-'}`);
    break;
  }
  case 'approve': case 'block': case 'remove': {
    const u = find(args[0]); if (!u) { out('Not found. See: sudo messageassistant users'); process.exit(1); }
    if (cmd === 'approve') {
      const was = u.status; users.approve(u.id, 'admin (cli)');
      if (was !== 'approved') { const { enqueueText } = await import('./outbox.js'); const { welcomeText } = await import('./router.js'); enqueueText({ userId: u.id, text: welcomeText(), kind: 'welcome' }); }
      out(`Approved #${u.id} (the welcome text goes out with the next send).`);
    } else if (cmd === 'block') { users.block(u.id, 'admin (cli)'); out(`Blocked #${u.id}.`); }
    else { users.remove(u.id, 'admin (cli)'); out(`Removed #${u.id} and all their data.`); }
    break;
  }
  case 'keys': {
    const ks = aikeys.listKeys();
    if (!ks.length) out('No AI keys yet. Add them in the dashboard (AI keys) or in /etc/messageassistant/env, then: sudo messageassistant restart');
    ks.forEach((k, i) => out(`${i + 1}. ${k.name}  [${k.status}${k.resting_until_text ? ' until ' + k.resting_until_text : ''}]  ${k.kind_label}  ${k.effective_model || ''}  key ${k.masked || '-'}`));
    break;
  }
  case 'info': {
    out(`Message Assistant ${VERSION}`);
    out(`Google Messages: ${setting('gm_state')}`);
    out(`People: ${get("SELECT COUNT(*) AS n FROM users WHERE status='pending'").n} waiting, ${get("SELECT COUNT(*) AS n FROM users WHERE status='approved'").n} approved, ${get("SELECT COUNT(*) AS n FROM users WHERE status='blocked'").n} blocked`);
    out(`AI keys: ${aikeys.listKeys().map(k => k.name + ' ' + k.status).join(', ') || 'none'}`);
    out(`Admin phone(s): ${users.adminPhones().join(', ') || '(none — set with: sudo messageassistant admin-phone +1…)'}`);
    break;
  }
  default:
    out('Usage: messageassistant-cli {reset-password [new] | admin-phone [+1…] | users [pending|approved|blocked] | approve|block|remove <#|phone> | keys | info}');
    process.exit(cmd ? 1 : 0);
}

// `sudo messageassistant <command>` (the bash helper runs this as the service user for the database parts).
import { cfg, VERSION } from './config.js';
import { openDb, all, get, setting, setSetting, audit } from './db.js';
import { loadMasterKey } from './crypto.js';
import * as aikeys from './aikeys.js';
import * as users from './users.js';
import { setPassword, randomPassword, hasPassword } from './adminauth.js';
import * as SITES from './sites.js';

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
  // ---- 1.0.2: sites ----
  case 'sites-approval': {
    const a = String(args[0] || 'show').toLowerCase();
    if (a === 'on' || a === 'off') SITES.setConfig({ approval: a === 'on' }, 'admin (cli)');
    else if (a !== 'show') { out('Usage: sudo messageassistant sites-approval on|off|show'); process.exit(1); }
    const c = SITES.config();
    out(`Site publishing: ${c.approval ? 'ON — the admin approves every publish (after the person\'s YES)' : 'OFF — the person\'s own YES publishes'}`);
    out(`Site building: ${{ all: 'everyone', chosen: 'only chosen people (' + c.chosen.length + ')', off: 'off' }[c.mode]} · ${c.quota_mb} MB and ${c.max_sites} sites per person`);
    const w = SITES.waitingForAdmin(); if (w.length) out(`Waiting for you: ${w.map(r => 'S' + r.id + ' ' + r.public_name).join(', ')}`);
    break;
  }
  case 'sites-access': {
    const a = String(args[0] || '').toLowerCase();
    if (!['all', 'chosen', 'off'].includes(a)) { out('Usage: sudo messageassistant sites-access all|chosen|off   (then: sites-allow <#> / sites-deny <#>)'); process.exit(1); }
    SITES.setConfig({ mode: a }, 'admin (cli)'); out('Site building: ' + { all: 'everyone', chosen: 'only chosen people', off: 'off' }[a]);
    break;
  }
  case 'sites-allow': case 'sites-deny': {
    const u = find(args[0]); if (!u) { out('Not found. See: sudo messageassistant users'); process.exit(1); }
    SITES.setAllowed(u.id, cmd === 'sites-allow', 'admin (cli)'); out(`#${u.id} ${cmd === 'sites-allow' ? 'can' : 'cannot'} build sites (when access is "chosen").`);
    break;
  }
  case 'sites-limits': {
    if (args.length) SITES.setConfig({ quota_mb: args[0], ...(args[1] !== undefined ? { max_sites: args[1] } : {}) }, 'admin (cli)');
    const c = SITES.config(); out(`Per person: ${c.quota_mb} MB, ${c.max_sites} sites.  Change: sudo messageassistant sites-limits <MB> [sites]`);
    break;
  }
  case 'sites': {
    const rows = SITES.listSites();
    if (!rows.length) out('No published sites.');
    for (const s2 of rows) out(`#${s2.id}  ${s2.user}  ${s2.url}  ${s2.size}  ${new Date(s2.updated).toISOString().slice(0, 10)}`);
    break;
  }
  case 'sites-unpublish': {
    const n = String(args[0] || '').trim(); if (!n) { out('Usage: sudo messageassistant sites-unpublish <#|name>  (see: sudo messageassistant sites)'); process.exit(1); }
    const s2 = /^\d+$/.test(n) ? SITES.unpublish({ id: Number(n) }, 'admin (cli)') : SITES.unpublish({ name: n }, 'admin (cli)');
    const { enqueueText } = await import('./outbox.js');
    enqueueText({ userId: s2.user_id, text: `The admin took your site "${s2.name}" offline.`, kind: 'notice' });
    out(`Unpublished ${s2.public_name}.`);
    break;
  }
  case 'portal': {
    const a = String(args[0] || 'show').toLowerCase();
    const portal = await import('./portal.js');
    if (a === 'on' || a === 'off') portal.setEnabled(a === 'on', 'admin (cli)');
    else if (a !== 'show') { out('Usage: sudo messageassistant portal on|off|show'); process.exit(1); }
    out(`Web chat for people: ${portal.enabled() ? 'ON' : 'OFF'} (${cfg.publicUrl}/me)`);
    break;
  }
  case 'check-update': {
    const upd = await import('./updates.js');
    const i = await upd.info({ fresh: true });
    out(`Installed: ${i.current}`);
    out(i.latest ? `Available: ${i.latest}${i.update_available ? '  → install with: sudo messageassistant update' : '  (up to date)'}` : `Available: could not check (${i.check_error})`);
    if (i.update_available && i.notes) out('What\'s new:\n' + i.notes);
    break;
  }
  case 'has-password': { out(hasPassword() ? 'yes' : 'no'); break; }
  case 'info': {
    out(`Message Assistant ${VERSION}`);
    out(`Google Messages: ${setting('gm_state')}`);
    out(`People: ${get("SELECT COUNT(*) AS n FROM users WHERE status='pending'").n} waiting, ${get("SELECT COUNT(*) AS n FROM users WHERE status='approved'").n} approved, ${get("SELECT COUNT(*) AS n FROM users WHERE status='blocked'").n} blocked`);
    out(`AI keys: ${aikeys.listKeys().map(k => k.name + ' ' + k.status).join(', ') || 'none'}`);
    out(`Admin phone(s): ${users.adminPhones().join(', ') || '(none — set with: sudo messageassistant admin-phone +1…)'}`);
    break;
  }
  default:
    out('Usage: messageassistant-cli {reset-password [new] | admin-phone [+1…] | users [pending|approved|blocked] | approve|block|remove <#|phone> | keys | info | sites | sites-approval on|off|show | sites-access all|chosen|off | sites-allow|sites-deny <#> | sites-limits [MB] [sites] | sites-unpublish <#|name> | portal on|off|show | check-update}');
    process.exit(cmd ? 1 : 0);
}

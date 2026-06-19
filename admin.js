#!/usr/bin/env node
// ===========================================================================
// Backchannel admin CLI — the owner's terminal control plane.
//
// Talks to the server's /admin/* endpoints using the ADMIN_TOKEN secret. The
// secret lives ONLY here (your machine) and in the Railway env — it is NOT any
// user/device token, so it can never be obtained by a member.
//
// Secret source (first match wins):  env BC_ADMIN_TOKEN  ->  ~/.config/backchannel/admin-token
// Server URL (first match wins):     env BC_ADMIN_URL    ->  ~/.config/backchannel/admin-url  ->  production
//
// Usage:  node admin.js <command> [args]      (`node admin.js help` for the list)
// Destructive commands need  --yes  (or an interactive confirmation).
// ===========================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CONFIG_DIR = process.env.BACKCHANNEL_CONFIG_DIR || path.join(os.homedir(), '.config', 'backchannel');
const DEFAULT_URL = 'https://backchannel-production-3df1.up.railway.app';

function fromConfig(file, envVar) {
  if (process.env[envVar]) return String(process.env[envVar]).trim();
  try { return fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8').trim(); } catch { return ''; }
}
const TOKEN = fromConfig('admin-token', 'BC_ADMIN_TOKEN');
const BASE = (fromConfig('admin-url', 'BC_ADMIN_URL') || DEFAULT_URL).replace(/\/+$/, '');

const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', cyn: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
function die(msg) { console.error(C.red + '✗ ' + msg + C.off); process.exit(1); }
function ok(msg) { console.log(C.grn + '✓ ' + msg + C.off); }

if (!TOKEN) {
  die('no admin token found.\n  Put it in ' + path.join(CONFIG_DIR, 'admin-token') + ' (chmod 600), or set BC_ADMIN_TOKEN.');
}
if (!/^https:\/\//.test(BASE) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) {
  die('refusing to send the admin token over plaintext: ' + BASE + '\n  Use an https:// URL (http is allowed only for localhost dev).');
}

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: { 'x-admin-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { die('network error reaching ' + BASE + ' — ' + e.message); }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON (e.g. the uniform 404 page) */ }
  if (res.status === 404 && json === null) {
    die('404 from /admin — the surface is disabled on the server (no ADMIN_TOKEN set), the token is wrong, or the\n  command path is unknown. By design these are indistinguishable. Check the token + that the deploy has ADMIN_TOKEN.');
  }
  if (res.status === 429) die('rate limited — wait a minute and retry.');
  return { status: res.status, json };
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}
function fmtDate(ms) { try { return new Date(ms).toISOString().slice(0, 10); } catch { return '?'; } }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

const [cmd, ...args] = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const positional = args.filter((a) => !a.startsWith('-'));

async function confirm(prompt) {
  if (yes) return true;
  const a = await ask(C.ylw + prompt + ' [y/N] ' + C.off);
  return /^y(es)?$/i.test(a);
}

async function main() {
  switch (cmd) {
    case 'list': {
      const q = positional[0] ? ('?q=' + encodeURIComponent(positional[0])) : '';
      const { json } = await api('GET', '/admin/users' + q);
      const users = (json && json.users) || [];
      console.log(C.bold + pad('USERNAME', 18) + pad('STATE', 10) + pad('DEVICES', 9) + pad('MSGS', 7) + pad('BANNED', 8) + 'JOINED' + C.off);
      for (const u of users) {
        const state = u.active ? C.grn + 'active' + C.off : (u.present ? C.cyn + 'building' + C.off : C.dim + 'offline' + C.off);
        const statePad = ' '.repeat(Math.max(0, 10 - (u.active ? 6 : u.present ? 8 : 7)));
        console.log(pad('@' + u.username, 18) + state + statePad + pad(u.devices, 9) + pad(u.messages, 7) + pad(u.banned ? 'BANNED' : '-', 8) + fmtDate(u.created_at));
      }
      console.log(C.dim + users.length + ' user(s)' + C.off);
      break;
    }
    case 'stats': {
      const { json } = await api('GET', '/admin/stats');
      if (!json) die('no data');
      console.log('users:               ' + json.users);
      console.log('messages:            ' + json.messages);
      console.log('outstanding invites: ' + json.outstandingInvites);
      console.log('present now:          ' + json.presentNow);
      console.log('open sockets:         ' + json.sockets);
      console.log('rooms:               ' + (json.rooms || []).map((r) => r.type + '=' + r.n).join(', '));
      break;
    }
    case 'find': {
      if (!positional[0]) die('usage: find <username>');
      const { status, json } = await api('GET', '/admin/find?u=' + encodeURIComponent(positional[0]));
      if (status === 404) die('no such user: ' + positional[0]);
      console.log(C.bold + '@' + json.username + C.off + (json.banned ? C.red + '  [BANNED]' + C.off : '') + (json.protected ? C.cyn + '  [protected]' + C.off : ''));
      console.log('  joined:    ' + fmtDate(json.created_at));
      console.log('  state:     ' + (json.active ? 'active' : json.present ? 'building' : 'offline') + '  (sessions: ' + json.sessions + ')');
      console.log('  messages:  ' + json.messages + '   reactions: ' + json.reactions + '   private rooms: ' + json.privateRooms);
      console.log('  devices:   ' + (json.devices || []).map((d) => (d.label || '?')).join(', '));
      const inv = json.invites || [];
      const used = inv.filter((i) => i.used).length;
      console.log('  invites:   ' + inv.length + ' (' + used + ' used) ' + C.dim + inv.map((i) => i.code + (i.used ? '*' : '')).join(' ') + C.off);
      break;
    }
    case 'kick': {
      if (!positional[0]) die('usage: kick <username>');
      const { status, json } = await api('POST', '/admin/kick', { username: positional[0] });
      if (status === 404) die('no such user: ' + positional[0]);
      ok('kicked @' + json.kicked + ' (disconnected; they can reconnect — use ban to lock out)');
      break;
    }
    case 'ban': {
      if (!positional[0]) die('usage: ban <username> [--yes]');
      if (!(await confirm('Ban @' + positional[0] + '? Revokes all their devices + blocks recover/pair/claim.'))) die('aborted');
      const { status, json } = await api('POST', '/admin/ban', { username: positional[0] });
      if (status === 404) die('no such user: ' + positional[0]);
      ok('banned @' + json.banned);
      break;
    }
    case 'unban': {
      if (!positional[0]) die('usage: unban <username>');
      const { status, json } = await api('POST', '/admin/unban', { username: positional[0] });
      if (status === 404) die('no such user: ' + positional[0]);
      ok('unbanned @' + json.unbanned + ' (they must re-pair or recover to get back in)');
      break;
    }
    case 'delete': {
      if (!positional[0]) die('usage: delete <username> [--yes]');
      if (!(await confirm('PERMANENTLY delete @' + positional[0] + ' and all their data? Irreversible.'))) die('aborted');
      const { status, json } = await api('POST', '/admin/delete', { username: positional[0] });
      if (status === 403) die('@' + positional[0] + ' is protected and cannot be deleted (edit PROTECTED_USERS in server.js to change).');
      if (status === 404) die('no such user: ' + positional[0]);
      ok('deleted @' + json.deleted);
      break;
    }
    case 'grant-invites': {
      if (!positional[0] || !positional[1]) die('usage: grant-invites <username> <n>');
      const { status, json } = await api('POST', '/admin/grant-invites', { username: positional[0], n: Number(positional[1]) });
      if (status === 404) die('no such user: ' + positional[0]);
      if (status === 400) die('n must be an integer 1..20');
      ok('granted ' + json.codes.length + ' code(s) to @' + json.username + ':');
      for (const c of json.codes) console.log('   ' + C.cyn + c + C.off);
      break;
    }
    case 'genesis': {
      const n = positional[0] ? Number(positional[0]) : 1;
      const { status, json } = await api('POST', '/admin/genesis', { n });
      if (status === 400) die('n must be an integer 1..20');
      ok('minted ' + json.codes.length + ' open code(s) (hand out to people not yet in):');
      for (const c of json.codes) console.log('   ' + C.cyn + c + C.off);
      break;
    }
    case 'revoke-invite': {
      if (!positional[0]) die('usage: revoke-invite <code>');
      if (!(await confirm('Revoke unused code ' + positional[0] + '?'))) die('aborted');
      const { status, json } = await api('POST', '/admin/revoke-invite', { code: positional[0] });
      if (status === 404) die('no such code');
      if (status === 409) die('that code is already used — refusing to delete (preserves referral history)');
      ok('revoked ' + json.code);
      break;
    }
    case 'msg-rm': {
      if (!positional[0]) die('usage: msg-rm <message-id> [--yes]');
      if (!(await confirm('Delete message #' + positional[0] + '? Irreversible.'))) die('aborted');
      const { status } = await api('POST', '/admin/delete-message', { id: Number(positional[0]) });
      if (status === 404) die('no such message (or already gone)');
      if (status === 400) die('message id must be a positive integer');
      ok('deleted message #' + positional[0]);
      break;
    }
    case 'purge-except': {
      // Always show the dry-run first.
      const dry = await api('POST', '/admin/purge-except', { confirm: false });
      const d = dry.json || {};
      console.log(C.bold + 'KEEP: ' + C.off + (d.keep || []).map((u) => '@' + u).join(', '));
      if ((d.missingFromKeep || []).length) console.log(C.ylw + 'note: keep-list names not found in DB: ' + d.missingFromKeep.join(', ') + C.off);
      const targets = d.wouldDelete || [];
      if (!targets.length) { ok('nothing to purge — only the keep-list users exist.'); break; }
      console.log(C.red + C.bold + 'WOULD DELETE ' + targets.length + ' user(s):' + C.off);
      for (const t of targets) console.log('   @' + pad(t.username, 16) + C.dim + t.messages + ' msgs, ' + t.devices + ' devices, ' + t.invites + ' invites' + C.off);
      if (!yes) { console.log(C.dim + '\nDry run only. Re-run with --yes to execute.' + C.off); break; }
      const a = await ask(C.red + '\nType DELETE to permanently erase the ' + targets.length + ' user(s) above: ' + C.off);
      if (a !== 'DELETE') die('aborted (did not type DELETE)');
      const run = await api('POST', '/admin/purge-except', { confirm: true });
      const r = run.json || {};
      ok('purged ' + (r.deleted || []).length + ' user(s): ' + (r.deleted || []).map((u) => '@' + u).join(', '));
      if ((r.failed || []).length) console.log(C.red + 'failed: ' + r.failed.join(', ') + C.off);
      break;
    }
    case 'help':
    case undefined:
      console.log(`Backchannel admin — ${BASE}

  list [substr]            roster of all users (state, devices, msgs, banned)
  find <user>              full dossier on one user
  stats                    system snapshot (users, messages, present now, ...)

  kick <user>              disconnect their live sessions (transient)
  ban <user> [--yes]       revoke all devices + lock out (recover/pair/claim blocked)
  unban <user>             clear the ban (they must re-pair or recover)
  delete <user> [--yes]    permanently erase a user + all their data
  msg-rm <id> [--yes]      delete one message by id

  grant-invites <user> <n> give a user N more referral codes (1..20)
  genesis [n]              mint N open codes for people not yet in (default 1)
  revoke-invite <code>     delete a single UNUSED code

  purge-except [--yes]     delete EVERY user not in the hardcoded keep-list
                           (dry-run without --yes; then asks you to type DELETE)

Secret: ${path.join(CONFIG_DIR, 'admin-token')}  (or BC_ADMIN_TOKEN)
Server: BC_ADMIN_URL to override the default production URL.`);
      break;
    default:
      die('unknown command: ' + cmd + '   (run `node admin.js help`)');
  }
}

main();

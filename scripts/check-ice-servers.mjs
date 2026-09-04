#!/usr/bin/env node
// check-ice-servers.mjs
// Prueft, ob alle in PEER_CONFIG (im Spiel-HTML) hinterlegten STUN/TURN-Server
// aktuell wirklich erreichbar UND funktionsfaehig sind - nicht nur "Datei
// enthaelt die Zeile", sondern ein echter Netzwerk-Handshake pro Server.
//
// Hintergrund: Am 14./15.08.2026 ist der TURN-Server openrelay.metered.ca
// (Community-Gratisdienst) ersatzlos abgeschaltet worden (DNS aufgeloest sich
// nicht mehr) - unbemerkt, weil es dafuer keinen automatischen Test gab. Neue
// Nutzer (u.a. via Instagram-Werbekampagne) landeten dadurch reihenweise in
// "Konnte nicht verbinden", weil ihnen ohne TURN-Relay keine Verbindung ueber
// restriktive NATs (v.a. Mobilfunk) moeglich war.
//
// Nutzung:
//   node scripts/check-ice-servers.mjs                  -> prueft https://ms-game.de/ (prod, live)
//   node scripts/check-ice-servers.mjs <pfad-oder-url>  -> prueft eine bestimmte Datei/URL
//
// Exit-Code 0 = alles ok, 1 = mindestens ein Server tot/fehlerhaft (fuer CI gedacht).

import dgram from 'node:dgram';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import vm from 'node:vm';
import https from 'node:https';

const TARGET = process.argv[2] || 'https://ms-game.de/';
const MAGIC_COOKIE = 0x2112a442;
const STUN_TIMEOUT_MS = 6000;

function fetchText(target) {
  if (/^https?:\/\//i.test(target)) {
    return new Promise((resolve, reject) => {
      https.get(target, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchText(res.headers.location));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
  return import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8'));
}

function extractPeerConfig(html) {
  const startMarker = 'const PEER_CONFIG';
  const idxStart = html.indexOf(startMarker);
  if (idxStart === -1) throw new Error('PEER_CONFIG nicht im HTML gefunden');
  const eqIdx = html.indexOf('=', idxStart);
  if (eqIdx === -1) throw new Error('Zuweisung fuer PEER_CONFIG nicht gefunden');
  const idxObjStart = html.indexOf('{', eqIdx);
  if (idxObjStart === -1) throw new Error('Beginn des PEER_CONFIG-Objekts nicht gefunden');

  // Statt auf einen (fragilen) nachfolgenden Code-Marker zu vertrauen, wird das
  // Ende des Objektliterals durch Klammer-Zaehlung ermittelt. So bleibt die
  // Extraktion robust, egal welcher Code als naechstes im HTML folgt. String-
  // und Template-Literale werden dabei uebersprungen, damit Klammern darin
  // die Zaehlung nicht verfaelschen.
  let depth = 0;
  let idxObjEnd = -1;
  let quote = null;
  for (let i = idxObjStart; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { idxObjEnd = i; break; }
    }
  }
  if (idxObjEnd === -1) throw new Error('Ende von PEER_CONFIG nicht gefunden (unausgeglichene Klammern)');

  const objText = html.slice(idxObjStart, idxObjEnd + 1);
  return vm.runInNewContext('(' + objText + ')');
}

function normalizeServers(iceServers) {
  const out = [];
  for (const entry of iceServers) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const url of urls) {
      out.push({ url, username: entry.username, credential: entry.credential });
    }
  }
  return out;
}

function parseUrl(url) {
  const m = /^(stun|turn|turns):([^:?]+)(?::(\d+))?(?:\?transport=(\w+))?$/i.exec(url.trim());
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: m[2], port: parseInt(m[3] || (m[1] === 'turns' ? '5349' : '3478'), 10), transport: (m[4] || 'udp').toLowerCase() };
}

function randomTxId() {
  return crypto.randomBytes(12);
}

function buildHeader(type, bodyLen, txId) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(bodyLen, 2);
  b.writeUInt32BE(MAGIC_COOKIE, 4);
  txId.copy(b, 8);
  return b;
}

function attr(type, value) {
  const padLen = (4 - (value.length % 4)) % 4;
  const b = Buffer.alloc(4 + value.length + padLen);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

function parseAttrs(buf) {
  const attrs = [];
  let off = 20;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    const val = buf.slice(off + 4, off + 4 + len);
    attrs.push({ type, val });
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return attrs;
}

const ATTR_ERROR_CODE = 0x0009;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;

// Einfacher STUN-Binding-Test (fuer stun:-Eintraege): Server muss ueberhaupt
// mit einer gueltigen STUN-Antwort reagieren.
function checkStun(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const txId = randomTxId();
    const header = buildHeader(BINDING_REQUEST, 0, txId);
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) { }
      resolve({ ok, detail });
    };
    sock.on('message', (msg) => {
      const type = msg.readUInt16BE(0);
      finish(type === BINDING_SUCCESS, type === BINDING_SUCCESS ? 'Binding OK' : `Unerwarteter Typ 0x${type.toString(16)}`);
    });
    sock.on('error', (e) => finish(false, 'Socket-Fehler: ' + e.message));
    setTimeout(() => finish(false, 'Timeout (keine Antwort)'), STUN_TIMEOUT_MS);
    sock.send(header, port, host, (err) => { if (err) finish(false, 'Send-Fehler: ' + err.message); });
  });
}

// Voller TURN-Allocate-Handshake (RFC 5766) inkl. Long-Term-Credential-Auth -
// prueft nicht nur Erreichbarkeit, sondern dass die hinterlegten Zugangsdaten
// wirklich noch gueltig sind.
function checkTurn(host, port, username, credential) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let step = 0;
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) { }
      resolve({ ok, detail });
    };
    setTimeout(() => finish(false, 'Timeout (keine Antwort - Port evtl. blockiert oder Server down)'), STUN_TIMEOUT_MS);

    function sendUnauth() {
      const txId = randomTxId();
      const transportAttr = attr(ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]));
      const header = buildHeader(ALLOCATE_REQUEST, transportAttr.length, txId);
      sock.send(Buffer.concat([header, transportAttr]), port, host);
    }

    function sendAuth(realm, nonce) {
      const txId = randomTxId();
      const transportAttr = attr(ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]));
      const usernameAttr = attr(ATTR_USERNAME, Buffer.from(username, 'utf8'));
      const realmAttr = attr(ATTR_REALM, Buffer.from(realm, 'utf8'));
      const nonceAttr = attr(ATTR_NONCE, Buffer.from(nonce, 'utf8'));
      const bodyNoMI = Buffer.concat([transportAttr, usernameAttr, realmAttr, nonceAttr]);
      const key = crypto.createHash('md5').update(`${username}:${realm}:${credential}`).digest();
      const lenWithMI = bodyNoMI.length + 24;
      const headerForMI = buildHeader(ALLOCATE_REQUEST, lenWithMI, txId);
      const hmac = crypto.createHmac('sha1', key).update(Buffer.concat([headerForMI, bodyNoMI])).digest();
      const miAttr = attr(ATTR_MESSAGE_INTEGRITY, hmac);
      const fullBody = Buffer.concat([bodyNoMI, miAttr]);
      const header = buildHeader(ALLOCATE_REQUEST, fullBody.length, txId);
      sock.send(Buffer.concat([header, fullBody]), port, host);
    }

    sock.on('message', (msg) => {
      const type = msg.readUInt16BE(0);
      const attrs = parseAttrs(msg);
      if (step === 0) {
        if (type === ALLOCATE_ERROR) {
          const errAttr = attrs.find((a) => a.type === ATTR_ERROR_CODE);
          const realmAttr = attrs.find((a) => a.type === ATTR_REALM);
          const nonceAttr = attrs.find((a) => a.type === ATTR_NONCE);
          const code = errAttr ? errAttr.val[2] * 100 + errAttr.val[3] : 0;
          if (code === 401 && realmAttr && nonceAttr && username && credential) {
            step = 1;
            sendAuth(realmAttr.val.toString('utf8'), nonceAttr.val.toString('utf8'));
          } else if (code === 401 && (!username || !credential)) {
            finish(false, 'Server verlangt Auth, aber keine Zugangsdaten hinterlegt');
          } else {
            finish(false, `Unerwarteter Fehlercode ${code} auf ersten Allocate-Versuch`);
          }
        } else if (type === ALLOCATE_SUCCESS) {
          finish(true, 'Allocate ohne Auth erfolgreich (offener Server)');
        } else {
          finish(false, `Unerwarteter Response-Typ 0x${type.toString(16)}`);
        }
      } else if (step === 1) {
        if (type === ALLOCATE_SUCCESS) {
          finish(true, 'Allocate mit Zugangsdaten erfolgreich');
        } else if (type === ALLOCATE_ERROR) {
          const errAttr = attrs.find((a) => a.type === ATTR_ERROR_CODE);
          const code = errAttr ? errAttr.val[2] * 100 + errAttr.val[3] : 0;
          finish(false, `Zugangsdaten abgelehnt (Code ${code}) - TURN-Credentials vermutlich ungueltig/abgelaufen`);
        } else {
          finish(false, `Unerwarteter Response-Typ 0x${type.toString(16)} in Auth-Phase`);
        }
      }
    });
    sock.on('error', (e) => finish(false, 'Socket-Fehler: ' + e.message));
    sendUnauth();
  });
}

function checkTcpReachable(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: STUN_TIMEOUT_MS });
    sock.on('connect', () => { sock.destroy(); resolve({ ok: true, detail: 'TCP-Verbindung erfolgreich (kein Protokoll-Test)' }); });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, detail: 'TCP-Timeout' }); });
    sock.on('error', (e) => resolve({ ok: false, detail: 'TCP-Fehler: ' + e.message }));
  });
}

async function checkServer(server) {
  const parsed = parseUrl(server.url);
  if (!parsed) return { url: server.url, ok: false, detail: 'Konnte URL nicht parsen' };

  // Schritt 1: DNS - das ist genau das, was bei openrelay.metered.ca kaputt war
  try {
    await dns.lookup(parsed.host);
  } catch (e) {
    return { url: server.url, ok: false, detail: `DNS aufloesen fehlgeschlagen (${e.code}) - Server existiert vermutlich nicht mehr` };
  }

  if (parsed.scheme === 'stun') {
    const r = await checkStun(parsed.host, parsed.port);
    return { url: server.url, ok: r.ok, detail: r.detail };
  }
  if (parsed.scheme === 'turn' && parsed.transport === 'udp') {
    const r = await checkTurn(parsed.host, parsed.port, server.username, server.credential);
    return { url: server.url, ok: r.ok, detail: r.detail };
  }
  // turns: oder turn+tcp: kein UDP-Handshake einfach moeglich -> nur TCP-Erreichbarkeit
  const r = await checkTcpReachable(parsed.host, parsed.port);
  return { url: server.url, ok: r.ok, detail: r.detail + ' (nur TCP-Reachability, kein Auth-Test)' };
}

async function main() {
  console.log(`Pruefe ICE-Server aus: ${TARGET}\n`);
  let html;
  try {
    html = await fetchText(TARGET);
  } catch (e) {
    console.error('Konnte Ziel nicht laden:', e.message);
    process.exit(1);
  }

  let config;
  try {
    config = extractPeerConfig(html);
  } catch (e) {
    console.error('Konnte PEER_CONFIG nicht extrahieren:', e.message);
    process.exit(1);
  }

  const servers = normalizeServers(config.config.iceServers);
  if (servers.length === 0) {
    console.error('Keine iceServers gefunden!');
    process.exit(1);
  }

  let anyFail = false;
  let anyTurnOk = false;
  let hasTurn = false;
  for (const server of servers) {
    const result = await checkServer(server);
    const scheme = (parseUrl(server.url) || {}).scheme;
    if (scheme === 'turn' || scheme === 'turns') hasTurn = true;
    if (result.ok && (scheme === 'turn' || scheme === 'turns')) anyTurnOk = true;
    console.log(`${result.ok ? '✅' : '❌'} ${result.url}${result.ok ? '' : '  <-- ' + result.detail}`);
    if (!result.ok) anyFail = true;
  }

  console.log('');
  if (hasTurn && !anyTurnOk) {
    console.error('⚠️  KRITISCH: Kein einziger TURN-Server funktioniert! Nutzer hinter restriktivem NAT/Mobilfunk koennen nicht verbinden.');
  }
  if (!hasTurn) {
    console.error('⚠️  WARNUNG: Keine TURN-Server konfiguriert (nur STUN). Verbindungen ueber Mobilfunk/restriktive NATs koennen fehlschlagen.');
  }

  if (anyFail) {
    console.error('\nErgebnis: mindestens ein Server fehlerhaft.');
    process.exit(1);
  }
  console.log('Ergebnis: alle konfigurierten Server erreichbar.');
}

main();

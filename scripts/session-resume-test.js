// Regressionstest: Session-Persistenz gegen ungewollten Reload.
//
// Hintergrund-Bug: "Link teilen" (Web Share API) kann auf Mobilgeraeten dazu
// fuehren, dass der Browser den Tab im Hintergrund killt (z.B. beim Wechsel
// zu WhatsApp). Kommt der Nutzer zurueck, laedt die Seite komplett neu -
// ohne Session-Persistenz wuerde createHost() dabei einen NEUEN Zufalls-Code
// erzeugen, wodurch der gerade geteilte Code/Link sofort ungueltig wird.
//
// Dieser Test prueft die localStorage-basierte Resume-Logik direkt an den
// Netzwerkfunktionen (createHost/joinRoom/handlePlayerMessage/leaveGame),
// mit einem Fake-Peer, der Events manuell auslösen laesst.
// (localStorage statt localStorage: uebersteht auch einen echten Prozess-
// Kill/neue Tab-Instanz beim mobilen App-Wechsel, siehe Kommentar bei saveSession.)
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/muenster-kenner-dev.html', 'utf8');
const parts = html.split(/<script>|<\/script>/);
let code = '';
for (const p of parts) { if (p.length > code.length && p.includes('gameState')) code = p; }

function makeStorage() {
  return {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
}
global.localStorage = makeStorage();

const stubEl = new Proxy({}, {
  get: (t, k) => {
    if (k === 'style') return new Proxy({}, { get: () => '', set: () => true });
    if (k === 'classList') return { add() { }, remove() { } };
    if (k === 'value') return '0';
    if (typeof k === 'string' && ['innerHTML', 'value'].includes(k)) return '';
    return (...a) => stubEl;
  },
  set: () => true,
});
global.document = { getElementById: () => stubEl, querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl, body: { appendChild() { } } };
global.window = { location: { reload() { } } };
global.location = window.location;
global.alert = () => { }; global.confirm = () => true;
global.fetch = function () { return { catch: function () { return this; } }; };
// setTimeout feuert hier SOFORT synchron - Retry-Ketten laufen deterministisch
// und ohne echte Wartezeit durch.
global.setTimeout = (fn, ms) => { fn(); return 1; };
global.clearTimeout = () => { };

let __peerInstances = [];
global.Peer = function (id) {
  const handlers = {};
  const inst = {
    id,
    destroyed: false,
    on(ev, cb) { handlers[ev] = cb; },
    _trigger(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    connect(peerId) {
      const connHandlers = {};
      const conn = {
        peer: peerId,
        open: false,
        sent: [],
        on(ev, cb) { connHandlers[ev] = cb; },
        _trigger(ev, ...args) { if (connHandlers[ev]) connHandlers[ev](...args); },
        send(data) { conn.sent.push(data); },
      };
      inst.lastConn = conn;
      return conn;
    },
    destroy() { inst.destroyed = true; },
  };
  __peerInstances.push(inst);
  return inst;
};
function lastPeer() { return __peerInstances[__peerInstances.length - 1]; }

const realLog = console.log.bind(console);
console.log = () => { };
console.error = () => { };

const exposed = `
;globalThis.__G = { get gameState() { return gameState; },
  createHost, joinRoom, leaveGame, handlePlayerMessage, saveSession, clearSession,
  getSavedSession, resumeSavedSession, discardSavedSession,
  get role() { return role; }, set role(v) { role = v; },
  get myId() { return myId; }, set myId(v) { myId = v; },
  get myName() { return myName; }, set myName(v) { myName = v; },
  get roomCode() { return roomCode; }, set roomCode(v) { roomCode = v; },
  get hostConn() { return hostConn; }, set hostConn(v) { hostConn = v; },
  get connections() { return connections; }, set connections(v) { connections = v; },
};`;
new Function(code + exposed)();
const G = globalThis.__G;
console.log = realLog;
console.error = () => { };

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; realLog('OK  ' + name); } else { fail++; realLog('FAIL ' + name); } }

// ===== TEST 1: Host-Resume mit erzwungenem Code behaelt den Code =====
localStorage._d = {};
__peerInstances = [];
G.createHost('HostTest', 0, 'ABCD');
check('createHost(forcedCode) benutzt Code als Peer-ID', lastPeer().id === 'msk-dev-abcd');
lastPeer()._trigger('open', 'msk-dev-abcd');
check('roomCode bleibt ABCD nach Resume', G.roomCode === 'ABCD');
let saved = JSON.parse(localStorage.getItem('mk-session'));
check('Session nach Host-Open gespeichert (role host, code ABCD)', !!saved && saved.role === 'host' && saved.code === 'ABCD' && saved.name === 'HostTest');

// ===== TEST 1b: Host-App-Wechsel/PeerJS-Netzwerkfehler nach bereits
// erstelltem Raum darf NIEMALS einen neuen Raumcode erzeugen. Das war der
// Realgeraete-Bug: Beim Zurueckkommen meldet PeerJS nach ~1-2s einen transienten
// Netzwerkfehler; der Retry lief ohne forcedCode weiter und generierte dadurch
// einen neuen Code. =====
localStorage._d = {};
__peerInstances = [];
G.createHost('HostSwitch');
const switchCode = G.roomCode;
check('Normal erstellter Host hat initialen Code', /^[A-Z0-9]{4}$/.test(switchCode));
lastPeer()._trigger('open', 'msk-dev-' + switchCode.toLowerCase());
lastPeer()._trigger('error', { type: 'network' });
check('Host-Retry nach Netzwerkfehler behaelt denselben Code (1. Retry)', G.roomCode === switchCode && lastPeer().id === 'msk-dev-' + switchCode.toLowerCase());
lastPeer()._trigger('error', { type: 'network' });
check('Host-Retry nach Netzwerkfehler behaelt denselben Code (2. Retry)', G.roomCode === switchCode && lastPeer().id === 'msk-dev-' + switchCode.toLowerCase());

// ===== TEST 2: unavailable-id auf Resume-Code retried viele Male denselben Code,
// dann erst Fallback (Kernfix dieser Runde: Budget von 2 auf 20 Retries erhoeht,
// weil der echte PeerJS-Signaling-Server eine Peer-ID nach einem unsauberen
// Verbindungsabbruch oft ERST NACH SEINEM EIGENEN HEARTBEAT-TIMEOUT freigibt -
// das kann 30-60+ Sekunden dauern, nicht nur die alten ~2,7 Sekunden Gesamtfenster) =====
localStorage._d = {};
__peerInstances = [];
G.createHost('HostTest2', 0, 'WXYZ');
check('Initialer Resume-Versuch mit WXYZ', lastPeer().id === 'msk-dev-wxyz');
for (let i = 0; i < 20; i++) {
  lastPeer()._trigger('error', { type: 'unavailable-id' });
}
check('Nach 20 Retries (21 Versuche) noch immer WXYZ - nicht vorzeitig aufgegeben', __peerInstances.length === 21 && lastPeer().id === 'msk-dev-wxyz');
lastPeer()._trigger('error', { type: 'unavailable-id' });
check('Erst nach 20 gescheiterten Retries: Fallback auf neuen Code', __peerInstances.length === 22 && lastPeer().id !== 'msk-dev-wxyz');

// ===== TEST 3: Player-Resume sendet rejoin (mit oldId) statt join =====
localStorage._d = {};
__peerInstances = [];
G.joinRoom('PlayerTest', 'ABCD', 0, 'old-id-123');
lastPeer()._trigger('open', 'new-id-456');
let conn = lastPeer().lastConn;
conn.open = true;
conn._trigger('open');
check('Resume-Join sendet rejoin mit oldId', conn.sent.length === 1 && conn.sent[0].type === 'rejoin' && conn.sent[0].oldId === 'old-id-123');
saved = JSON.parse(localStorage.getItem('mk-session'));
check('Session nach Player-Rejoin gespeichert (role player)', !!saved && saved.role === 'player' && saved.code === 'ABCD' && saved.id === 'new-id-456');

// ===== TEST 4: Normaler Join (kein Resume) sendet join, nicht rejoin =====
localStorage._d = {};
__peerInstances = [];
G.joinRoom('PlayerTest2', 'EFGH');
lastPeer()._trigger('open', 'new-id-789');
let conn2 = lastPeer().lastConn;
conn2.open = true;
conn2._trigger('open');
check('Normaler Join (ohne resumeId) sendet join statt rejoin', conn2.sent.length === 1 && conn2.sent[0].type === 'join');

// ===== TEST 4b: Player-Resume (resumeId gesetzt) bekommt dasselbe lange Retry-
// Budget wie der Host (Kernfix, s.o.) - gibt NICHT nach 2 Fehlversuchen auf,
// weil der Host in dieser Zeit selbst noch versuchen koennte, seine alte
// Peer-ID zurueckzuholen. =====
localStorage._d = {};
__peerInstances = [];
G.gameState.phase = 'home';
G.joinRoom('ResumePlayer', 'QRST', 0, 'old-id-999');
for (let i = 0; i < 20; i++) { lastPeer()._trigger('error', { type: 'network' }); }
check('Player-Resume gibt nach 20 Fehlversuchen noch NICHT auf', G.gameState.phase === 'home');
lastPeer()._trigger('error', { type: 'network' });
check('Player-Resume gibt erst nach 20 Retries auf (lange Geduld bei Resume)', G.gameState.phase === 'error');

// ===== TEST 4c: Frischer Join (kein resumeId) bleibt beim schnellen Fail
// (2 Retries) - ein vertippter Code soll nicht eine Minute lang haengen. =====
localStorage._d = {};
__peerInstances = [];
G.gameState.phase = 'home';
G.joinRoom('FreshPlayer', 'UVWX');
lastPeer()._trigger('error', { type: 'network' });
lastPeer()._trigger('error', { type: 'network' });
check('Frischer Join nach 2 Fehlversuchen noch nicht aufgegeben', G.gameState.phase === 'home');
lastPeer()._trigger('error', { type: 'network' });
check('Frischer Join gibt weiterhin schnell auf (2 Retries, unveraendert)', G.gameState.phase === 'error');

// ===== TEST 5: Kicked-Nachricht loescht gespeicherte Session =====
localStorage.setItem('mk-session', JSON.stringify({ role: 'player', code: 'ABCD', name: 'X', id: 'y' }));
G.handlePlayerMessage({ type: 'kicked' });
check('Kicked loescht gespeicherte Session (kein Auto-Rejoin nach Kick)', localStorage.getItem('mk-session') === null);

// ===== TEST 6: leaveGame() loescht gespeicherte Session =====
localStorage.setItem('mk-session', JSON.stringify({ role: 'player', code: 'ABCD', name: 'X', id: 'y' }));
G.role = 'player'; G.hostConn = { open: true, send() { } };
G.leaveGame();
check('leaveGame loescht gespeicherte Session (bewusstes Verlassen)', localStorage.getItem('mk-session') === null);

// ===== TEST 7: Post-Connect-Fehler (mid-game) loescht Session statt Endlosschleife =====
localStorage._d = {};
__peerInstances = [];
G.joinRoom('PlayerTest3', 'IJKL');
lastPeer()._trigger('open', 'new-id-999');
let conn3 = lastPeer().lastConn;
conn3.open = true;
conn3._trigger('open');
check('Session vor Fehler vorhanden', localStorage.getItem('mk-session') !== null);
conn3._trigger('error', { type: 'network' });
check('Post-Connect-Fehler loescht Session (kein Resume-Loop auf totem Raum)', localStorage.getItem('mk-session') === null);

// ===== TEST 8: Gespeicherte Session enthaelt frischen Zeitstempel (Basis fuer Max-Age-Check) =====
localStorage._d = {};
__peerInstances = [];
const tsBefore = Date.now();
G.createHost('HostTest3', 0, 'MNOP');
lastPeer()._trigger('open', 'msk-dev-mnop');
const savedTs = JSON.parse(localStorage.getItem('mk-session'));
check('saveSession() setzt einen aktuellen Zeitstempel (ts)', !!savedTs.ts && savedTs.ts >= tsBefore && savedTs.ts <= Date.now());

// ===== TEST 9: Gespeicherte Sessions duerfen die Landingpage NICHT automatisch
// in eine alte Lobby ziehen. Fortsetzen ist nur noch explizit per Button. =====
localStorage.setItem('mk-session', JSON.stringify({ role: 'host', code: 'ABCD', name: 'Host', id: 'msk-dev-abcd', ts: Date.now() }));
check('Gespeicherte Host-Session ist fuer explizites Fortsetzen lesbar', !!G.getSavedSession() && G.getSavedSession().code === 'ABCD');
check('Landingpage startet alte Session nicht automatisch', !/AUTO-RESUME/.test(html) && !/let _resumed/.test(html) && /resumeSavedSession/.test(html) && /render\(\);\s*<\/script>/.test(html));
check('localStorage (nicht sessionStorage) wird fuer mk-session verwendet', /const SESSION_KEY = 'mk-session'/.test(html) && /localStorage\.setItem\(SESSION_KEY/.test(html) && !/sessionStorage\.(get|set|remove)Item\([`'"]mk-session/.test(html));

realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

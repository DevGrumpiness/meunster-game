// Pollt den ntfy-Feedback-Kanal und archiviert neue Einträge in feedback/data.json
import fs from 'fs';

const TOPIC = 'https://ntfy.sh/msgame-fb-ziyqckpnpsfu';
const FILE = 'feedback/data.json';

const res = await fetch(TOPIC + '/json?poll=1&since=all');
if (!res.ok) { console.error('Kanal-Abruf fehlgeschlagen: HTTP ' + res.status); process.exit(1); }
const text = await res.text();

let archive = [];
try { archive = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { }
if (!Array.isArray(archive)) archive = [];

const seen = new Set(archive.map(e => e && e.id));
let added = 0;
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
  if (!ev || ev.event !== 'message' || !ev.id || seen.has(ev.id)) continue;
  let payload; try { payload = JSON.parse(ev.message); } catch (e) { continue; }
  if (!payload || payload.v !== 1 || typeof payload.kind !== 'string' || !payload.data) continue;
  archive.push({
    id: String(ev.id).slice(0, 30),
    kind: payload.kind.slice(0, 20),
    ts: Number(payload.ts) || (ev.time * 1000) || Date.now(),
    data: payload.data
  });
  seen.add(ev.id);
  added++;
}

archive.sort((a, b) => (a.ts || 0) - (b.ts || 0));
fs.writeFileSync(FILE, JSON.stringify(archive, null, 1) + '\n');
console.log('Neu archiviert: ' + added + ' – gesamt: ' + archive.length);

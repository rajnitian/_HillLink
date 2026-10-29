const t = require('node:test'), a = require('node:assert'); const { dijkstra, compatible, EDGES } = require('../server');
t('O- gives to all red cells', () => a.ok(compatible('O-', 'AB+', 'packed_red_cells').ok));
t('B+ cannot give to O-', () => a.ok(!compatible('B+', 'O-', 'whole_blood').ok));
t('AB plasma universal donor', () => a.ok(compatible('AB+', 'O+', 'plasma').ok));
t('route found, estimate flagged', () => { const r = dijkstra(0, 4); a.ok(r.minutes > 0 && r.estimate); });
t('isolated node unreachable', () => a.strictEqual(dijkstra(0, 9), null));
t('rain and closures change time', () => { const b = dijkstra(0, 4).minutes; EDGES.forEach(e => e.rain = 1); const w = dijkstra(0, 4).minutes; a.ok(w > b);
  EDGES.forEach(e => { e.rain = 0; e.closed = true; }); a.strictEqual(dijkstra(0, 4), null); EDGES.forEach(e => e.closed = false); });

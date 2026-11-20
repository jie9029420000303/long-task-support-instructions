// Preserve worker-to-package ownership with each dispatch snapshot. Import the old journal just once.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function workerId(handle) {
  if (typeof handle !== 'string' || handle === 'main' || /^(resource|workflow):/.test(handle)) return null;
  if (handle.startsWith('agent:')) return handle.slice(6);
  if (/^[\da-f]{8}-[\da-f-]{27}$/i.test(handle) || handle.startsWith('/root/')) return handle;
  return null;
}

// An App path and a thread UUID can designate the same worker. Verify the root before sharing ownership.
function discover(run, ids) {
  const found = new Map(), binding = JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
  if (binding.platform !== 'codex') return found;
  const home = process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const file = process.env.LT_CODEX_STATE_DB || path.join(home,'state_5.sqlite');
  if (fs.existsSync(file)) {
    let db;
    try {
      db = new (require('node:sqlite').DatabaseSync)(file,{readOnly:true});
      const query = db.prepare(`WITH RECURSIVE parents(id) AS (
        SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?
        UNION SELECT e.parent_thread_id FROM thread_spawn_edges e JOIN parents p ON e.child_thread_id = p.id
      ) SELECT agent_path FROM threads WHERE id = ? AND EXISTS (SELECT 1 FROM parents WHERE id = ?)`);
      for (const id of ids) {
        const row = query.get(id,id,binding.executorId);
        if (row?.agent_path?.startsWith('/root/')) found.set(id,row.agent_path);
      }
    } catch { /* The exact thread headers also identify workers when the App index is unavailable. */ }
    finally { db?.close(); }
  }
  const missing = new Set([...ids].filter(id=>!found.has(id)));
  if (missing.size) for (const pair of require('./pace.cjs').workerPaths(binding,missing)) found.set(...pair);
  return found;
}

function check(run, snapshot, previous) {
  const owners = new Map(Object.entries(previous?.workerOwners || {}));
  const current = previous?.packages?.inFlight || [];
  if (previous && !previous.workerOwners) {
    const file = path.join(run, 'dispatch-history.jsonl');
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        for (const item of JSON.parse(line).inFlight || []) {
          const worker = workerId(item.handle);
          if (worker && item.id) owners.set(worker, item.id);
        }
      }
    }
    for (const item of current) {
      const worker = workerId(item.handle);
      if (worker) owners.set(worker, item.id);
    }
  }
  const active = snapshot.packages.inFlight;
  const paths = new Map(Object.entries(previous?.workerAliases || {}));
  const workers = [...owners.keys(), ...active.map(item=>workerId(item.handle)).filter(Boolean)];
  if (workers.some(id=>id.startsWith('/root/')) && active.some(item=>workerId(item.handle) && !owners.has(workerId(item.handle)))) {
    const unknown = new Set(workers.filter(id=>uuid.test(id) && !paths.has(id)));
    if (unknown.size) for (const [id,agentPath] of discover(run,unknown)) paths.set(id,agentPath);
  }
  for (const [id,agentPath] of paths) {
    if (owners.has(id) && !owners.has(agentPath)) owners.set(agentPath,owners.get(id));
  }
  for (const item of active) {
    const worker = workerId(item.handle);
    if (!worker) continue;
    const agentPath = paths.get(worker);
    const owner = owners.get(worker) || (agentPath && owners.get(agentPath));
    if (owner && owner !== item.id && !current.some(old => old.id === item.id && old.handle === item.handle))
      throw Error('Use a new subagent for '+item.id+'; '+worker+' belongs to '+owner);
    owners.set(worker, item.id);
    if (agentPath) owners.set(agentPath,item.id);
  }
  if (paths.size) snapshot.workerAliases = Object.fromEntries(paths);
  else delete snapshot.workerAliases;
  snapshot.workerOwners = Object.fromEntries(owners);
}
module.exports = {check};

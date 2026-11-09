// A process is absent only on ESRCH. EPERM and invalid identities are unknown, not proof of death.
function probe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
// Whether a PID runs the named script: false when it is gone or another program reuses it, null when ps cannot tell.
// Only the file name is matched: ps prints non-ASCII paths in an escaped form.
function runs(pid, script) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let command;
  try { command = require('node:child_process').execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'], timeout:5000}); }
  catch (error) { return error.status === 1 ? false : null; }
  return new RegExp('(^|[\\s/])' + script.replace(/\./g, '\\.') + '(\\s|$)').test(command.trim());
}
module.exports = {probe, runs};

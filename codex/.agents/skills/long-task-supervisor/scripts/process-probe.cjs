// A process is absent only on ESRCH. EPERM and invalid identities are unknown, not proof of death.
function probe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
module.exports = {probe};

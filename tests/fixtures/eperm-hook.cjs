const original=process.kill;
process.kill=function(pid,signal){if([91001,91002].includes(pid)){const e=Error('simulated EPERM');e.code='EPERM';throw e;}return original(pid,signal);};

/**
 * Stands in for the file index worker in tests: takes whatever it is sent and exits without
 * answering, the way a worker that crashes mid-request leaves its caller.
 */
declare const self: Worker;
self.onmessage = () => { setTimeout(() => process.exit(1), 20); };

// A module run in a worker (spawned through the SDK's spawnWorker). It attaches
// its listener only after a pause, as a module with imports or top-level await
// does: messages the page posted right after spawnWorker() must still arrive.
await new Promise((resolve) => setTimeout(resolve, 200));
self.onmessage = (e) => self.postMessage({ echo: e.data });
self.postMessage({ answer: 6 * 7 });

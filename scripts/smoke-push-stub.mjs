// Preloaded (node --import) into the second server of the smoke test, and nowhere else. It replaces fetch
// so that no push message ever leaves the machine: every call is written to stdout as one JSON line
// ({"event":"smoke.push", ...}) for the smoke test to read, and answered with 201 like a push service
// that accepted the message. The real fetch is never called, not even for an address that is not a push service.
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body;
  console.log(JSON.stringify({ event: 'smoke.push', url, method: init?.method ?? 'GET', bytes: body ? Buffer.byteLength(body) : 0, redirect: init?.redirect ?? null }));
  return new Response(null, { status: 201 });
};

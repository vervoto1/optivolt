// The server's clock, as an offset from the browser's.
//
// The planner decides by its own clock which slots fall before or after a
// switch instant (the end of net metering), so a status that says which
// regime is active now must use that clock too, not a browser clock that may
// be off. The offset is learned from the Date header of a server response
// (see fetchServerTimeZone); until then it is 0 (the browser's clock).

let offsetMs = 0;

// The server's current time in epoch ms.
export function serverNowMs(browserNowMs = Date.now()) {
  return browserNowMs + offsetMs;
}

// Set the offset from an HTTP Date header received at `receivedAtMs`. The
// header has whole seconds, truncated, so the middle of that second is used.
// A missing or unparseable header resets to the browser's clock. Returns the
// offset now in use.
export function syncServerClock(dateHeader, receivedAtMs = Date.now()) {
  const serverMs = Date.parse(String(dateHeader ?? ""));
  offsetMs = Number.isFinite(serverMs) ? serverMs + 500 - receivedAtMs : 0;
  return offsetMs;
}

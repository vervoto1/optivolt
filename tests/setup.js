import { beforeEach } from 'vitest';

// When the suite runs inside Home Assistant OS (e.g. the add-on container or an
// SSH session under /config), the platform exports SUPERVISOR_TOKEN into the
// environment. resolveHaHttpConfig/resolveHaWsConfig treat that token as a
// signal to route through the supervisor proxy, which flips the HA client into
// add-on mode and breaks tests that assert standalone behaviour (missing creds
// -> error/null, configured haUrl is used, etc.). CI has no SUPERVISOR_TOKEN,
// so this only bites locally. Clear it before every test so the suite is
// hermetic by default; tests that exercise the supervisor path set the token
// explicitly inside the test body.
delete process.env.SUPERVISOR_TOKEN;

beforeEach(() => {
  delete process.env.SUPERVISOR_TOKEN;
});

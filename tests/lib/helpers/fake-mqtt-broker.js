// Minimal fake MQTT 3.1.1 broker on a real TCP socket, for exercising mqtt.js
// reconnect behaviour end to end (the mocked unit tests cannot: they replace
// mqtt.js entirely).
//
// - A CONNECT is accepted (CONNACK rc=0) while `state.acceptNext > 0` or
//   `state.acceptAll` is set; otherwise it is refused with CONNACK rc=`refuseRc`
//   (default 5, "Not authorized") and the socket is closed, the way Venus'
//   flashmq refuses a password login it cannot (yet) verify.
// - SUBSCRIBE is acknowledged; subscribing to N/+/system/0/Serial delivers the
//   portal id; a publish to R/<serial>/<path> answers on N/<serial>/<path> when
//   that topic is subscribed.
import net from 'node:net';
import mqttPacket from 'mqtt-packet';

export const SERIAL = 'c0619ab00000';

export function startFakeBroker({ refuseRc = 5, socPercent = 57, acceptNext = 1 } = {}) {
  const state = {
    connects: 0,
    accepted: 0,
    refused: 0,
    acceptNext,
    acceptAll: false,
    sockets: new Set(),
    publishesReceived: [],
  };

  const server = net.createServer((sock) => {
    state.sockets.add(sock);
    sock.on('close', () => state.sockets.delete(sock));
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    const send = (pkt) => {
      if (!sock.destroyed) sock.write(mqttPacket.generate(pkt));
    };
    const subs = new Set();
    const deliver = (topic, value) => {
      send({ cmd: 'publish', topic, payload: JSON.stringify({ value }), qos: 0, retain: false });
    };

    parser.on('packet', (p) => {
      if (p.cmd === 'connect') {
        state.connects += 1;
        if (state.acceptAll || state.acceptNext > 0) {
          if (state.acceptNext > 0) state.acceptNext -= 1;
          state.accepted += 1;
          send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
        } else {
          state.refused += 1;
          send({ cmd: 'connack', returnCode: refuseRc, sessionPresent: false });
          setTimeout(() => sock.end(), 10);
        }
      } else if (p.cmd === 'subscribe') {
        send({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 0) });
        for (const s of p.subscriptions) {
          subs.add(s.topic);
          if (s.topic === 'N/+/system/0/Serial') deliver(`N/${SERIAL}/system/0/Serial`, SERIAL);
        }
      } else if (p.cmd === 'unsubscribe') {
        for (const topic of p.unsubscriptions) subs.delete(topic);
        send({ cmd: 'unsuback', messageId: p.messageId });
      } else if (p.cmd === 'publish') {
        state.publishesReceived.push({ topic: p.topic, payload: p.payload.toString() });
        if (p.topic.startsWith('R/')) {
          const nTopic = `N/${p.topic.slice(2)}`;
          if (subs.has(nTopic)) deliver(nTopic, nTopic.endsWith('/Soc') ? socPercent : 4);
        }
      } else if (p.cmd === 'pingreq') {
        send({ cmd: 'pingresp' });
      } else if (p.cmd === 'disconnect') {
        sock.end();
      }
    });
    sock.on('data', (d) => parser.parse(d));
    sock.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        /** Drop every live connection (the broker keeps listening). */
        dropAll() {
          for (const s of state.sockets) s.destroy();
        },
        /** Stop listening and drop every connection. */
        close() {
          for (const s of state.sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

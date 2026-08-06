/**
 * A minimal `upsd` stand-in for development: speaks enough of the NUT protocol
 * to drive the dashboard without real hardware. Two simulated devices drift
 * their values, and one of them periodically drops to battery so the alert and
 * diagram states can be exercised.
 *
 *   npm run mock-nut          # listens on 127.0.0.1:3493
 *   MOCK_PORT=3499 npm run mock-nut
 */
import net from 'node:net';
import { quote, tokenize } from '../nut/protocol.js';

const PORT = Number(process.env.MOCK_PORT ?? 3493);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';

interface MockDevice {
  name: string;
  description: string;
  vars: Record<string, string>;
  commands: string[];
  writable: string[];
}

const devices: MockDevice[] = [
  {
    name: 'rack',
    description: 'Eaton 5PX 1500 im Serverschrank',
    commands: [
      'beeper.disable',
      'beeper.enable',
      'test.battery.start.quick',
      'test.battery.stop',
      // Bewusst dabei, damit sich der Weg für heikle Befehle testen lässt,
      // ohne echte Hardware abzuschalten.
      'load.off',
      'shutdown.reboot',
    ],
    writable: ['ups.delay.shutdown', 'ups.delay.start'],
    vars: {
      'device.type': 'ups',
      'ups.mfr': 'EATON',
      'ups.model': '5PX 1500',
      'ups.serial': 'G1234A56789',
      'ups.status': 'OL',
      'ups.load': '38',
      'ups.realpower.nominal': '1350',
      'ups.temperature': '28.4',
      'ups.delay.shutdown': '20',
      'ups.delay.start': '30',
      'battery.charge': '100',
      'battery.charge.low': '30',
      'battery.runtime': '2100',
      'battery.voltage': '54.2',
      'battery.type': 'PbAc',
      'battery.date': '2024-03-11',
      'input.voltage': '231.0',
      'input.frequency': '50.0',
      'output.voltage': '230.2',
      'driver.name': 'usbhid-ups',
      'driver.version': '2.8.1',
    },
  },
  {
    name: 'desk',
    description: 'APC Back-UPS am Arbeitsplatz',
    commands: ['beeper.mute', 'test.battery.start.deep'],
    writable: [],
    vars: {
      'device.type': 'ups',
      'ups.mfr': 'American Power Conversion',
      'ups.model': 'Back-UPS ES 700G',
      'ups.serial': '4B1842P00000',
      'ups.status': 'OL',
      'ups.load': '17',
      'ups.realpower.nominal': '405',
      'battery.charge': '96',
      'battery.runtime': '1480',
      'battery.voltage': '13.4',
      'input.voltage': '229.4',
      'input.frequency': '49.9',
      'output.voltage': '229.4',
      'driver.name': 'usbhid-ups',
      'driver.version': '2.8.1',
    },
  },
];

/** Nudges a numeric variable by a random walk, clamped to a range. */
function drift(device: MockDevice, key: string, amount: number, min: number, max: number, decimals = 1): void {
  const current = Number(device.vars[key] ?? 0);
  const next = Math.min(max, Math.max(min, current + (Math.random() - 0.5) * amount));
  device.vars[key] = next.toFixed(decimals);
}

let outageTicks = 0;

setInterval(() => {
  const rack = devices[0]!;
  const desk = devices[1]!;

  // Roughly every four minutes the rack UPS loses mains for ~40 seconds.
  if (outageTicks === 0 && Math.random() < 0.004) outageTicks = 20;

  if (outageTicks > 0) {
    outageTicks--;
    const charge = Math.max(12, Number(rack.vars['battery.charge']) - 1.6);
    rack.vars['battery.charge'] = charge.toFixed(0);
    rack.vars['battery.runtime'] = Math.round(charge * 21).toString();
    rack.vars['ups.status'] = charge < 30 ? 'OB LB DISCHRG' : 'OB DISCHRG';
    rack.vars['input.voltage'] = '0.0';
  } else {
    const charge = Math.min(100, Number(rack.vars['battery.charge']) + 0.9);
    rack.vars['battery.charge'] = charge.toFixed(0);
    rack.vars['battery.runtime'] = Math.round(charge * 21).toString();
    rack.vars['ups.status'] = charge < 100 ? 'OL CHRG' : 'OL';
    drift(rack, 'input.voltage', 2.5, 224, 238);
  }

  drift(rack, 'ups.load', 6, 22, 61, 0);
  drift(rack, 'output.voltage', 1.2, 228, 232);
  drift(rack, 'ups.temperature', 0.6, 24, 33);
  drift(desk, 'ups.load', 5, 8, 44, 0);
  drift(desk, 'input.voltage', 2.2, 223, 236);
  desk.vars['output.voltage'] = desk.vars['input.voltage']!;
}, 2000);

function findDevice(name: string): MockDevice | undefined {
  return devices.find((device) => device.name === name);
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');

    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      handle(line);
      index = buffer.indexOf('\n');
    }
  });

  socket.on('error', () => socket.destroy());

  function reply(text: string): void {
    socket.write(`${text}\n`);
  }

  function handle(line: string): void {
    const tokens = tokenize(line);
    const verb = (tokens[0] ?? '').toUpperCase();

    if (verb === 'VER') return reply('mock-nut 1.0 / Network UPS Tools upsd 2.8.1');
    if (verb === 'NETVER') return reply('1.3');
    if (verb === 'USERNAME' || verb === 'PASSWORD') return reply('OK');
    if (verb === 'LOGOUT') {
      reply('OK Goodbye');
      socket.end();
      return;
    }

    if (verb === 'LIST') {
      const kind = (tokens[1] ?? '').toUpperCase();

      if (kind === 'UPS') {
        reply('BEGIN LIST UPS');
        for (const device of devices) reply(`UPS ${device.name} ${quote(device.description)}`);
        return reply('END LIST UPS');
      }

      const device = findDevice(tokens[2] ?? '');
      if (!device) return reply('ERR UNKNOWN-UPS');

      if (kind === 'VAR') {
        reply(`BEGIN LIST VAR ${device.name}`);
        for (const [key, value] of Object.entries(device.vars)) {
          reply(`VAR ${device.name} ${key} ${quote(value)}`);
        }
        return reply(`END LIST VAR ${device.name}`);
      }
      if (kind === 'CMD') {
        reply(`BEGIN LIST CMD ${device.name}`);
        for (const cmd of device.commands) reply(`CMD ${device.name} ${cmd}`);
        return reply(`END LIST CMD ${device.name}`);
      }
      if (kind === 'RW') {
        reply(`BEGIN LIST RW ${device.name}`);
        for (const key of device.writable) {
          reply(`RW ${device.name} ${key} ${quote(device.vars[key] ?? '')}`);
        }
        return reply(`END LIST RW ${device.name}`);
      }
      return reply('ERR INVALID-ARGUMENT');
    }

    if (verb === 'GET') {
      const kind = (tokens[1] ?? '').toUpperCase();
      const device = findDevice(tokens[2] ?? '');
      if (!device) return reply('ERR UNKNOWN-UPS');

      if (kind === 'VAR') {
        const value = device.vars[tokens[3] ?? ''];
        if (value === undefined) return reply('ERR VAR-NOT-SUPPORTED');
        return reply(`VAR ${device.name} ${tokens[3]} ${quote(value)}`);
      }
      if (kind === 'DESC') return reply(`DESC ${device.name} ${tokens[3]} ${quote('Simulierte Variable')}`);
      if (kind === 'CMDDESC') return reply(`CMDDESC ${device.name} ${tokens[3]} ${quote('Simulierter Befehl')}`);
      return reply('ERR INVALID-ARGUMENT');
    }

    if (verb === 'INSTCMD') {
      const device = findDevice(tokens[1] ?? '');
      if (!device) return reply('ERR UNKNOWN-UPS');
      if (!device.commands.includes(tokens[2] ?? '')) return reply('ERR CMD-NOT-SUPPORTED');

      console.log(`[mock] INSTCMD ${device.name} ${tokens[2]}`);
      return reply('OK');
    }

    if (verb === 'SET') {
      const device = findDevice(tokens[2] ?? '');
      if (!device) return reply('ERR UNKNOWN-UPS');

      const name = tokens[3] ?? '';
      if (!device.writable.includes(name)) return reply('ERR READONLY');

      device.vars[name] = tokens[4] ?? '';
      console.log(`[mock] SET ${device.name} ${name} = ${device.vars[name]}`);
      return reply('OK');
    }

    reply('ERR UNKNOWN-COMMAND');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mock-NUT-Server auf ${HOST}:${PORT} — Geräte: ${devices.map((d) => d.name).join(', ')}`);
});

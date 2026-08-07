/**
 * Simuliert eine APC-Netzwerkkarte per SNMP, damit sich die SNMP-Anbindung
 * ohne echte Hardware prüfen lässt. Die Werte wandern langsam, und alle paar
 * Minuten fällt der Netzstrom aus.
 *
 *   npm run mock-snmp                 # lauscht auf 127.0.0.1:1161
 *   MOCK_SNMP_PORT=161 npm run mock-snmp
 */
import snmp from 'net-snmp';

const PORT = Number(process.env.MOCK_SNMP_PORT ?? 1161);

/** OID ohne die abschließende `.0`, dazu Typ und Startwert. */
const SCALARS: Record<string, { oid: string; type: number; value: string | number }> = {
  model: { oid: '1.3.6.1.4.1.318.1.1.1.1.1.1', type: snmp.ObjectType.OctetString, value: 'Smart-UPS 1500' },
  firmware: { oid: '1.3.6.1.4.1.318.1.1.1.1.2.1', type: snmp.ObjectType.OctetString, value: 'UPS 09.3 / MCU 14.0' },
  serial: { oid: '1.3.6.1.4.1.318.1.1.1.1.2.3', type: snmp.ObjectType.OctetString, value: 'AS1234567890' },
  batteryStatus: { oid: '1.3.6.1.4.1.318.1.1.1.2.1.1', type: snmp.ObjectType.Integer, value: 2 },
  secondsOnBattery: { oid: '1.3.6.1.4.1.318.1.1.1.2.1.2', type: snmp.ObjectType.TimeTicks, value: 0 },
  charge: { oid: '1.3.6.1.4.1.318.1.1.1.2.2.1', type: snmp.ObjectType.Gauge, value: 100 },
  batteryTemperature: { oid: '1.3.6.1.4.1.318.1.1.1.2.2.2', type: snmp.ObjectType.Gauge, value: 27 },
  runtimeTicks: { oid: '1.3.6.1.4.1.318.1.1.1.2.2.3', type: snmp.ObjectType.TimeTicks, value: 220000 },
  replaceBattery: { oid: '1.3.6.1.4.1.318.1.1.1.2.2.4', type: snmp.ObjectType.Integer, value: 1 },
  batteryVoltage: { oid: '1.3.6.1.4.1.318.1.1.1.2.2.8', type: snmp.ObjectType.Gauge, value: 54 },
  inputVoltage: { oid: '1.3.6.1.4.1.318.1.1.1.3.2.1', type: snmp.ObjectType.Gauge, value: 231 },
  inputFrequency: { oid: '1.3.6.1.4.1.318.1.1.1.3.2.4', type: snmp.ObjectType.Gauge, value: 50 },
  outputStatus: { oid: '1.3.6.1.4.1.318.1.1.1.4.1.1', type: snmp.ObjectType.Integer, value: 2 },
  outputVoltage: { oid: '1.3.6.1.4.1.318.1.1.1.4.2.1', type: snmp.ObjectType.Gauge, value: 230 },
  outputLoad: { oid: '1.3.6.1.4.1.318.1.1.1.4.2.3', type: snmp.ObjectType.Gauge, value: 34 },
  outputCurrent: { oid: '1.3.6.1.4.1.318.1.1.1.4.2.4', type: snmp.ObjectType.Gauge, value: 2 },
  outputPower: { oid: '1.3.6.1.4.1.318.1.1.1.4.2.8', type: snmp.ObjectType.Gauge, value: 460 },
};

const agent = snmp.createAgent({ port: PORT, disableAuthorization: true }, (error: Error | null) => {
  if (error) console.error('[mock-snmp]', error);
});

const mib = agent.getMib();

for (const [name, entry] of Object.entries(SCALARS)) {
  mib.registerProvider({
    name,
    type: snmp.MibProviderType.Scalar,
    oid: entry.oid,
    scalarType: entry.type,
    // Ohne MAX-ACCESS antwortet der Agent auf jede Abfrage mit NoAccess.
    maxAccess: snmp.MaxAccess['read-only'],
  });
  mib.setScalarValue(name, entry.value);
}

const state = {
  charge: 100,
  load: 34,
  inputVoltage: 231,
  temperature: 27,
  outageTicks: 0,
};

function drift(value: number, amount: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value + (Math.random() - 0.5) * amount));
}

setInterval(() => {
  // Etwa alle vier Minuten ein Netzausfall über rund eine Minute.
  if (state.outageTicks === 0 && Math.random() < 0.008) state.outageTicks = 30;

  if (state.outageTicks > 0) {
    state.outageTicks--;
    state.charge = Math.max(15, state.charge - 1.5);
    state.inputVoltage = 0;
    mib.setScalarValue('outputStatus', 3);
    mib.setScalarValue('batteryStatus', state.charge < 30 ? 3 : 2);
    mib.setScalarValue('secondsOnBattery', (30 - state.outageTicks) * 200);
  } else {
    state.charge = Math.min(100, state.charge + 0.8);
    state.inputVoltage = drift(state.inputVoltage || 230, 3, 224, 238);
    mib.setScalarValue('outputStatus', 2);
    mib.setScalarValue('batteryStatus', 2);
    mib.setScalarValue('secondsOnBattery', 0);
  }

  state.load = drift(state.load, 6, 18, 62);
  state.temperature = drift(state.temperature, 0.5, 24, 32);

  mib.setScalarValue('charge', Math.round(state.charge));
  mib.setScalarValue('runtimeTicks', Math.round(state.charge * 2200));
  mib.setScalarValue('inputVoltage', Math.round(state.inputVoltage));
  mib.setScalarValue('outputVoltage', state.outageTicks > 0 ? 230 : Math.round(state.inputVoltage));
  mib.setScalarValue('outputLoad', Math.round(state.load));
  mib.setScalarValue('outputPower', Math.round((state.load / 100) * 1350));
  mib.setScalarValue('outputCurrent', Math.round((state.load / 100) * 6));
  mib.setScalarValue('batteryTemperature', Math.round(state.temperature));
}, 2000);

console.log(`Mock-SNMP-USV (APC PowerNet) auf UDP ${PORT} — Community beliebig, Autorisierung aus`);

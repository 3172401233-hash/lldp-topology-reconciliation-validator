#!/usr/bin/env node
'use strict';

// CLI：读取采集输入 JSON，执行对账，输出差异报告。
// 本工具只消费已采集的 LLDP 数据，不发送任何真实 LLDP 帧。
//
// 用法:
//   node bin/lldp-reconcile.js --input input.json --state state.json [--now <ms>]
//
// input.json 结构:
// {
//   "advertisements": [
//     { "localDevice": "sw1", "localPort": "Gi0/1",
//       "remoteChassisId": "aa:bb:cc:dd:ee:ff", "remoteChassisSubtype": 4,
//       "remotePortId": "GigabitEthernet0/2", "remotePortSubtype": 5,
//       "ttl": 120, "lastAdvertisedAt": 1730000000000, "ifOperStatus": "up" }
//   ],
//   "interfaceStatus": [{ "localDevice": "sw1", "localPort": "Gi0/2", "ifOperStatus": "down" }],
//   "topology": { "nodes": ["sw1", "sw2"],
//                 "edges": [{ "aDevice": "sw1", "aPort": "Gi0/1",
//                             "bDevice": "sw2", "bPort": "Gi0/2" }] }
// }

const fs = require('node:fs');
const { StateStore } = require('../src/stateStore');
const { LldpReconciler } = require('../src/reconciler');

function parseArgs(argv) {
  const args = { state: 'lldp-state.json', now: Date.now() };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--input') args.input = argv[++i];
    else if (flag === '--state') args.state = argv[++i];
    else if (flag === '--now') args.now = Number(argv[++i]);
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.error('usage: node bin/lldp-reconcile.js --input input.json --state state.json [--now ms]');
    process.exit(args.help ? 0 : 2);
  }

  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const store = new StateStore(args.state);
  store.load();
  const reconciler = new LldpReconciler(store, input.options ?? {});

  const events = [];
  for (const adv of input.advertisements ?? []) {
    const { record, event } = reconciler.ingest(adv, args.now);
    events.push({ localPort: record.key, identity: record.identity, event });
  }
  for (const st of input.interfaceStatus ?? []) {
    reconciler.updateInterfaceStatus(st.localDevice, st.localPort, st.ifOperStatus, args.now);
  }

  const report = reconciler.reconcile(input.topology ?? { nodes: [], edges: [] }, args.now);
  store.save();

  console.log(
    JSON.stringify(
      {
        ingested: events,
        effectiveNeighbors: report.effectiveNeighbors.map((r) => ({
          localDevice: r.localDevice,
          localPort: r.localPortRaw,
          remoteChassisId: r.remoteChassisId,
          remotePortId: r.remotePortId,
          ttl: r.ttl,
          expiresAt: r.lastAdvertisedAt + r.ttl * 1000,
          flapping: r.flapping,
        })),
        errorEdges: report.errorEdges,
        orphanNodes: report.orphanNodes,
        devicesNeedingRepoll: report.devicesNeedingRepoll,
      },
      null,
      2,
    ),
  );
}

main();

# lldp-topology-reconciliation-validator

对账 LLDP 邻居、拓扑和端口状态。解决链路迁移后监控拓扑残留旧连接的问题：
根据采集到的 LLDP 通告计算当前有效邻居，与监控拓扑快照比对，输出差异。

> **注意：本工具不发送任何真实 LLDP 帧。** 它只消费已经由其他采集器
> （如 snmpd、lldpd、网络遥测管道）收集到的 LLDP 数据做离线对账，
> 不会在网络接口上收发 LLDPDU，也不会修改任何设备配置。

## 要求

- Node.js >= 24.16.0（无第三方依赖）

## 功能

- **有效邻居计算**：录入本地端口、远端 chassis/port ID、TTL、最后一次通告
  时间与接口状态，判定哪些邻居当前仍然有效。
- **TTL 过期**：`lastAdvertisedAt + ttl` 过期即失效；接口 down 立即失效，
  不等 TTL。
- **端口复用 / 链路迁移**：同一本地端口学到新邻居身份时替换旧记录并写入
  迁移历史。
- **邻居快速回切**：在抖动窗口（默认 5 分钟）内切回最近见过的身份时记为
  `flap-back`，标记 `flapping` 并计入待重采设备。
- **设备 ID 归一化**：兼容 MAC（`:`/`-`/无分隔/点分）、IPv4、接口名缩写
  （`Gi0/1` ≡ `GigabitEthernet0/1`）与本地分配字符串，避免同一设备被当成
  两个邻居。
- **晚到 / 乱序通告**：同身份但时间戳或序号更旧的通告被丢弃；TTL 按原始
  通告时间起算，晚到不复活旧边。
- **持久状态存储**：邻居记录与迁移历史落盘 JSON（临时文件 + rename 原子
  写入），损坏文件自动备份重置。

## 对账输出

- `effectiveNeighbors`：当前有效邻居列表（含过期时间）。
- `errorEdges.stale`：拓扑快照中已失效的错误边（如迁移前的旧连接）。
- `errorEdges.missing`：有效邻居中存在但快照缺失的边。
- `orphanNodes`：移除错误边后没有任何有效边相连的孤立节点。
- `devicesNeedingRepoll`：需要重采确认的设备（记录过期 / 接口 down 但快照
  仍有边、或端口抖动）。

## 使用

```bash
node bin/lldp-reconcile.js --input input.json --state lldp-state.json [--now <ms>]
```

输入 JSON 结构：

```json
{
  "advertisements": [
    {
      "localDevice": "sw1",
      "localPort": "Gi0/1",
      "remoteChassisId": "aa:bb:cc:dd:ee:01",
      "remoteChassisSubtype": 4,
      "remotePortId": "GigabitEthernet0/2",
      "remotePortSubtype": 5,
      "ttl": 120,
      "lastAdvertisedAt": 1730000000000,
      "ifOperStatus": "up"
    }
  ],
  "interfaceStatus": [
    { "localDevice": "sw1", "localPort": "Gi0/2", "ifOperStatus": "down" }
  ],
  "topology": {
    "nodes": ["sw1", "sw2"],
    "edges": [
      { "aDevice": "sw1", "aPort": "Gi0/1", "bDevice": "sw2", "bPort": "Gi0/2" }
    ]
  }
}
```

`--state` 为持久状态文件，跨运行保留邻居记录与迁移历史；`--now` 用于
可重现的对账时间（默认当前时间）。

## 测试

```bash
node --test
```

覆盖 TTL 过期边界、端口迁移、端口复用、邻居快速回切、晚到 / 乱序通告、
设备 ID 格式归一化与状态持久化。

## 代码结构

- `src/identifiers.js` — chassis / port ID 归一化
- `src/stateStore.js` — 持久状态存储（原子写、损坏恢复）
- `src/reconciler.js` — 对账核心：录入、过期、有效邻居、拓扑差异
- `bin/lldp-reconcile.js` — CLI 入口
- `test/` — node:test 测试

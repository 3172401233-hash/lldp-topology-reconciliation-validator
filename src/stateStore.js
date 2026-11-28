'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;

/**
 * 持久状态存储：把 LLDP 邻居记录与迁移历史落盘为 JSON。
 * 写入采用临时文件 + rename，避免崩溃时留下半个文件。
 */
class StateStore {
  /**
   * @param {string} filePath 状态文件路径；传 ':memory:' 则仅内存（测试用）
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: STATE_VERSION, records: {}, history: [] };
  }

  static emptyState() {
    return { version: STATE_VERSION, records: {}, history: [] };
  }

  load() {
    if (this.filePath === ':memory:' || !fs.existsSync(this.filePath)) {
      this.state = StateStore.emptyState();
      return this.state;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.records) {
        throw new Error('invalid state shape');
      }
      this.state = {
        version: parsed.version ?? STATE_VERSION,
        records: parsed.records,
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch (err) {
      // 损坏的状态文件不应拖垮对账：备份后重置。
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      this.state = StateStore.emptyState();
    }
    return this.state;
  }

  save() {
    if (this.filePath === ':memory:') return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  get records() {
    return this.state.records;
  }

  get history() {
    return this.state.history;
  }

  getRecord(key) {
    return this.state.records[key] ?? null;
  }

  putRecord(key, record) {
    this.state.records[key] = record;
  }

  appendHistory(entry, maxEntries = 1000) {
    this.state.history.push(entry);
    if (this.state.history.length > maxEntries) {
      this.state.history.splice(0, this.state.history.length - maxEntries);
    }
  }
}

module.exports = { StateStore, STATE_VERSION };

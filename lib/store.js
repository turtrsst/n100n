'use strict';
// Penyimpanan SQLite (node:sqlite). Satu file: data/n100n.db

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'n100n.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',
  trigger_cfg TEXT NOT NULL DEFAULT '{}',
  nodes TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  error_workflow_id INTEGER,
  last_run TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT,
  started TEXT NOT NULL,
  finished TEXT,
  input TEXT,
  output TEXT,
  error TEXT,
  log TEXT,
  runs TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_wf ON executions(workflow_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status, id DESC);
`);

// Migrasi ringan untuk database lama (hasil versi sebelumnya).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('workflows', 'settings', "settings TEXT NOT NULL DEFAULT '{}'");
ensureColumn('executions', 'runs', 'runs TEXT');
ensureColumn('executions', 'log', 'log TEXT');

const nowIso = () => new Date().toISOString();
const clip = (s, n = 200000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '... [truncated]' : s);

function hydrate(row) {
  if (!row) return null;
  let nodes = [];
  let triggerCfg = {};
  let settings = {};
  let runs = null;
  try { nodes = JSON.parse(row.nodes || '[]'); } catch { nodes = []; }
  try { triggerCfg = JSON.parse(row.trigger_cfg || '{}'); } catch { triggerCfg = {}; }
  try { settings = JSON.parse(row.settings || '{}'); } catch { settings = {}; }
  if (row.runs !== undefined && row.runs !== null) {
    try { runs = JSON.parse(row.runs); } catch { runs = row.runs; }
  }
  const out = Object.assign({}, row, { nodes, trigger_cfg: triggerCfg, settings });
  if (row.runs !== undefined) out.runs = runs;
  return out;
}

const store = {
  db,
  DATA_DIR,
  hydrate,
  nowIso,
  clip,

  getWorkflow(id) {
    return hydrate(db.prepare('SELECT * FROM workflows WHERE id=?').get(Number(id)));
  },

  listWorkflows() {
    return db.prepare('SELECT * FROM workflows ORDER BY id').all().map(hydrate);
  },

  createWorkflow(body = {}) {
    const now = nowIso();
    const r = db.prepare(`INSERT INTO workflows(name,active,trigger,trigger_cfg,nodes,settings,error_workflow_id,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      String(body.name || 'Workflow baru'),
      body.active ? 1 : 0,
      String(body.trigger || 'manual'),
      JSON.stringify(body.trigger_cfg || {}),
      JSON.stringify(body.nodes || [{ type: 'manual', name: 'Start', config: {} }]),
      JSON.stringify(body.settings || {}),
      body.error_workflow_id || null,
      now, now
    );
    return this.getWorkflow(Number(r.lastInsertRowid));
  },

  updateWorkflow(id, body = {}) {
    const wf = this.getWorkflow(id);
    if (!wf) return null;
    db.prepare(`UPDATE workflows SET name=?,active=?,trigger=?,trigger_cfg=?,nodes=?,settings=?,error_workflow_id=?,updated=? WHERE id=?`)
      .run(
        body.name !== undefined ? String(body.name) : wf.name,
        body.active !== undefined ? (body.active ? 1 : 0) : wf.active,
        body.trigger !== undefined ? String(body.trigger) : wf.trigger,
        JSON.stringify(body.trigger_cfg !== undefined ? body.trigger_cfg : wf.trigger_cfg),
        JSON.stringify(body.nodes !== undefined ? body.nodes : wf.nodes),
        JSON.stringify(body.settings !== undefined ? body.settings : wf.settings),
        body.error_workflow_id !== undefined ? (body.error_workflow_id ? Number(body.error_workflow_id) : null) : wf.error_workflow_id,
        nowIso(), id
      );
    return this.getWorkflow(id);
  },

  deleteWorkflow(id) {
    db.prepare('DELETE FROM workflows WHERE id=?').run(Number(id));
    db.prepare('DELETE FROM executions WHERE workflow_id=?').run(Number(id));
  },

  markRun(id, iso) {
    db.prepare('UPDATE workflows SET last_run=? WHERE id=?').run(iso, Number(id));
  },

  createExecution(workflowId, trigger, input) {
    const r = db.prepare('INSERT INTO executions(workflow_id,status,trigger,started,input) VALUES(?,?,?,?,?)')
      .run(Number(workflowId), 'running', String(trigger || 'manual'), nowIso(), clip(JSON.stringify(input)));
    return Number(r.lastInsertRowid);
  },

  finishExecution(id, fields) {
    db.prepare('UPDATE executions SET status=?,finished=?,output=?,error=?,log=?,runs=? WHERE id=?').run(
      fields.status,
      nowIso(),
      fields.output === undefined ? null : clip(typeof fields.output === 'string' ? fields.output : JSON.stringify(fields.output)),
      fields.error || null,
      clip(String(fields.log || '')),
      fields.runs === undefined ? null : clip(JSON.stringify(fields.runs)),
      Number(id)
    );
  },

  getExecution(id) {
    const row = db.prepare('SELECT * FROM executions WHERE id=?').get(Number(id));
    if (!row) return null;
    const out = Object.assign({}, row);
    for (const key of ['input', 'output', 'runs']) {
      if (typeof out[key] === 'string') {
        try { out[key] = JSON.parse(out[key]); } catch { /* biarkan string */ }
      }
    }
    return out;
  },

  listExecutions({ workflowId, status, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (workflowId) { where.push('workflow_id=?'); args.push(Number(workflowId)); }
    if (status) { where.push('status=?'); args.push(String(status)); }
    const sql = `SELECT id,workflow_id,status,trigger,started,finished,error FROM executions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Math.min(Math.max(Number(limit) || 50, 1), 500));
  },

  pruneExecutions(keepPerWorkflow = 500) {
    const rows = db.prepare('SELECT id, workflow_id FROM executions ORDER BY id DESC').all();
    const seen = new Map();
    const drop = [];
    for (const r of rows) {
      const n = (seen.get(r.workflow_id) || 0) + 1;
      seen.set(r.workflow_id, n);
      if (n > keepPerWorkflow) drop.push(r.id);
    }
    for (const id of drop) db.prepare('DELETE FROM executions WHERE id=?').run(id);
    return drop.length;
  },
};

module.exports = store;

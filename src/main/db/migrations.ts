import type { Database } from 'better-sqlite3'

// Numbered migrations applied via PRAGMA user_version.
// Never edit an existing migration — append a new one.
const migrations: string[] = [
  // 1: initial schema
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 2,
    due_date TEXT,
    layout_json TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
  );

  CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    file_path TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_resources_task ON resources(task_id);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    work_min INTEGER NOT NULL,
    break_min INTEGER NOT NULL,
    work_seconds_done INTEGER NOT NULL DEFAULT 0,
    phases_completed INTEGER NOT NULL DEFAULT 0,
    ended_via TEXT
  );
  CREATE INDEX idx_sessions_task ON sessions(task_id);

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source_ref TEXT,
    ease REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL,
    suspended INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_questions_due ON questions(due_at) WHERE suspended = 0;

  CREATE TABLE review_log (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    reviewed_at TEXT NOT NULL,
    grade INTEGER NOT NULL,
    answer_given TEXT,
    ai_feedback TEXT
  );

  CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    claude_session_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    last_message_at TEXT
  );

  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    task_id TEXT,
    resource_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: question origin (generated vs extracted) + AI usage/cost tracking
  `
  ALTER TABLE questions ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated';

  CREATE TABLE usage_log (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    kind TEXT NOT NULL,                -- chat|generate|extract|grade
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_usage_task ON usage_log(task_id);
  CREATE INDEX idx_usage_created ON usage_log(created_at);
  `,
  // 3: private (no-AI) tasks
  `
  ALTER TABLE tasks ADD COLUMN ai_disabled INTEGER NOT NULL DEFAULT 0;
  `,
  // 4: drop the sessions→tasks FK. It made any task with a focus session
  // undeletable (no ON DELETE action), and we WANT session history to outlive
  // its task so activity stats keep the hours.
  `
  CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    work_min INTEGER NOT NULL,
    break_min INTEGER NOT NULL,
    work_seconds_done INTEGER NOT NULL DEFAULT 0,
    phases_completed INTEGER NOT NULL DEFAULT 0,
    ended_via TEXT
  );
  INSERT INTO sessions_new SELECT id, task_id, started_at, ended_at, work_min, break_min, work_seconds_done, phases_completed, ended_via FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_new RENAME TO sessions;
  CREATE INDEX idx_sessions_task2 ON sessions(task_id);
  `,
  // 5: multiple-choice questions (choices JSON array + 0-based correct index;
  // NULL choices = free response)
  `
  ALTER TABLE questions ADD COLUMN choices TEXT;
  ALTER TABLE questions ADD COLUMN correct_index INTEGER;
  `,
  // 6: parametrized jobs (cross-document question pipeline)
  `
  ALTER TABLE jobs ADD COLUMN params TEXT;
  `,
  // 7: coding tasks (chat becomes a coding agent: Fable 5 + command execution)
  `
  ALTER TABLE tasks ADD COLUMN coding INTEGER NOT NULL DEFAULT 0;
  `,
  // 8: quick-assistant history
  `
  CREATE TABLE assistant_log (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    reply TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 9: global to-dos (manual + auto-captured from notes "to-do:" lines)
  `
  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 2,
    due_date TEXT,
    task_id TEXT,
    source_file TEXT,
    link TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  `,
  // 10: per-workspace opt-in for agents READING that workspace's terminal
  // output. There is deliberately no "write" counterpart — agents have no
  // path to type into a terminal at all (see services/terminal.ts).
  `
  ALTER TABLE tasks ADD COLUMN terminal_ai_read INTEGER NOT NULL DEFAULT 0;
  `,
  // 11: scheduled agent runs — the app doing things WITHOUT being asked.
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    task_id TEXT,              -- null = the universal agent
    repeat TEXT NOT NULL,      -- 'once' | 'daily' | 'weekdays' | 'hourly'
    next_at TEXT NOT NULL,     -- ISO; when it should next fire
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_schedules_next ON schedules(next_at) WHERE enabled = 1;
  `,
  // 12: keep the tool trail with the reply it produced. It used to exist only
  // while the turn was running, so reopening a chat showed answers with no
  // record of what the agent actually did to get them.
  `
  ALTER TABLE chat_messages ADD COLUMN steps TEXT;   -- JSON array of status lines
  `,
  // 13: browsing history for the embedded panes. Without it the address bar
  // has nothing to complete against and there is no way back to a page you
  // closed. Private workspaces are never recorded (see services/history.ts).
  `
  CREATE TABLE history (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    task_id TEXT,
    visit_count INTEGER NOT NULL DEFAULT 1,
    last_visited_at TEXT NOT NULL
  );
  CREATE INDEX idx_history_recent ON history(last_visited_at DESC);
  `
]

/** Target schema version — used to decide whether a migration is pending. */
export const MIGRATION_COUNT = migrations.length

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

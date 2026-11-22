-- One optional reminder per note. Times are wall-clock in an IANA zone; next_fire_at is the
-- derived UTC instant of the next occurrence. Native OS requests are rebuilt from this table.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done')),
  next_fire_at INTEGER NULL,
  snoozed_until INTEGER NULL,
  last_fired_at INTEGER NULL,
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(status, next_fire_at);

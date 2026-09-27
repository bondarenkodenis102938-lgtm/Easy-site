CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  media_key TEXT,
  media_type TEXT,
  original_name TEXT,
  youtube_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at
ON posts(created_at DESC);
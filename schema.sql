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

CREATE TABLE IF NOT EXISTS youtube_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_youtube_links_created_at
ON youtube_links(created_at DESC);

CREATE TABLE IF NOT EXISTS kino_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kino_comments_created_at
ON kino_comments(created_at DESC);
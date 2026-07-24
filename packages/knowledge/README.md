# `@opendelegate/knowledge`

Device-local retrieval for ordinary, Obsidian-compatible Markdown.

- Markdown is canonical; the full-text and wiki-link indexes are disposable.
- Search returns bounded previews. Content enters an Agent context only through an
  explicit, total-character-budgeted open operation.
- Qualified Worker writes are atomic and immediately rebuild the index without a
  separate LLM curation loop.
- Credentials, raw transcripts, raw logs, temporary Task state, common facts,
  traversal, and symlink escapes are rejected.
- The package has no backup, synchronization, replication, migration, or network
  behavior.

`health()` is the only projection intended for Main. It returns only `ready` or
`not-ready`; filenames, titles, previews, links, note counts, index data, and
Markdown never cross the Device boundary.

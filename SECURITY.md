# Security & privacy

Backchannel is built to be small and honest about what it protects. This is the
plain-English threat model — what's guaranteed, and what isn't.

## What's protected

**Direct messages stay between their participants.** Every message is delivered
and shown only to the people in that conversation — the server checks membership
on every send, and you can't load a conversation you're not part of. Non-members
never receive a copy, live or in history.

**Messages are shown as text, never run as code.** All message content is
escaped before it's displayed, so a message can't inject scripts or do anything
on another person's machine. Channel content is never piped into anyone's shell
or agent — the only thing your machine ever sends the server is a small "I'm
building / I stopped" presence ping.

**Encryption at rest.** The entire database is encrypted on disk (SQLCipher /
AES-256). A stolen disk image or a leaked backup file is unreadable without the
key — the key lives only in the deploy environment.

**Sound fundamentals.** Tokens and recovery phrases are stored only as hashes,
never in the clear. All database queries are parameterized (no SQL injection).
The realtime connection requires authentication before any action, and sending
is rate-limited and size-capped. Uploads are restricted to images we host and
GIFs from a single allow-listed provider.

## What is *not* protected (be honest with yourself)

- **DMs are not end-to-end encrypted.** They're private from other members and
  encrypted at rest, but the server (and its operator) can technically read
  them. This is the same model as Slack, Discord, etc. — only tools like Signal
  are end-to-end. If a conversation must be readable by *no one but you two*,
  don't have it here.
- **Encryption at rest doesn't stop a live server breach** or the operator —
  the running server holds the key in order to function. It defends against a
  leaked *file/backup*, not against someone who has compromised the live host.
- **Metadata isn't hidden.** Who talks to whom, and when, is visible to the
  server even though message contents are access-controlled.

## Reporting

Found something? Email the maintainer rather than posting publicly, and give us
a chance to fix it first. Thank you.

# Security & privacy

Backchannel is small on purpose, and honest about what it protects. Here's the plain version.

## What's protected

**DMs stay between their members.** The server checks membership on every message, so non-members never receive a copy, live or in history. You can't open a conversation you're not in.

**Messages are shown, never run.** All message content is escaped before display, so nothing in a message can execute on another person's machine. Channel content is never piped into anyone's shell or agent. The only thing your machine sends the server is a small "building / stopped" ping.

**Encrypted at rest.** The entire database is encrypted on disk (SQLCipher / AES-256). A stolen disk image or leaked backup file is unreadable without the key, which lives only in the deploy environment.

**Solid basics.** Tokens and recovery phrases are stored only as hashes. All queries are parameterized (no SQL injection). The realtime connection requires auth before any action, and sending is rate-limited and size-capped. Uploads are limited to images we host and GIFs from one allow-listed provider.

## What's not protected

Be honest with yourself about these.

**DMs are not end-to-end encrypted.** They're private from other members and encrypted on disk, but the server (and its operator) can technically read them, same as Slack or Discord. If a conversation must be readable by no one but you two, don't have it here.

**At-rest encryption doesn't stop a live breach.** The running server holds the key in order to work, so it defends against a leaked file or backup, not against someone who has already compromised the host.

**Metadata is visible.** Who talks to whom, and when, is visible to the server even though message contents are access-controlled.

## Reporting

Found something? Email the maintainer instead of posting publicly, and give us a chance to fix it first. Thanks.

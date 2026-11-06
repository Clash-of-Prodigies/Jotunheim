# Challenge Place goal writer and replay logging

## Safe default

Challenge Place publishing and full Kahoot replay logging are both disabled unless explicitly enabled. A normal local start remains:

```bash
KAHOOT_DEV_TOKEN="choose-a-local-development-token" npm start
```

With publishing disabled, every calculated, publishable goal is classified `NOT_SENT` and written to the always-on exception report. No Challenge Place credentials are required and no Challenge Place connection is opened. With replay logging disabled, no raw per-question replay file is created.

Do not enable publishing against an active competition match. First use an explicitly authorized disposable fixture and authorized account.

## Runtime configuration

Operational settings now live in the repository-root `config.json`:

| Setting | Default | Purpose |
|---|---:|---|
| `publish_enabled` | `false` | Opens the Challenge Place transport and permits safe finalized goals when `true`. |
| `replay_logging` | `false` | Enables raw per-question Kahoot replay CSV files. |
| `rate_limit_ms` | `1000` | Minimum delay between global submission attempts. |
| `confirmation_timeout_ms` | `10000` | Wait for correlated `event-added` evidence before classifying a sent goal `UNCERTAIN`. |
| `session_finish_grace_ms` | `10000` | Bounded wait before session cleanup records queued or in-flight goals as outstanding. |
| `challenge_place_base_url` | Challenge Place API | Override only for an approved service or test adapter. |
| `challenge_place_language` | `en-us` | Namespace language field observed in the authorized capture. |
| `log_directory` | `.local/clash-relay` | Root for exception reports, intents, and optional replay files. |

The challenge link code is read from the repository-root `.env`, which is ignored by Git and created with owner-only permissions. Set it there without quotes or with matching single/double quotes:

```dotenv
CLASH_CP_CHALLENGE_LINK_CODE=authorized-disposable-challenge
```

Never place the Challenge Place token ID in `.env`, `config.json`, source code, or a command. When `publish_enabled` is `true`, startup asks for it interactively:

```bash
KAHOOT_DEV_TOKEN="local-relay-token" npm start
```

The prompt appears as `Challenge Place token ID:` and typed characters are not echoed. Publishing-enabled startup requires an interactive terminal and rejects an empty token. The service never includes it in console messages, configuration files, exception CSV files, replay files, or submission-intent files.

`KAHOOT_DEV_TOKEN` and optional `PORT` remain process environment variables. Invalid or unknown `config.json` settings stop startup before the Challenge Place connection is opened.

## Publication lifecycle

A finalized goal is keyed by Kahoot live-game ID plus question index. A single global worker preserves order within each match, rotates fairly between matches, and applies the configured global rate limit. Transmission requires the session to be explicitly marked safe immediately before the attempt.

Statuses are:

- `QUEUED`: waiting for a safe session, connectivity, and the global worker.
- `SENDING`: a durable intent was written and the outgoing attempt began.
- `CONFIRMED`: a correlated Challenge Place `event-added` broadcast established persistence.
- `UNCERTAIN`: the attempt may have succeeded, but correlatable confirmation was unavailable.
- `REJECTED`: the transport explicitly rejected the operation.
- `NOT_SENT`: no attempt was made or the session ended before it could begin.

A generic socket write, connection state, or score-change broadcast is not confirmation. An `UNCERTAIN` goal is never retried automatically. Late matching evidence may change it to `CONFIRMED` without another submission. One uncertain or rejected item does not block later work.

The real Socket.IO transport uses volatile emission so Socket.IO cannot buffer an unconfirmed goal across a disconnect. Goals waiting before disconnection stay queued and resume after reconnection; a disconnect during transmission produces `UNCERTAIN`.

## Evidence used for the protocol

The implementation is based on the authorized `challenge.place.har` capture and sends only fields present there:

- Socket.IO endpoint `https://api.challengeplace.com/socket.io/`, namespace `/challenge`.
- Namespace authentication fields `tokenId`, `linkCode`, `lang`, and `challengeLinkCode`.
- Operation `add-event` with a root `goal` and child `goalConceded` event.
- Root fields: match ID, scoring competitor ID, one credited player ID, value `1`, event time, and `comment: null`.
- Child fields: opponent competitor ID, value `1`, `players: null`.
- No Socket.IO acknowledgment ID was present on the captured `add-event` frame.
- Confirmation is correlated from the match-specific `event-added` broadcast using match, competitors, player, value, and exact event time.

Score-change broadcasts are intentionally ignored as confirmation.

## Exception and intent files

Outstanding goals are written atomically under:

- `exceptions/`: per-match/session/live-game CSV reports for `QUEUED`, `SENDING`, `UNCERTAIN`, `REJECTED`, and `NOT_SENT` records.
- `intents/`: minimal JSON evidence written before each outgoing attempt.

A verified confirmation removes that goal from the exception report and deletes its intent. A process restart converts an intent left in `SENDING` to `UNCERTAIN`, prints a prominent administrative-review message, and does not retry it. At session end, remaining queued work becomes `NOT_SENT`, in-flight work becomes `UNCERTAIN`, and the report is flushed before in-memory session cleanup.

Administrators must review and correct all outstanding records manually. There is no automatic reconciliation.

## Optional replay and offline comparison

Enable full replay logging only when needed by setting `replay_logging` to `true` in `config.json`, then start normally. Set it back to `false` after diagnostics are complete.

Replay files are written under `replays/`. They preserve every observed result, including unknown participants and zero-point responses, plus the original nickname, reaction time, correctness, and accumulated points when available. Accumulated points are diagnostic only and are never used by scoring.

Compare a replay with the original calculation offline:

```bash
npm run replay:kahoot -- /absolute/path/to/kahoot-replay-file.csv
```

The replay command only reads the CSV and runs the local scoring engine. It does not construct a Challenge Place transport or make external submissions.

## Live verification still required

This implementation has not created a real Challenge Place goal and does not claim a live acknowledgment was observed. Before operational use, verify all of the following with an authorized account and disposable fixture:

1. The current token and link code authenticate the `/challenge` namespace.
2. Challenge Place still accepts the captured `add-event` goal/goal-conceded shape.
3. The match-specific `event-added` broadcast retains the captured event structure and correlation fields.
4. The `time` field should be Kahoot elapsed milliseconds derived from the collector timestamps; the capture proves the request/confirmation field correspondence, not this cross-system time mapping.
5. Whether Challenge Place exposes a current explicit rejection event. The capture had no acknowledgment ID, so the production transport currently relies on confirmation or timeout rather than inventing a rejection signal.

Use the mock transport tests for all routine validation. Never run real goal tests on an active competition fixture.

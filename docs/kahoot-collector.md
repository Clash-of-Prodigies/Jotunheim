# Kahoot lobby collector

## Evidence and current limitations

A disposable live test on 2026-10-31 confirmed PIN detection and provisional lobby names, but no controller-backed identity reached the original WebSocket observer during the lobby or first question. A sanitized HAR from the same test confirmed that the host sends controller-backed `ANSWER` records through an XHR gameplay-events endpoint after answers are collected.

The evidence available for lobby signals is:

| Signal | Evidence | Timing confidence | Collector behavior |
|---|---|---|---|
| Session PIN | Confirmed in the live host lobby DOM | Available before play | Detected from narrowly scoped PIN elements or URL parameters |
| Lobby nickname | Confirmed in the live host lobby DOM for both test players | Available before play | Shown as **provisional** only; never sent as a verified join without a controller ID |
| Controller ID plus nickname | A previous capture contained `PARTICIPANT_JOINED` telemetry with both values | Presence confirmed, pre-question timing not confirmed | Sent only when both appear together in a structured WebSocket message |
| Answer event identity | A live HAR captured `ANSWER` records containing `nickname`, `controllerId`, `inGameBlockIndex`, and individual `answerData` scoring fields in POSTs to Kahoot's gameplay-events endpoint | Confirmed after answers; not available in the captured lobby period | Relays only the minimum identity and per-question scoring fields needed by Clash Relay |
| Completed question batch | The captured host request grouped the controller-backed `ANSWER` records for one `inGameBlockIndex` after answer collection | Confirmed for the captured disposable game | Treats that grouped host request as the authoritative participant snapshot for that question; malformed, incomplete, unknown, or conflicting sets remain publication-unsafe |
| Participant departure | Not confirmed in a current disposable lobby | Unknown | Sent only from an explicit structured leave/disconnect event |
| Live game ID | Confirmed in the gameplay-events request URL | Confirmed after the first captured answer batch | Attached to the existing session without copying the request body |
| Reliable session end | A live HAR captured `GAME_ENDED` on the gameplay-events endpoint | Confirmed at normal game completion | Sent only from the explicit structured event; navigation or refresh is not treated as an end |

The userscript does not infer controller IDs, turn provisional names into verified identities, change Kahoot requests, or send full Kahoot response/message bodies to Clash Relay. It observes only the minimum identity and lifecycle fields from the exact gameplay-events endpoint.

## In-memory question scoring

Collector version 0.5 sends one `QUESTION_RESULTS` event for each captured, completed answer batch. It includes the original nickname and, when Kahoot provides it, the accumulated score for optional diagnostic replay logs. Neither field participates in the canonical question hash or goal calculation. Clash Relay validates the live game, bound fixture, complete verified controller set, and each controller's fixture-team membership before finalizing a question. Replays with the same canonical SHA-256 hash are idempotent; a different payload for an already finalized question is a conflict and makes publication unsafe without replacing the first result.

Each team's question value is the arithmetic mean of its players' individual Kahoot points. A goal requires the higher mean to exceed the lower mean by **strictly more than 2%**. Exactly 2%, equal means, and two zero means are no-goal results. The goal scorer is the highest-point player on the scoring team; a top-player tie leaves scorer attribution unresolved while retaining the team goal.

All scoring state is intentionally held in memory and is cleared on `SESSION_ENDED` or process restart. It is never written to SQLite. The scoring engine does not write externally; when explicitly enabled, the separate Challenge Place writer accepts only finalized, publication-safe goals.

The grouped-answer completeness rule is based on the currently captured Kahoot host format. Validate it once more in a disposable live game before relying on it operationally, especially if Kahoot changes its request batching. Challenge Place publishing and replay configuration are documented in `docs/challenge-place-writer.md`.

## Install and configure

1. Start Clash Relay from WSL:

   ```bash
   KAHOOT_DEV_TOKEN="choose-a-development-token" npm start
   ```

2. From Windows, verify `http://127.0.0.1:3000/health` is reachable. WSL normally forwards localhost automatically. Do not bind Fastify to a public interface.
3. Install Tampermonkey in the browser used to host Kahoot.
4. Create a new userscript and paste the contents of `userscripts/clash-relay-kahoot.user.js`.
5. Use Tampermonkey's **Clash Relay: set development token** command. The token is stored in Tampermonkey storage and is never injected into the Kahoot page or diagnostic messages.
6. If necessary, use **Clash Relay: set local API URL**. Only `localhost` and `127.0.0.1` HTTP URLs are accepted.

The panel starts collapsed to reduce projector exposure. Expanding it shows no controller or player database IDs. DOM-only names are explicitly labelled provisional.

## Manual disposable-lobby verification

1. Sign in to Kahoot and host a disposable game in the browser containing the userscript.
2. Open the Clash Relay panel and confirm the PIN matches the host lobby.
3. Join from a separate device with one registered player's approved name or nickname.
4. Before starting the first question, check whether:
   - the name appears under provisional lobby names;
   - the verified participant count increases;
   - a structured join with a controller ID was detected.
   If verified identities remain at zero in the lobby, answer the first disposable question and check again; current live evidence confirms controller-backed `ANSWER` events at that point.
5. If the name remains provisional, record that controller IDs are not available pregame. Do not treat the player as verified yet.
6. Join with a registered player from a second team. If both controller-backed joins are visible and a scheduled fixture is eligible, confirm the fixture resolves.
7. Repeat one join/reconnect and confirm the participant count does not duplicate.
8. Remove or disconnect a participant and observe whether Kahoot emits an explicit departure.
9. End the disposable game normally and observe whether an explicit end signal is available.
10. Confirm Kahoot remains playable throughout and that no Challenge Place write or goal action occurred.

For signal-timing diagnosis, use the browser's Network panel to compare the lobby period with the first-question period. Inspect only event names and the minimum fields needed to establish timing; do not copy authentication headers, cookies, complete message bodies, or unrelated traffic into diagnostics.

## Safety fallback

If Kahoot exposes lobby names but not controller IDs before play, the panel remains useful for provisional awareness while Clash Relay stays in `WAITING_FOR_TEAMS`. Verified joins can begin later if structured messages expose real controller IDs. This delays automatic binding rather than risking an incorrect identity or fixture claim.

Question batches that are incomplete, contain an unknown controller, include a third-team player, disagree with a finalized hash, or belong to another live game remain visible as scoring safety failures. They do not alter finalized question totals or silently exclude a participant.

## Remaining blockers

- A future capture beginning before participants join is still required to determine whether controller-backed identity is available before the first answer. Participant departures also remain unconfirmed.
- Collector completeness should be reconfirmed if Kahoot changes the gameplay-events request format or batching behavior.

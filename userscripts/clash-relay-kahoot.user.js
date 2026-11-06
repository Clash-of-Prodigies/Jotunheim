// ==UserScript==
// @name         Clash Relay — Kahoot Lobby Collector
// @namespace    https://github.com/Clash-of-Prodigies/Jotunheim
// @version      0.5.0
// @description  Relays verified Kahoot host lobby events to the local Clash Relay service.
// @match        https://create.kahoot.it/*
// @match        https://play.kahoot.it/*
// @match        https://kahoot.it/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
    "use strict";
    const COLLECTOR_VERSION = "0.5.0";

    const BRIDGE_SOURCE = "clash-relay-kahoot-page-v1";
    const DEFAULT_API_URL = "http://127.0.0.1:3000";
    const POLL_INTERVAL_MS = 3_000;
    const MAX_MESSAGE_LENGTH = 512_000;
    const pageWindow = typeof unsafeWindow === "object" ? unsafeWindow : window;

    const state = {
        apiUrl: String(GM_getValue("clashRelayApiUrl", DEFAULT_API_URL)).replace(/\/$/, ""),
        token: String(GM_getValue("clashRelayDevelopmentToken", "")),
        pin: null,
        sessionId: null,
        liveGameId: null,
        startedAt: null,
        connection: "Waiting for a Kahoot session",
        status: null,
        provisionalNames: new Set(),
        sentParticipants: new Map(),
        pendingSignals: [],
        panelCollapsed: Boolean(GM_getValue("clashRelayPanelCollapsed", true)),
        observer: "Installing",
        observedGameplayBatches: 0,
    };

    let panel = null;
    let panelFields = null;
    let pollTimer = null;
    let signalQueue = Promise.resolve();

    GM_registerMenuCommand("Clash Relay: set development token", () => {
        const token = prompt("Development token used by the local Clash Relay server:", "");
        if (token === null) return;
        state.token = token.trim();
        GM_setValue("clashRelayDevelopmentToken", state.token);
        state.connection = state.token.length === 0 ? "Token not configured" : "Token saved";
        renderPanel();
        if (state.sessionId !== null) void startRelaySession();
    });

    GM_registerMenuCommand("Clash Relay: set local API URL", () => {
        const value = prompt("Local Clash Relay URL:", state.apiUrl);
        if (value === null || value.trim().length === 0) return;
        const candidate = value.trim().replace(/\/$/, "");
        if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(candidate)) {
            alert("For this development collector, use a localhost or 127.0.0.1 HTTP URL.");
            return;
        }
        state.apiUrl = candidate;
        GM_setValue("clashRelayApiUrl", candidate);
        state.connection = "API URL saved";
        renderPanel();
    });

    function request(method, path, body) {
        return new Promise((resolve, reject) => {
            if (state.token.length === 0) {
                reject(new Error("Development token is not configured."));
                return;
            }
            GM_xmlhttpRequest({
                method,
                url: `${state.apiUrl}${path}`,
                headers: {
                    Authorization: `Bearer ${state.token}`,
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                data: body === undefined ? undefined : JSON.stringify(body),
                timeout: 5_000,
                onload(response) {
                    let parsed = null;
                    try {
                        parsed = response.responseText.length === 0
                            ? null
                            : JSON.parse(response.responseText);
                    } catch {
                        reject(new Error(`Clash Relay returned invalid JSON (${response.status}).`));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(parsed?.error ?? `Clash Relay request failed (${response.status}).`));
                        return;
                    }
                    resolve(parsed);
                },
                ontimeout() { reject(new Error("Clash Relay request timed out.")); },
                onerror() { reject(new Error("Clash Relay is unreachable on localhost.")); },
            });
        });
    }

    async function sendEvent(event) {
        try {
            const response = await request("POST", "/api/kahoot/events", event);
            if (response !== null && response.ended !== true) state.status = response;
            state.connection = "Connected";
            renderPanel();
            return true;
        } catch (error) {
            state.connection = error instanceof Error ? error.message : "Relay request failed";
            renderPanel();
            return false;
        }
    }

    async function refreshStatus() {
        if (state.sessionId === null || state.token.length === 0) return;
        try {
            state.status = await request(
                "GET",
                `/api/kahoot/sessions/${encodeURIComponent(state.sessionId)}`,
            );
            state.connection = "Connected";
        } catch (error) {
            state.connection = error instanceof Error ? error.message : "Status refresh failed";
        }
        renderPanel();
    }

    async function startRelaySession() {
        if (state.sessionId === null || state.startedAt === null) return;
        const event = {
            type: "SESSION_STARTED",
            sessionId: state.sessionId,
            occurredAt: state.startedAt,
            ...(state.liveGameId === null ? {} : { liveGameId: state.liveGameId }),
        };
        if (await sendEvent(event)) {
            const pending = state.pendingSignals.splice(0);
            for (const signal of pending) await handleReliableSignal(signal);
            if (pollTimer === null) {
                pollTimer = window.setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
            }
        }
    }

    function setSessionPin(pin) {
        if (!/^\d{4,10}$/.test(pin)) return;
        if (state.sessionId === pin) return;
        state.pin = pin;
        state.sessionId = pin;
        state.startedAt = new Date().toISOString();
        state.status = null;
        state.sentParticipants.clear();
        state.connection = state.token.length === 0
            ? "Session found; configure the development token"
            : "Session found; connecting";
        renderPanel();
        void startRelaySession();
    }

    async function handleReliableSignal(signal) {
        if (signal.kind === "OBSERVER_ACTIVITY") {
            state.observedGameplayBatches += 1;
            state.observer = `XHR active (${state.observedGameplayBatches} batches)`;
            renderPanel();
            return;
        }
        if (signal.kind === "SESSION_METADATA") {
            if (typeof signal.pin === "string") setSessionPin(signal.pin);
            if (
                typeof signal.liveGameId === "string"
                && signal.liveGameId.length > 0
                && signal.liveGameId !== state.liveGameId
            ) {
                state.liveGameId = signal.liveGameId;
                if (state.sessionId !== null) await startRelaySession();
            }
            return;
        }
        if (state.sessionId === null) {
            state.pendingSignals.push(signal);
            return;
        }
        if (signal.kind === "QUESTION_RESULTS") {
            await sendEvent({
                type: "QUESTION_RESULTS",
                sessionId: state.sessionId,
                liveGameId: signal.liveGameId,
                questionIndex: signal.questionIndex,
                complete: signal.complete,
                participantSnapshotControllerIds: signal.participantSnapshotControllerIds,
                results: signal.results,
                occurredAt: signal.occurredAt,
            });
            return;
        }
        if (signal.kind === "PARTICIPANT_JOINED") {
            if (signal.nickname === state.pin) return;
            const existing = state.sentParticipants.get(signal.controllerId);
            if (existing === signal.nickname) return;
            const sent = await sendEvent({
                type: "PARTICIPANT_JOINED",
                sessionId: state.sessionId,
                controllerId: signal.controllerId,
                nickname: signal.nickname,
                occurredAt: signal.occurredAt,
            });
            if (sent) state.sentParticipants.set(signal.controllerId, signal.nickname);
            return;
        }
        if (signal.kind === "PARTICIPANT_LEFT") {
            await sendEvent({
                type: "PARTICIPANT_LEFT",
                sessionId: state.sessionId,
                controllerId: signal.controllerId,
                occurredAt: signal.occurredAt,
            });
            state.sentParticipants.delete(signal.controllerId);
            return;
        }
        if (signal.kind === "SESSION_ENDED") {
            await sendEvent({
                type: "SESSION_ENDED",
                sessionId: state.sessionId,
                occurredAt: signal.occurredAt,
            });
            state.connection = "Session ended";
            state.status = null;
            state.sessionId = null;
            state.pin = null;
            state.liveGameId = null;
            state.startedAt = null;
            state.sentParticipants.clear();
            if (pollTimer !== null) window.clearInterval(pollTimer);
            pollTimer = null;
            renderPanel();
        }
    }

    function detectPinFromHostDom() {
        const selectors = [
            '[data-functional-selector="game-pin"]',
            '[data-functional-selector*="game-pin"]',
            '[data-testid="game-pin"]',
            '[data-testid*="game-pin"]',
            '[class*="game-pin"]',
            '[class*="GamePin"]',
        ];
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                const match = (node.textContent ?? "").replace(/\s/g, "").match(/\d{4,10}/);
                if (match !== null) {
                    setSessionPin(match[0]);
                    return;
                }
            }
        }
        const url = new URL(location.href);
        for (const key of ["pin", "gamePin", "gameId"]) {
            const value = url.searchParams.get(key);
            if (value !== null && /^\d{4,10}$/.test(value)) {
                setSessionPin(value);
                return;
            }
        }
    }

    function collectProvisionalNames() {
        const names = new Set();
        const selectors = [
            '[data-functional-selector="player-name"]',
            '[data-functional-selector^="player-name-"]',
            '[data-functional-selector*="participant-name"]',
            '[data-testid*="player-name"]',
            '[data-testid*="participant-name"]',
        ];
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                const name = (node.textContent ?? "").trim().replace(/\s+/g, " ");
                if (
                    name.length > 0
                    && name.length <= 200
                    && name !== state.pin
                ) names.add(name);
            }
        }
        const changed = names.size !== state.provisionalNames.size
            || [...names].some((name) => !state.provisionalNames.has(name));
        if (changed) {
            state.provisionalNames = names;
            renderPanel();
        }
    }

    function observeHostDom() {
        const observer = new MutationObserver(() => {
            detectPinFromHostDom();
            collectProvisionalNames();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        detectPinFromHostDom();
        collectProvisionalNames();
    }

    function createPanel() {
        if (panel !== null || document.body === null) return;
        panel = document.createElement("aside");
        panel.id = "clash-relay-status-panel";
        panel.style.cssText = [
            "position:fixed", "right:12px", "bottom:12px", "z-index:2147483647",
            "width:300px", "max-height:70vh", "overflow:auto", "padding:10px",
            "border:1px solid rgba(255,255,255,.25)", "border-radius:8px",
            "background:rgba(20,22,28,.94)", "color:#fff", "font:12px/1.4 system-ui,sans-serif",
            "box-shadow:0 4px 20px rgba(0,0,0,.3)",
        ].join(";");
        panel.innerHTML = `
            <button type="button" data-role="toggle" style="float:right;background:none;border:0;color:#fff;cursor:pointer;font-weight:700"></button>
            <strong>Clash Relay</strong>
            <div data-role="body" style="clear:both;margin-top:8px">
                <div><b>Collector:</b> <span data-field="collector"></span></div>
                <div><b>Observer:</b> <span data-field="observer"></span></div>
                <div><b>PIN:</b> <span data-field="pin"></span></div>
                <div><b>Relay:</b> <span data-field="connection"></span></div>
                <div><b>Status:</b> <span data-field="status"></span></div>
                <div><b>Verified:</b> <span data-field="verified"></span></div>
                <div><b>Provisional lobby names:</b> <span data-field="provisional"></span></div>
                <div><b>Flagged:</b> <span data-field="flagged"></span></div>
                <div><b>Teams:</b> <span data-field="teams"></span></div>
                <div><b>Fixture:</b> <span data-field="fixture"></span></div>
                <div><b>Ready to publish:</b> <span data-field="ready"></span></div>
                <div><b>Questions finalized:</b> <span data-field="questions"></span></div>
                <div><b>Score:</b> <span data-field="score"></span></div>
                <div><b>Scoring safe:</b> <span data-field="scoring-safe"></span></div>
            </div>`;
        document.body.append(panel);
        const body = panel.querySelector('[data-role="body"]');
        const toggle = panel.querySelector('[data-role="toggle"]');
        panelFields = Object.fromEntries(
            [...panel.querySelectorAll("[data-field]")].map((element) => [
                element.getAttribute("data-field"),
                element,
            ]),
        );
        toggle.addEventListener("click", () => {
            state.panelCollapsed = !state.panelCollapsed;
            GM_setValue("clashRelayPanelCollapsed", state.panelCollapsed);
            body.hidden = state.panelCollapsed;
            toggle.textContent = state.panelCollapsed ? "Show" : "Hide";
        });
        body.hidden = state.panelCollapsed;
        toggle.textContent = state.panelCollapsed ? "Show" : "Hide";
        renderPanel();
    }

    function renderPanel() {
        if (panelFields === null) return;
        const status = state.status;
        panelFields.collector.textContent = COLLECTOR_VERSION;
        panelFields.observer.textContent = state.observer;
        panelFields.pin.textContent = state.pin ?? "Not detected";
        panelFields.connection.textContent = state.connection;
        panelFields.status.textContent = status?.status ?? "—";
        panelFields.verified.textContent = String(status?.verifiedParticipantCount ?? 0);
        panelFields.provisional.textContent = state.provisionalNames.size === 0
            ? "None observed"
            : [...state.provisionalNames].sort().join(", ");
        panelFields.flagged.textContent = status?.flaggedIdentities?.length > 0
            ? status.flaggedIdentities.map((item) => `${item.nickname} (${item.reason})`).join(", ")
            : "None";
        panelFields.teams.textContent = status?.detectedTeamIds?.length > 0
            ? status.detectedTeamIds.join(", ")
            : "None";
        panelFields.fixture.textContent = status?.confirmedMatchId ?? "Unresolved";
        panelFields.ready.textContent = status?.readyToPublish === true ? "Yes" : "No";
        panelFields.questions.textContent = String(status?.finalizedQuestionCount ?? 0);
        panelFields.score.textContent = status === null
            ? "0 - 0"
            : `${status.homeGoals ?? 0} - ${status.awayGoals ?? 0}`;
        panelFields["scoring-safe"].textContent = status?.scoringSafe === false ? "No" : "Yes";
    }

    function installPageObservers() {
        const OriginalWebSocket = pageWindow.WebSocket;
        if (pageWindow.__clashRelayEventObserver) return;
        Object.defineProperty(pageWindow, "__clashRelayEventObserver", {
            value: true,
            configurable: false,
            enumerable: false,
        });

        function post(signal) {
            pageWindow.postMessage({ source: BRIDGE_SOURCE, signal }, location.origin);
        }

        function stringValue(object, keys) {
            for (const key of keys) {
                const value = object?.[key];
                if ((typeof value === "string" || typeof value === "number") && String(value).length > 0) {
                    return String(value);
                }
            }
            return null;
        }

        function findValue(value, keys, depth = 0) {
            if (depth > 5 || value === null || typeof value !== "object") return null;
            const direct = stringValue(value, keys);
            if (direct !== null) return direct;
            const children = Array.isArray(value) ? value.slice(0, 100) : Object.values(value).slice(0, 100);
            for (const child of children) {
                const found = findValue(child, keys, depth + 1);
                if (found !== null) return found;
            }
            return null;
        }

        function inspectValue(value, depth = 0) {
            if (depth > 5) return;
            if (typeof value === "string") {
                const trimmed = value.trim();
                if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= MAX_MESSAGE_LENGTH) {
                    try { inspectValue(JSON.parse(trimmed), depth + 1); } catch { /* Non-JSON frame. */ }
                }
                return;
            }
            if (value === null || typeof value !== "object") return;

            const label = ["type", "event", "eventName", "name", "topic", "channel"]
                .map((key) => value[key])
                .filter((entry) => typeof entry === "string")
                .join(" ")
                .toUpperCase();
            const controllerId = findValue(value, ["controllerId", "controller_id", "participantId"]);
            const nickname = findValue(value, ["nickname", "playerNickname"]);
            const liveGameId = findValue(value, ["liveGameId", "live_game_id"]);
            const pin = findValue(value, ["gamePin", "game_pin", "sessionPin"]);
            const occurredAt = new Date().toISOString();

            if (pin !== null || liveGameId !== null) {
                post({ kind: "SESSION_METADATA", pin, liveGameId, occurredAt });
            }
            if (/PARTICIPANT.{0,10}(JOIN|ADD)|PLAYER.{0,10}(JOIN|ADD)/.test(label)) {
                if (controllerId !== null && nickname !== null) {
                    post({ kind: "PARTICIPANT_JOINED", controllerId, nickname, occurredAt });
                }
            } else if (/PARTICIPANT.{0,10}(LEFT|LEAVE|REMOVE|DISCONNECT)|PLAYER.{0,10}(LEFT|LEAVE|REMOVE|DISCONNECT)/.test(label)) {
                if (controllerId !== null) {
                    post({ kind: "PARTICIPANT_LEFT", controllerId, occurredAt });
                }
            } else if (/SESSION.{0,10}(ENDED|CLOSED)|GAME.{0,10}(ENDED|OVER)/.test(label)) {
                post({ kind: "SESSION_ENDED", occurredAt });
            }

            const children = Array.isArray(value) ? value.slice(0, 100) : Object.values(value).slice(0, 100);
            for (const child of children) inspectValue(child, depth + 1);
        }

        function inspectMessage(data) {
            if (typeof data === "string") {
                if (data.length <= MAX_MESSAGE_LENGTH) inspectValue(data);
                return;
            }
            if (data instanceof pageWindow.ArrayBuffer && data.byteLength <= MAX_MESSAGE_LENGTH) {
                try { inspectValue(new pageWindow.TextDecoder().decode(data)); } catch { /* Ignore binary frames. */ }
            }
        }

        function inspectGameplayRequest(rawUrl, body) {
            try {
                const url = new URL(String(rawUrl), location.href);
                const match = url.pathname.match(
                    /^\/gameplay-services\/v1\/game\/([^/]+)\/events$/,
                );
                if (url.hostname !== "apis.kahoot.it" || match === null) return;
                if (typeof body !== "string" || body.length > MAX_MESSAGE_LENGTH) return;
                const payload = JSON.parse(body);
                if (!Array.isArray(payload?.events)) return;
                post({ kind: "OBSERVER_ACTIVITY" });

                const liveGameId = decodeURIComponent(match[1]);
                const occurredAt = new Date().toISOString();
                post({ kind: "SESSION_METADATA", liveGameId, occurredAt });

                const completedAnswers = [];
                for (const event of payload.events) {
                    if (event === null || typeof event !== "object") continue;
                    const type = typeof event.type === "string" ? event.type.toUpperCase() : "";
                    const controllerId = stringValue(event, [
                        "controllerId", "controller_id", "participantId",
                    ]);
                    const nickname = stringValue(event, ["nickname", "playerNickname"]);
                    const isHostPseudoPlayer = nickname !== null && nickname === state.pin;
                    if (
                        (type === "ANSWER" || type === "PARTICIPANT_JOINED")
                        && controllerId !== null
                        && nickname !== null
                        && !isHostPseudoPlayer
                    ) {
                        post({ kind: "PARTICIPANT_JOINED", controllerId, nickname, occurredAt });
                        if (type === "ANSWER") {
                            const questionIndex = event.inGameBlockIndex;
                            const rawPoints = event.answerData?.points;
                            const timedOut = event.answerData?.type === "timeout";
                            const points = Number.isFinite(rawPoints) ? rawPoints : timedOut ? 0 : null;
                            if (Number.isInteger(questionIndex) && questionIndex >= 0 && points !== null) {
                                completedAnswers.push({
                                    controllerId,
                                    nickname,
                                    questionIndex,
                                    points,
                                    ...(Number.isFinite(event.answerData?.reactionTime)
                                        ? { reactionTimeMs: event.answerData.reactionTime }
                                        : {}),
                                    ...(typeof event.answerData?.isCorrect === "boolean"
                                        ? { isCorrect: event.answerData.isCorrect }
                                        : {}),
                                    ...(Number.isFinite(event.answerData?.accumulatedPoints)
                                        ? { accumulatedPoints: event.answerData.accumulatedPoints }
                                        : {}),
                                });
                            }
                        }
                    } else if (
                        ["PARTICIPANT_LEFT", "PARTICIPANT_DISCONNECTED"].includes(type)
                        && controllerId !== null
                    ) {
                        post({ kind: "PARTICIPANT_LEFT", controllerId, occurredAt });
                    } else if (type === "GAME_ENDED" || type === "SESSION_ENDED") {
                        post({ kind: "SESSION_ENDED", occurredAt });
                    }
                }

                const questionIndexes = new Set(completedAnswers.map(
                    (answer) => answer.questionIndex,
                ));
                if (completedAnswers.length > 0 && questionIndexes.size === 1) {
                    const questionIndex = completedAnswers[0]?.questionIndex;
                    if (questionIndex !== undefined) {
                        post({
                            kind: "QUESTION_RESULTS",
                            liveGameId,
                            questionIndex,
                            complete: true,
                            participantSnapshotControllerIds: completedAnswers.map(
                                (answer) => answer.controllerId,
                            ),
                            results: completedAnswers.map(({ questionIndex: _, ...answer }) => answer),
                            occurredAt,
                        });
                    }
                }
            } catch {
                // Observation must never interfere with Kahoot's request.
            }
        }

        const XhrPrototype = pageWindow.XMLHttpRequest?.prototype;
        if (XhrPrototype !== undefined) {
            const originalOpen = XhrPrototype.open;
            const originalSend = XhrPrototype.send;
            const requestUrls = new WeakMap();
            XhrPrototype.open = function (method, url, ...rest) {
                requestUrls.set(this, { method: String(method).toUpperCase(), url: String(url) });
                return Reflect.apply(originalOpen, this, [method, url, ...rest]);
            };
            XhrPrototype.send = function (body) {
                const request = requestUrls.get(this);
                if (request?.method === "POST") inspectGameplayRequest(request.url, body);
                return Reflect.apply(originalSend, this, [body]);
            };
            state.observer = "XHR armed (0 batches)";
        }

        const originalFetch = pageWindow.fetch;
        if (typeof originalFetch === "function") {
            pageWindow.fetch = function (input, init) {
                const rawUrl = typeof input === "string" || input instanceof pageWindow.URL
                    ? input
                    : input?.url;
                if (init?.method?.toUpperCase() === "POST") {
                    inspectGameplayRequest(rawUrl, init.body);
                }
                return Reflect.apply(originalFetch, this, [input, init]);
            };
        }

        if (typeof OriginalWebSocket === "function") {
            pageWindow.WebSocket = new Proxy(OriginalWebSocket, {
                construct(target, argumentsList, newTarget) {
                    const socket = Reflect.construct(target, argumentsList, newTarget);
                    socket.addEventListener("message", (event) => inspectMessage(event.data));
                    return socket;
                },
            });
        }
        if (XhrPrototype === undefined) state.observer = "XHR unavailable";
    }

    window.addEventListener("message", (event) => {
        if (
            (event.source !== pageWindow && event.source !== window)
            || event.origin !== location.origin
            || event.data?.source !== BRIDGE_SOURCE
            || typeof event.data.signal !== "object"
            || event.data.signal === null
        ) return;
        signalQueue = signalQueue
            .then(() => handleReliableSignal(event.data.signal))
            .catch((error) => {
                state.connection = error instanceof Error ? error.message : "Signal processing failed";
                renderPanel();
            });
    });

    installPageObservers();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            createPanel();
            observeHostDom();
        }, { once: true });
    } else {
        createPanel();
        observeHostDom();
    }
})();

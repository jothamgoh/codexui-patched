# Voice commands: what success looks like

Voice commands come from two places: the iPhone Shortcut on the Action button,
and the mic in the app's notifications panel. Both use the same router
(`src/server/voice/`). This page defines the expected result of each kind of
command and the targets that the tests and evals hold the router to.

## Rules that never change

- **Only a sure command goes out without a tap.** With "Auto-send voice
  commands" on (the default), a send or new chat goes out by itself only when
  the router is sure of the chat or project (see Auto-send below), the message
  is there, and the user did not ask for a draft. Everything else lands with
  the message typed in, or on a chooser where one tap sends it. A Shortcut
  built for `?confirm=shortcut` keeps its old flow and never auto-sends.
- **Every auto-send can be cancelled until it goes.** With an undo window the
  countdown has Cancel; with none, the send is immediate and the turn can be
  stopped in the chat as usual.
- **No guessing between chats.** When the words fit more than one chat, the
  user gets a chooser. Opening the wrong chat or typing a message into it is the
  worst failure.
- **Every landing has a way back.** A chat, a chooser, the panel and the new-chat
  page each close or go back to where the user was.
- **The transcript stays private.** Logs record the path (`jev`, `jev+llm`,
  `llm:<provider>` or `none`), the outcome and the timings. They never record
  the words, chat titles or the message.

## Journeys

| You say | You land on | You see |
| --- | --- | --- |
| Open one chat ("open the stripe webhook chat") | That chat | The chat |
| A list ("what's running", "unread", "what needs me", "recent chats") | The notifications panel, on that section | The section highlighted. "Heard: …" above it. "Nothing running ✓" when the section is empty |
| A list with exactly one chat in it | That chat | The chat |
| Send ("tell the stripe chat to deploy it", or a long ramble addressed to a chat) | That chat | Sure: "Sent ✓", or the countdown with Cancel and Edit. Not sure, a draft, or auto-send off: the message typed in and a "From voice" banner |
| New chat ("new chat in hr-ai with codex, fix the build") | The new chat once started | Sure: "Started ✓", or the countdown. Unclear project: the new-chat page with one-tap project chips |
| A task or question on its own ("find me the best hotels in Johor Bahru") | A new chat in the default project | The request as its message, started like any sure new chat. No default project: the project chips |
| A close call ("open the stripe one" with three Stripe chats) | The chooser | The matching chats as panel rows, the best match first and labelled. With a message, a tap sends it there ("Edit first" types it in instead) |
| Several requests at once ("tell X to deploy and open Y") | The Steps chooser | Sure sends and new chats ran by themselves and show ✓; every other row does its step in one tap |
| A draft ("draft a reply to the stripe chat saying yes", "… don't send it", "just type …") | That chat | The message typed in. Never sent without a tap |
| Not understood or out of scope ("open spotify", "stop the export job") | The notifications panel | "Didn't catch that · Heard: …" and a mic ready to try again |
| Failure (no network, transcription failed, router down) | Where you were | An inline error with a retry. The Shortcut gets a "Voice command didn't work" notification |

Requests outside scope may also land on a chooser of the chats they name ("what
did the stripe chat say"). They must never open a chat or prepare a send.

## Auto-send

### When it sends without a tap

`src/server/voice/voiceAutoSend.ts` decides, after routing:

| Result | Sends by itself when |
| --- | --- |
| Send ready | The chat was sure through Jev's own clear win, or two signals agreeing: Jev and the spoken words, the LLM and Jev's top two, or the LLM and the spoken words. The LLM alone is not enough. The message is not empty |
| New chat | The project was named (by rule, or Jev clearly), named by the LLM and in the words, or not named at all with a default project set. The message is not empty |
| Steps | Each step on its own, by the rows above. Opening a chat or a list always waits for a tap |
| Chooser, list, open, "didn't catch that" | Never |

A draft request ("draft …", "don't send", "just type …", "I'll send it myself",
or the LLM's `draft_only`) never sends, and the setting turns all of it off.

### What each surface shows

| Surface | Undo window | No undo window (default) |
| --- | --- | --- |
| Shortcut notification | "Sending to <chat> in 5 s · tap to cancel", then "Sent ✓ · <chat>" under the same tag | "Sent ✓ · <chat>" with the message |
| New chat notification | "Starting new <project> chat in 5 s · tap to cancel", then "Started ✓ · new <project> chat" | "Started ✓ · new <project> chat" |
| Steps notification | "Send to A · start a new B chat in 5 s" · "1 step needs you", then "Sent to A ✓ · started new B chat ✓" | The second line only |
| A failure | "Couldn't send to <chat>": opens the chat with the message typed in | Same |
| In the app (panel mic or a tapped notification) | The countdown above the composer: Cancel (main control), Edit (cancel, type it in, focus) | "Sent ✓" above the composer |
| A tap in a chooser | A toast: "Sending to <chat> in 3 s" with Undo | A toast: "Sent ✓ · <chat>" with View |

The window runs on the server, so the send goes out with the phone locked or
the app closed. Pending sends live in memory only: **if the service restarts
during the window they are dropped, not sent**, and the log says
`auto_send=dropped count=N reason=shutdown`. Logs record
`auto_send=scheduled|cancelled|sent|failed` with timings, never the words.

### Settings

In the notifications panel, Settings tab, saved on the server so the Shortcut
follows them: "Auto-send voice commands" (on), "Undo window" (send immediately,
3, 5 or 10 s; default send immediately) and "Default project for voice new
chats". The default project falls back to `CODEXUI_VOICE_DEFAULT_PROJECT` (an
absolute folder). With neither, a new chat that names no project asks which
one. A project the user names always wins; a name that matches no project gets
the chooser, never the default.

## Routing targets

Measured with `scripts/voice-eval.mjs` (fictional chats, real Jev and LLM) and
`scripts/voice-live-test.mjs` (the running instance and its real chats).

| Measure | Target |
| --- | --- |
| Correct action on clear, short phrases | ≥ 95% |
| Correct action on long, rambling or slipped dictation | ≥ 85% |
| Compound requests split into the right steps | ≥ 85% |
| A chat opened or a send prepared for the wrong chat | 0 |
| Commands that are not right | All of them land on a chooser or "didn't catch that" |
| Out of scope requests that open a chat or prepare a send | 0 |
| **Auto-sends to the wrong chat or project** | **0** |
| **Auto-sends that cannot be cancelled within the window** | **0** |
| Chat commands (lists, opens, sends, fragments, unsupported actions) started as a new chat | 0 |
| Tasks and questions on their own that start a new chat | ≥ 90% |

`scripts/voice-eval.mjs` reports would-auto-send and wrong-chat auto-sends per
journey (journeys 8 and 9 are tasks and things that are not new chats).
`scripts/voice-live-test.mjs` only makes dry runs (`{"text", "dryRun": true}`):
the server routes and reports `meta.autoSend` but schedules nothing. Its
`--local` mode routes the live chats with the checkout's own router, to measure
a change before the service runs it.

## Latency targets

Server time, from the words arriving to the result. Transcription is not
included.

| Path | Target p95 |
| --- | --- |
| Jev only (`jev`), about 0.25 s for each Jev call | < 0.8 s |
| LLM fallback (`llm:*`, `jev+llm`), about 1.5 to 2 s of Haiku | < 3 s |
| LLM gives up and the user sees "didn't catch that" | 6 s |

## In-app mic (notifications panel)

- A small mic in the panel header whenever the panel is open, on phone and
  desktop. On a phone, every control has a tap target of at least 44 px.
- Tap to start and tap to stop. While recording, the mic turns into a red stop
  button with a pulsing level ring, and the panel says "Listening… tap to stop".
- After stopping, the panel shows "Working…" until the result arrives, then
  goes to the landing in the table above. No notification is sent.
- Errors show inline under the header and leave the mic ready to retry:
  microphone access denied (with how to allow it), nothing recorded, nothing
  heard, and the router failing.
- The iOS home-screen app asks for the microphone only on the first tap.
  It never asks when the panel opens.
- When the mic is idle, the panel looks and behaves as it does without the mic.

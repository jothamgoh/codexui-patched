# Voice commands: what success looks like

Voice commands come from two places: the iPhone Shortcut on the Action button,
and the mic in the app's notifications panel. Both use the same router
(`src/server/voice/`). This page defines the expected result of each kind of
command and the targets that the tests and evals hold the router to.

## Rules that never change

- **Nothing is sent without a tap in the app.** A send lands in the chat with
  the message typed in. The user reviews it and taps Send. The only exception is
  a Shortcut built for `?confirm=shortcut`: it asks for confirmation inside the
  Shortcut, and only when Jev itself was at least 0.8 sure of the send.
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
| Send ("tell the stripe chat to deploy it", or a long ramble addressed to a chat) | That chat | The message typed into the composer and a "From voice" banner. Nothing is sent |
| New chat ("new chat in hr-ai with codex, fix the build") | The new-chat page | The project, agent and message filled in. The project picker opens when the project is unclear |
| A close call ("open the stripe one" with three Stripe chats) | The chooser | The matching chats as panel rows, the best match first and labelled. The message too, when there is one |
| Several requests at once ("tell X to deploy and open Y") | The Steps chooser | One row for each request in the order you said them. Tapping a row does that step. Back returns to the list |
| Not understood or out of scope ("open spotify", "stop the export job") | The notifications panel | "Didn't catch that · Heard: …" and a mic ready to try again |
| Failure (no network, transcription failed, router down) | Where you were | An inline error with a retry. The Shortcut gets a "Voice command didn't work" notification |

Requests outside scope may also land on a chooser of the chats they name ("what
did the stripe chat say"). They must never open a chat or prepare a send.

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

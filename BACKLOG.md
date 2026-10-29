# Backlog

## Multi-currency on Home
Home is built for one currency (the workspace display currency) for now.
- Recorded net worth by currency: Home used to list each currency's recorded total and the observations behind it (removed with the redesign; the Wealth page still shows net worth per currency).
- Net worth chart: plots only display-currency balances and valuations; convert others with the rate dated on or before each month end.
- Cash flow (month card and six-month chart): no "partial" marker when rows lack a rate; surface it again once FX is handled.
- Budgets and Coming up: amounts in other currencies are left out.

## Voice: later
The first version is the dictation mic, voice notes and live calls in chat, with every write still a card you tap. Left for later:
- Discreet mode: in public, say "it's on your screen" instead of reading amounts aloud.
- Show while talking: the call puts a chart or artifact on screen as it explains.
- Screen-aware calls: start a call from an artifact or Overview and ask about what's on screen.
- Offline voice notes: record without signal and send when back online; share-target and receipt photo plus voice in one note.
- Spoken daily brief: a short audio version of the agent briefing.
- Accept by voice: "yes, add it" accepts small cards (cash spends, IOUs); balances and recurring changes stay tap-only.
- Other voice providers: ElevenLabs (Eleven Realtime) or Gemini Live behind the same call interface.
- Moving money: "send 20 to Ali" makes an IOU or reminder today; real bank payments are a separate, regulated feature.
- Phone-number calls (SIP) and a hands-free wake word.
- Push notifications when the app is closed (today the bell shows them on the next open).
- Locked-screen calls on iPhone: web apps lose the mic when the screen locks; needs a native wrapper.
- Cost limits: auto-hang on long silence, per-call and monthly caps, voice minutes on the usage page.
- Fully durable chat runs on Workflow if a turn ever needs longer than the function's max duration.

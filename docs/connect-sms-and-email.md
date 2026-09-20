# Connecting SMS and email

The ledger runs on the **S20** (192.168.1.118:8090). Your bank messages arrive on a **different
phone**. Something has to move them across, and this is what does it.

Start here: **[SMS — ongoing capture](#sms--ongoing-capture)**.

---

## What works today

| Source | State | Notes |
|---|---|---|
| SMS, new messages | **Ready to set up** | A collector app on your phone posts to the ledger |
| SMS, existing history | Not built | Needs an XML import; see [History](#history-the-gap-this-does-not-fill) |
| Gmail | **Not built** | Milestone M3, and it has an unsolved problem — see [Email](#email) |
| Manual entry | Works now | `/transactions/new` |

---

## SMS — ongoing capture

The collector is **[android_income_sms_gateway_webhook][collector]**, an open-source app that
forwards each incoming SMS to a URL. It was chosen over writing a custom app because it already does
the parts that are easy to get wrong: HMAC-SHA256 request signing, sender filtering, and retry with
exponential backoff.

### 1. Unlock the ledger

On the S20's browser, or from a laptop at `http://192.168.1.118:8090`:

- First time: run setup and choose a passphrase. **There is no recovery.** It encrypts the database
  and is also the backup password.
- After that: unlock.

The webhook returns `503` while locked, so nothing can arrive until this is done.

### 2. Generate the webhook secret

Settings → SMS capture → **Generate secret**. You get:

```
URL     http://192.168.1.118:8090/api/v1/sources/sms-webhook
Secret  <64 hex characters — shown once>
```

The secret is what proves a delivery came from your phone and not from anything else on the network.
Rotating it immediately invalidates the old one.

### 3. Install the collector on your phone

Install from **[F-Droid][collector-fdroid]** or the [GitHub releases][collector]. It is not on Google
Play, because Play restricts SMS permissions — that is expected, not a warning sign.

Grant it SMS permission when it asks.

### 4. Point it at the ledger

In the app:

| Field | Value |
|---|---|
| URL | `http://192.168.1.118:8090/api/v1/sources/sms-webhook` |
| Method | POST, JSON |
| Secret / signing key | the 64 hex characters from step 2 |
| Senders | `*` to start — the ledger does its own filtering, and storing nothing until you choose is the point |

It signs each request with `X-Signature: <hmac-sha256 of the body>`. The ledger verifies that against
the raw bytes before reading anything.

### 5. Choose which senders are financial

Send yourself a test message, or wait for a real one, then open Settings → SMS capture.

**Until you enable a sender, no message body is stored at all** — only the sender's name, how many
times it has written, and when. That is deliberate: you pick from a real list without the app having
kept any content to build it.

Enable your banks. From then on their messages are staged, parsed by the rules engine, and anything
uncertain waits for you in review.

### Checking it works

```sh
curl http://192.168.1.118:8090/api/v1/sources/sms-webhook
```

- `{"ok":false,"reason":"locked"}` — unlock the ledger
- `{"ok":false,"configured":false}` — generate the secret
- `{"ok":true,"lastDeliveryAt":...}` — working; that timestamp is the last message received

### What each response means

| Status | Meaning | What the collector does |
|---|---|---|
| 200 | Accepted | Nothing more |
| 401 | Signature did not match | Gives up — **check the secret** |
| 404 | Webhook not configured | Gives up |
| 503 | Ledger is locked | Retries with backoff, up to 10 times |
| 500 | Something failed | Retries |

---

## History: the gap this does not fill

**The collector forwards new messages only.** Everything already on your phone — every bank SMS from
before you set this up — will not arrive this way.

The same is true after a long outage: if the ledger stays locked longer than the collector's ten
retries last, those messages are gone from this path. They are still on your phone.

The fix is a one-off import from an SMS backup, which `buildspec.md` §5.3 names as a supported
route. **That import is not built yet.** Until it is, history has to be entered manually or waited
for.

This is worth knowing before you judge the numbers: a fresh install only knows what has arrived
since it was set up.

---

## Email

**Not built.** Gmail ingestion is milestone M3.

Beyond the work itself, there is a design problem that has to be solved first, and it is worth
stating plainly because it may change what is possible:

> The server starts locked, and the database key exists only while it is unlocked. An OAuth refresh
> token has to be stored encrypted — but there is no key to encrypt it with until you unlock. So
> Gmail sync cannot run unattended in the background, for the same reason SMS capture cannot.

A refresh token sitting in plaintext so that background sync works would undo the encryption that
protects everything else. The honest options are all worse than they sound, and none has been
chosen.

In the meantime, if a bill only arrives by email, add it manually at `/transactions/new`.

---

## Reference

| | |
|---|---|
| Ledger | `http://192.168.1.118:8090` |
| Webhook | `POST /api/v1/sources/sms-webhook` |
| Health | `GET /api/health` — no financial data; safe to poll |
| Dashboard | `http://192.168.1.118:8080` — the Finance card shows locked state and message counts |

**Security, stated plainly.** The ledger answers the whole LAN over plain HTTP ([ADR 0008][adr8]).
Your passphrase — which is also the database key — crosses the network in cleartext every time you
unlock. Anyone who can see LAN traffic can read it. That was a deliberate choice for convenience on
a home network; transport encryption is the highest-priority security work outstanding. To go back
to phone-only access, set `PFA_HOST=127.0.0.1` and restart.

[collector]: https://github.com/bogkonstantin/android_income_sms_gateway_webhook
[collector-fdroid]: https://f-droid.org/packages/tech.bogomolov.incomingsmsgateway/
[adr8]: adr/0008-bind-the-ledger-to-the-lan.md

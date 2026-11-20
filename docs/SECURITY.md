# Security: CSP and presigned URLs

[Tiếng Việt](SECURITY.vi.md)

This document explains each directive of BucketAdmin's Content-Security-Policy and how the app handles
presigned URLs. A JSON config file cannot hold comments, so the explanation lives here.

## Three layers of policy

The app has three documents, each under its own policy (policies add up; the strictest one wins):

| Document | Policy | What it may load from outside the app |
|---|---|---|
| Every page of the app | header, declared in `src-tauri/tauri.conf.json` | see the table below |
| Main window (`index.html`) | an extra `<meta>` tag in `index.html` | **nothing** |
| Preview frame (`public/preview.html`) | adds its own `<meta>` at run time (`public/preview.js`) | exactly **one origin**: the RGW endpoint of the object being viewed |

Why the preview frame is separate: the RGW endpoint is configured by the user, so its host cannot be written into a
static policy. Instead of letting the whole main window load images / media from any address, only a small page with no
other logic is allowed to, and before it creates an `<img>` / `<audio>` / `<video>` / `<iframe>` it tightens its policy
to the origin of the URL it received.

## General policy (`tauri.conf.json`)

| Directive | Value | Why it is needed |
|---|---|---|
| `default-src` | `'self'` | By default only resources packaged with the app. |
| `script-src` | `'self'` | Only the app's own scripts; no inline, no `eval`, no remote scripts. |
| `style-src` | `'self' 'unsafe-inline'` | MUI (emotion) inserts `<style>` tags at run time. Remote CSS is not allowed. |
| `img-src` | `'self' data: http: https:` | Upper bound for the preview frame (images of an object). The main window is narrowed to `'self' data:` by its `<meta>` tag. |
| `media-src` | `http: https:` | Upper bound for the preview frame (audio / video streamed from RGW). Main window: `'none'`. |
| `frame-src` | `'self' http: https:` | `'self'` lets the main window embed the preview frame; `http: https:` is the upper bound that lets the preview frame embed a PDF viewer. Main window: `'self'` only. |
| `connect-src` | `ipc: http://ipc.localhost` | Only Tauri's IPC channel. The frontend makes no network calls itself: every request to RGW leaves from the Rust backend. |
| `object-src` | `'none'` | No `<object>` / `<embed>`. |
| `base-uri` | `'none'` | A `<base>` tag cannot change the URL root. |
| `form-action` | `'none'` | No form may be submitted anywhere. |

`http:` / `https:` in the three directives above mean "any host" because a static policy cannot know the endpoint in
advance; the per-host tightening happens at run time in `preview.js`: `default-src 'none'; img-src <origin>; media-src <origin>; frame-src <origin>`.

## Presigned URLs

There are two kinds, both signed with the key of the user being browsed (never with the admin secret):

1. **Internal URLs for the preview frame** (images, audio, video, PDF). Valid for 15 minutes. Not displayed, not written to
   the audit log, not written to a file. A video paused for longer than 15 minutes has to be reopened.
2. **URLs the user creates** (Properties tab, Copy URL button). The expiry is the user's choice, 15 minutes by default,
   7 days at most. The audit log records that a URL was created (object, expiry, user) but **not the URL itself**.

Before any URL is handed out, the backend checks that it points at the scheme + host + port of the endpoint of the
connected cluster (`same_origin` in `src-tauri/src/s3/transfer.rs`); if it does not match, it is refused.

## Secrets

- The cluster admin's secret key lives only in the operating system's keychain.
- The secret key of the user being browsed: the backend fetches it through the Admin API when a browse session opens,
  keeps it in memory, never writes it to disk and never sends it to the UI.
- The personal key in "Browse with my own key" mode: the user pastes it in; the secret goes into the keychain (entry
  `<profile id>.browse`, separate from the admin secret), the access key goes into `profiles.json`. This mode sends no
  request to the Admin API; deleting the key or the profile deletes the keychain entry too. The audit log records
  `as=own-key`, never the access key or the secret.
- A profile ticked "I am a regular user": the profile's key is used as the personal key (copied to the `.browse` entry),
  the admin tabs are hidden and the app sends no request to the Admin API for that profile.
- For a profile that is not ticked, each time it connects the app asks which user the key belongs to (S3 ListBuckets, no
  capability needed), then tries to read exactly 5 Admin API endpoints (info, the user itself, metadata, bucket, usage) to
  learn which capabilities the key has. These attempts are read-only and are not audited.
- The audit log never contains a secret key or a presigned URL.
- The path picker reads a bucket policy (`GetBucketPolicy`) with the connection's own key only, to suggest paths; it never
  uses the admin key for that, and any refusal is silent.
- The audit log page (app-bar menu) is read-only: the app has no command that deletes, edits or exports the log.

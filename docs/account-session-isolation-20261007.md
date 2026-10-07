# Account/session isolation fix

## Scope

Fix browser-side state leaking across account switches. Backend conversation
storage and ownership checks are unchanged, as are model routing, provider
configuration, agent prompts, UI layout and server data files.

## Changes

- Cache agent metadata/session mappings under `jlagent:<encoded username>:...`.
  Do not migrate the two old ownerless shared keys into any account. Retrieve
  the real account's metadata and sessions from the existing authenticated APIs.
- Logout/login invalidates the previous login lifetime, including logout and
  relogin with the same username/JWT. Browser-back logout uses the same reset.
- Clear sidebar/history, drafts, file preview, per-mode and per-agent session
  pointers; abort the previous stream and clear its thinking timer.
- Guard asynchronous list/history, metadata sync, creation/deletion/rename,
  export downloads, pending login callbacks, stream chunks/errors/finalizers and file-read results.
  A stale response must not mutate another account or unlock its current stream.
- Reconcile session mappings against the authenticated server list, removing
  foreign/deleted IDs rather than unioning them. Retain valid legacy mappings
  only for owned sessions lacking a server-side agent assignment.
- Bump JavaScript/service-worker asset versions together. APIs remain uncached.

## Verification

`node --test tests/frontend_account_isolation.test.cjs tests/frontend_model_selection.test.cjs`

51 passing frontend tests, including 39 account/session cases executing the
complete production JavaScript in a mocked browser and 12 selector/send cases.

`python -X utf8 -m unittest discover -s tests -p test_auto_account_routing.py -v`

49 passing backend model/preference/routing regression tests. Separate offline
JWT/API/storage checks confirm 22 cross-account/default-session requests are
rejected even when both accounts have admin role, and 40 parallel own-account
history reads remain isolated. All test storage is temporary. No live server
data, user passwords or paid model calls are used.

## Server deployment

Only replace these three production files, from the same commit:

- `app/static/js/app.js`
- `app/static/index.html`
- `app/static/sw.js`

No dependency install, `.env` change, backend migration, database/history
cleanup or automatic backup is needed. Refresh the browser and sign in again.
This removes ambiguous legacy browser cache entries, not server-side histories.
The fix adds no model requests or polling, and keeps the existing sync cooldown.

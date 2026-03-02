# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Start server (node server.js)
npm run dev        # Start with auto-reload (node --watch server.js)
```

No test framework configured. No linter configured.

## Architecture

Full-stack Fritz!Box router management app: Node.js/Express backend proxying Fritz!Box APIs, vanilla JS frontend.

### Backend (`server.js` + `src/fritzbox/`)

- **server.js**: Express app with all routes under `/api/*`. Auth guard middleware protects everything except `/login`, `/logout`, `/status`. Rate limiting (5 req/min per IP) on login.
- **auth.js**: `FritzAuth` class — PBKDF2 challenge-response (MD5 fallback) via `login_sid.lua?version=2`. SID expires at 20min, auto-renewed at 19min.
- **soap.js**: TR-064 SOAP client on port 49000 with HTTP Digest Auth. Used for device enumeration and WAN access control.
- **hosts.js**: `FritzHosts` — device list via SOAP `GetHostListPath` (XML), fallback to batch `GetGenericHostEntry`. Manages `lastseen-data.json`.
- **filter.js**: `FritzFilter` — parental controls. **Parses HTML responses** from `data.lua` (not JSON). 30s cache on `kidLis` page. 2-step device deletion with confirm. Website lists use `\r` separator for full-list replacement.
- **monitor.js**: `FritzMonitor` — polls every 30s, tracks device sessions, stores rolling 30-day history in `monitor-data.json`.

All Fritz modules are instantiated on login and cleared on logout. Single `fritzAuth` instance shared across modules.

### Frontend (`public/js/`)

Each file is an **IIFE** exporting public functions to `window`. Load order matters (set in `index.html`):

1. **app.js** → exports: `state`, `API`, `api()`, `showToast()`, `withBtnGuard()`, `debounce()`, `skeletonCards()`
2. **devices.js** → exports: `escapeHtml`, `escapeAttr`, `loadDevices`, `removeDevice`, `removeAllOffline`, `toggleFavorite`
3. **filters.js** → exports: `loadFilters`, `toggleKidBlock`, `changeProfile`
4. **profiles.js** → exports: `loadProfiles`, `openProfileEditor`, `closeProfileEditor`, `deleteProfile`, `saveProfileForm`, `switchFilterSubTab`, `selectIcon`, `toggleFilterSection`, `addWebsiteEntry`, `removeWebsiteEntry`
5. **monitor.js** → exports: `loadMonitorData`, `toggleMonitor`, `cleanupMonitor`

**State**: single `window.state` object (`{ connected, devices, filters }`). Rendering is always full re-render from state, not incremental DOM updates.

**API constants**: all endpoint URLs are in the `API` object in `app.js`. Use `API.DEVICES`, `API.PROFILE(id)`, etc.

**Shared patterns**:
- `withBtnGuard(btn, fn)` — disable button during async action, catch errors → toast
- `api(method, url, body)` — fetch wrapper with 30s timeout, returns `{ success, data, error }`
- Optimistic UI with rollback (favorites)
- Promise deduplication to prevent duplicate API calls on rapid tab switches
- `forceRefresh` parameter pattern on `loadFilters()` / `loadProfiles()` for cache-or-fetch behavior

### Data files (gitignored)

`favorites.json`, `monitor-data.json`, `lastseen-data.json`, `profile-meta.json` — all JSON, read/written by server.

## Conventions

- **French UI strings**, English code (variables, functions, classes, comments)
- CSS: BEM-like with hyphens (`.device-card`, `.profile-card-header`), dark theme via CSS variables (`--bg-card`, `--accent`, `--danger`, etc.)
- Backend classes: `FritzAuth`, `FritzHosts`, `FritzFilter`, `FritzSoap`, `FritzMonitor`
- Private module vars prefixed with `_` (`_filtersLoading`, `_changeProfilePending`)
- Frontend uses `escapeHtml()` / `escapeAttr()` for all innerHTML templates
- Backend uses `sanitizeString(str, maxLen)` on all POST/PUT body fields

## Fritz!Box API Gotchas

- `data.lua` **always returns 200 OK** even on bad parameters — can't rely on HTTP status
- `kidLis` page returns **HTML not JSON** — parsed with regex, slow (~10s for 90 devices), cached 30s
- Device deletion is **2-step**: POST `delete=landeviceXXX` → confirm response → POST with `confirmed=`
- `xhrId=cleanup` bulk delete does **not work** on Fritz!OS 8.21 (7530) — use individual 2-step instead
- Website filter lists require **full replacement** with `\r` (%0D) separator, max 500 entries
- TR-064 SOAP (port 49000) requires **HTTP Digest Auth**, not Basic Auth
- Device names can be duplicated — always use **MAC as primary identifier**
- Blocking a device creates a **duplicate `user*` UID** alongside the `landevice*` UID — unblock must handle both
- After unblocking a `landevice*`, Fritz!Box may **remove it from `kidLis`** — use the device name (sent by frontend) to find remaining `user*` entries

## Configuration

`.env` file at project root:

```env
FRITZ_HOST=192.168.178.1    # Fritz!Box IP
FRITZ_USER=admin             # Username (can be empty for older Fritz!OS)
FRITZ_PASSWORD=password      # Required
PORT=3000                    # Server port
```

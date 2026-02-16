# Firefox Compatibility Research (Draft)

Goal: identify MV3/API gaps and required code changes for Firefox support.

Items to verify against official Mozilla docs:
- MV3 status and limitations (service worker differences, scripting APIs)
- `chrome.*` vs `browser.*` namespace and Promise-based APIs
- Content script injection and host permissions behavior
- Web Audio API parity and autoplay/resume rules
- Storage quotas and `storage.sync` availability

Proposed approach (to validate):
- Add a small compat wrapper (`const api = globalThis.browser ?? globalThis.chrome`)
- Replace callback-based APIs with Promise-based calls where needed
- Update manifest keys if required by Firefox
- Run manual tests on `audio, video` pages + meeting web apps

Open questions:
- Any restrictions on `AudioContext` in content scripts?
- Are there limitations on `host_permissions` in MV3?
- Does Firefox require additional permissions for tabs messaging?

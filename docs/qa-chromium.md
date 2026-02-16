# Chromium QA Checklist

Target browsers:
- Chrome (stable)
- Edge (stable)
- Brave (stable)
- Opera (stable)

Core scenarios:
- Load unpacked extension and open popup
- Slider adjusts volume on a page with `<audio>` and `<video>`
- Speech Focused toggle applies clarity chain
- Mute toggles audio on/off
- Status shows Applied / Not hooked / Blocked
- Auto gain does not “pump” on speech (listen for artifacts)

Site coverage:
- YouTube (standard `<video>`)
- Google Meet (web)
- Zoom web
- Microsoft Teams web

Known quirks to document:
- Any site where audio cannot be hooked
- Any site requiring user click to resume audio
- Any performance issues (CPU spikes, glitches)

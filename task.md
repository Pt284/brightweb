# Task List: Color Settings Popup

- [x] Update `bg.js` to expose `window.BlobController` with `setPalette`, `setSpeed`, and `toggle`
- [x] Create `color-settings.css` for popup styling
- [x] Create `color-settings.js` containing:
  - `BASE_TOKENS` and `applyTheme()` with `Math.round()` hue
  - UI injection (Popup DOM structure)
  - Event listeners for Simple and Advanced tabs
  - `loadSavedSettings()` called on `DOMContentLoaded`
  - Integration with `BlobController`
- [x] Add trigger button to header and include CSS/JS in `index.html`
- [x] Add trigger button to header and include CSS/JS in `admin-check.html`
- [x] Verify everything works perfectly

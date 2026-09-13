/*
 * Pre-paint theme apply — the v3 replacement for the old inline script.
 * External (not inline) because the production CSP allows script-src 'self'
 * only; it is still a blocking classic script loaded before the app bundle,
 * so it runs during HTML parse, before first paint.
 *
 * Reads the zustand-persist key written by stores/themeStore.ts. Supported
 * payload shapes: v3 {themeId, themeCss, themeType} and v2 {themeId,
 * themeCss} (themeType derived). Mirrors applyThemeToDocument:
 *   - data-theme always carries the dark/light TYPE (native controls and the
 *     built-in One Light override block key off the type);
 *   - a custom theme id additionally writes data-custom-theme="<id>" and
 *     injects the cached CSS scoped to :root[data-custom-theme="<id>"] into
 *     a single <style id="c0wrk-custom-theme"> in <head>.
 * main.tsx re-applies the theme from the rehydrated store; both passes are
 * idempotent.
 */
;(function () {
  var BUILTIN = {
    'default-dark': 'dark',
    'default-light': 'light',
  }
  try {
    var raw = window.localStorage.getItem('c0wrk-theme')
    if (!raw) return
    var state = JSON.parse(raw).state
    if (!state) return
    var themeId = typeof state.themeId === 'string' ? state.themeId : ''
    var css = typeof state.themeCss === 'string' ? state.themeCss : ''
    var type = state.themeType === 'light' || state.themeType === 'dark'
      ? state.themeType
      : null
    if (!type) {
      if (BUILTIN[themeId]) {
        type = BUILTIN[themeId]
      } else {
        var m = /color-scheme:\s*(dark|light)/i.exec(css)
        type = m ? m[1].toLowerCase() : 'dark'
      }
    }
    var root = document.documentElement
    var builtinType = BUILTIN[themeId]
    root.setAttribute('data-theme', builtinType || type)
    if (builtinType) return
    if (!themeId) return
    root.setAttribute('data-custom-theme', themeId)
    var style = document.getElementById('c0wrk-custom-theme')
    if (!style) {
      style = document.createElement('style')
      style.id = 'c0wrk-custom-theme'
      document.head.appendChild(style)
    }
    style.textContent = css.split(':root').join(':root[data-custom-theme="' + themeId + '"]')
  } catch (e) {
    /* ignore — fall through to the default One Dark palette */
  }
})()

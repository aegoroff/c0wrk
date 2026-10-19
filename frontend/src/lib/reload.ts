// The one seam for "reload the current page". A whole module (not an inline
// window.location call) so tests can mock the reload side effect — jsdom's
// Location is [Unforgeable] and its methods can be neither shadowed nor
// deleted, so a spy on window.location.reload is impossible there.
export function reloadPage(): void {
  window.location.reload()
}

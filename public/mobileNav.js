/* ── Mobile UX layer ──
 *
 * Two responsibilities, both gated to the mobile breakpoint via matchMedia so
 * the desktop 3-column grid is completely untouched:
 *
 *   1. Bottom tab bar — Decks / Slide / Edit. Below 899px only ONE panel is
 *      visible at a time; tapping a tab sets `data-mobile-panel` on `.panels`,
 *      and the CSS (style.css @media block) shows just that child.
 *   2. Slide-nav overflow sheet — the "•••" button toggles `.slide-nav-secondary`
 *      open as a bottom sheet holding Source / CRUD / Export.
 *
 * All wiring is harmless on desktop: the tab bar + ••• button are display:none
 * there, and we never strip `data-mobile-panel` semantics that desktop relies
 * on (desktop ignores the attribute entirely).
 */
(function () {
  'use strict';

  var MOBILE = window.matchMedia('(max-width: 899px)');
  var panels = document.querySelector('.panels');
  var tabbar = document.getElementById('mobile-tabbar');
  if (!panels || !tabbar) return;

  var DEFAULT_PANEL = 'viewer'; // Slide tab on load
  var tabs = Array.prototype.slice.call(tabbar.querySelectorAll('.mobile-tab'));

  // ── Panel switching ──
  function showPanel(panel) {
    panels.setAttribute('data-mobile-panel', panel);
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.dataset.panel === panel);
    });
    // If switching to the Edit panel, make sure the agent transcript / composer
    // can recompute keyboard offsets once it becomes visible.
    if (panel === 'edit-panel') {
      window.dispatchEvent(new CustomEvent('fgs:mobile-panel-shown', { detail: { panel: panel } }));
    }
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      showPanel(tab.dataset.panel);
      closeSlideSheet();
    });
  });

  // When a deck is picked from the Decks tab, jump straight to the slide so the
  // user sees their selection (only meaningful on mobile).
  var deckItems = document.getElementById('deck-items');
  if (deckItems) {
    deckItems.addEventListener('click', function (e) {
      if (!MOBILE.matches) return;
      if (e.target.closest('.deck-item')) showPanel('viewer');
    });
  }

  // ── Slide-nav overflow sheet ("•••") ──
  var btnMore = document.getElementById('btn-slide-more');
  var secondary = document.getElementById('slide-nav-secondary');

  function closeSlideSheet() {
    if (secondary) secondary.classList.remove('open');
    if (btnMore) btnMore.classList.remove('active');
  }

  if (btnMore && secondary) {
    btnMore.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = secondary.classList.toggle('open');
      btnMore.classList.toggle('active', open);
    });
    // Tapping any action inside the sheet (except the export popup toggle, which
    // opens its own submenu) closes the sheet.
    secondary.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'btn-slide-export') return; // let its own popup open first
      // Defer so the underlying handler (CRUD / source / export option) runs.
      setTimeout(closeSlideSheet, 0);
    });
    // Outside tap closes the sheet.
    document.addEventListener('click', function (e) {
      if (!secondary.classList.contains('open')) return;
      if (secondary.contains(e.target) || e.target === btnMore) return;
      closeSlideSheet();
    });
  }

  // ── Breakpoint sync ──
  // Entering mobile: establish the default panel if none is set. Leaving mobile:
  // close the sheet (desktop shows everything inline; the attribute is ignored).
  function syncMode() {
    if (MOBILE.matches) {
      if (!panels.getAttribute('data-mobile-panel')) showPanel(DEFAULT_PANEL);
    } else {
      closeSlideSheet();
    }
  }

  if (MOBILE.addEventListener) MOBILE.addEventListener('change', syncMode);
  else if (MOBILE.addListener) MOBILE.addListener(syncMode); // older Safari

  // Always set the default attribute so the first mobile paint is correct even
  // before any resize event fires.
  showPanel(DEFAULT_PANEL);
  syncMode();

  // Expose for other modules / tests.
  window.MobileNav = { showPanel: showPanel, isMobile: function () { return MOBILE.matches; } };
})();

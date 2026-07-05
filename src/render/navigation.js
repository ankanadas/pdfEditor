// Page navigation — prev/next, scroll-to-page, current-page tracking + the page indicator.
// These are assembled onto PDFEditorApp.prototype (mixin), so `this` is the app instance and
// behavior is identical to when they lived inline. Extracted verbatim from app.js.

export const NavigationMethods = {
  previousPage() { this.scrollToPage(this.currentPage - 1); },
  nextPage() { this.scrollToPage(this.currentPage + 1); },

  scrollToPage(i) {
    const pv = this.pageViews[i];
    if (!pv) return;
    pv.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.currentPage = i;
    this.updatePageInfo();
  },

  /** Update the current-page indicator from the scroll position. */
  updateCurrentPageFromScroll() {
    const stage = document.getElementById('stage');
    if (!stage || !this.pageViews.length) return;
    const mid = stage.scrollTop + stage.clientHeight / 2;
    let best = 0;
    for (let i = 0; i < this.pageViews.length; i++) {
      if (this.pageViews[i].wrapper.offsetTop <= mid) best = i;
    }
    if (best !== this.currentPage) { this.currentPage = best; this.updatePageInfo(); }
  },

  updatePageInfo() {
    const input = document.getElementById('pageNumInput');
    const pageInfo = document.getElementById('pageInfo');
    if (this.pdfJsDoc) {
      // Don't stomp the field WHILE the user is typing in it; the total goes in #pageInfo.
      if (input) {
        input.disabled = false;
        if (document.activeElement !== input) input.value = String(this.currentPage + 1);
      }
      if (pageInfo) pageInfo.textContent = `/ ${this.pdfJsDoc.numPages}`;
    }
  },

  /** Jump to the page number typed into #pageNumInput (Chrome-style). An empty/non-numeric/
   *  out-of-range value silently reverts to the current page — never navigates anywhere invalid. */
  goToTypedPage() {
    const input = document.getElementById('pageNumInput');
    if (!input || !this.pdfJsDoc) return;
    // Refresh the current page from the ACTUAL scroll position first, so an invalid entry reverts
    // to the page the user is really on — not a stale value (which is how it could show/jump to 1).
    this.updateCurrentPageFromScroll();
    const n = parseInt(input.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= this.pdfJsDoc.numPages) {
      this.scrollToPage(n - 1);
    } else {
      input.value = String(this.currentPage + 1);   // invalid → stay on the current page (no navigation)
    }
  },
};

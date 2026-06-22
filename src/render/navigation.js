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
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo && this.pdfJsDoc) {
      pageInfo.textContent = `Page ${this.currentPage + 1} of ${this.pdfJsDoc.numPages}`;
    }
  },
};

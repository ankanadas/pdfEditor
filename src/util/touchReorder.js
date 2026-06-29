// Pointer (touch) drag-to-reorder driven from an explicit grab HANDLE.
//
// HTML5 drag-and-drop (dragstart/dragover/drop) does NOT fire for touch input, so on touch devices the
// page-reorder and merge-reorder lists couldn't be reordered at all. This drives reorder from raw pointer
// events instead. Desktop mouse keeps using the native DnD path (we ignore pointerType 'mouse' here), so
// this is purely the mobile/touch path. Visual feedback reuses the SAME .dragging / .drop-before /
// .drop-after classes the DnD path already styles, so both paths look identical.
//
// Grabbing from a dedicated handle (not the whole tile) avoids fighting tap-to-select and list scrolling:
// the handle carries touch-action:none, so a press on it starts a drag instead of scrolling the panel.

const clearMarkers = (container, itemSelector) => {
  container.querySelectorAll(`${itemSelector}.drop-before, ${itemSelector}.drop-after`)
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
};

// Which item is under the pointer, and is the pointer past its midpoint (→ insert AFTER it)?
function hitTest(ev, container, itemSelector, item, axis) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const tgt = el && el.closest ? el.closest(itemSelector) : null;
  if (!tgt || tgt === item || !container.contains(tgt)) return { tgt: null, after: false };
  const r = tgt.getBoundingClientRect();
  const after = axis === 'x' ? (ev.clientX - r.left) > r.width / 2 : (ev.clientY - r.top) > r.height / 2;
  return { tgt, after };
}

/**
 * Wire one grab handle so a touch drag reorders `item` within `container`.
 * @param handle   the element the user presses to start dragging (gets touch-action:none in CSS)
 * @param item     the reorderable tile/card the handle belongs to
 * @param container the scrolling list/grid that holds the items
 * @param itemSelector CSS selector matching sibling items (e.g. '.page-thumb')
 * @param axis     'x' for a horizontal/grid list, 'y' for a vertical list (which edge = before/after)
 * @param onDrop   (fromItem, toItem, after) => void — commit the reorder
 */
export function bindHandleReorder(handle, { item, container, itemSelector, axis = 'y', onDrop }) {
  if (!handle || !item || !container) return;
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;            // desktop mouse keeps native HTML5 DnD
    e.preventDefault(); e.stopPropagation();
    item.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events / unsupported */ }
    const prevContainerTA = container.style.touchAction;
    container.style.touchAction = 'none';             // stop the panel scrolling under the drag
    let last = { tgt: null, after: false };

    const move = (ev) => {
      ev.preventDefault();
      const hit = hitTest(ev, container, itemSelector, item, axis);
      clearMarkers(container, itemSelector);
      if (hit.tgt) { hit.tgt.classList.add(hit.after ? 'drop-after' : 'drop-before'); last = hit; }
      else last = { tgt: null, after: false };
    };
    const end = (ev) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      container.style.touchAction = prevContainerTA;
      item.classList.remove('dragging');
      const hit = hitTest(ev, container, itemSelector, item, axis);
      const drop = hit.tgt ? hit : last;
      clearMarkers(container, itemSelector);
      if (drop.tgt && drop.tgt !== item) onDrop(item, drop.tgt, drop.after);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

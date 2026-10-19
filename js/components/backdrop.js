// Close a dialog when its backdrop is clicked: only when the press STARTED
// on the backdrop too. A click fires where the mouse is released, so
// pressing inside the box (selecting text, dragging) and letting go outside
// used to count as a backdrop click and closed the dialog.
export function onBackdropClick(backdrop, fn) {
  let downOnBackdrop = false;
  backdrop.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop && downOnBackdrop) fn(e);
    downOnBackdrop = false;
  });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//@line 10 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"

this.EXPORTED_SYMBOLS = [ "WindowDraggingElement" ];

this.WindowDraggingElement = function WindowDraggingElement(elem) {
  this._elem = elem;
  this._window = elem.ownerDocument.defaultView;
//@line 17 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"
  if (!this.isPanel())
    this._elem.addEventListener("MozMouseHittest", this, false);
  else
//@line 21 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"
  this._elem.addEventListener("mousedown", this, false);
};

WindowDraggingElement.prototype = {
  mouseDownCheck: function(e) { return true; },
  dragTags: ["box", "hbox", "vbox", "spacer", "label", "statusbarpanel", "stack",
             "toolbaritem", "toolbarseparator", "toolbarspring", "toolbarspacer",
             "radiogroup", "deck", "scrollbox", "arrowscrollbox", "tabs"],
  shouldDrag: function(aEvent) {
    if (aEvent.button != 0 ||
        this._window.fullScreen ||
        !this.mouseDownCheck.call(this._elem, aEvent) ||
        aEvent.defaultPrevented)
      return false;

    let target = aEvent.originalTarget, parent = aEvent.originalTarget;

    // The target may be inside an embedded iframe or browser. (bug 615152)
    if (target.ownerDocument.defaultView != this._window)
      return false;

    while (parent != this._elem) {
      let mousethrough = parent.getAttribute("mousethrough");
      if (mousethrough == "always")
        target = parent.parentNode;
      else if (mousethrough == "never")
        break;
      parent = parent.parentNode;
    }
    while (target != this._elem) {
      if (this.dragTags.indexOf(target.localName) == -1)
        return false;
      target = target.parentNode;
    }
    return true;
  },
  isPanel : function() {
    return this._elem instanceof Components.interfaces.nsIDOMXULElement &&
           this._elem.localName == "panel";
  },
  handleEvent: function(aEvent) {
    let isPanel = this.isPanel();
//@line 64 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"
    if (!isPanel) {
      if (this.shouldDrag(aEvent))
        aEvent.preventDefault();
      return;
    }
//@line 70 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"

    switch (aEvent.type) {
      case "mousedown":
        if (!this.shouldDrag(aEvent))
          return;

//@line 81 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"
        if (isPanel) {
          let screenRect = this._elem.getOuterScreenRect();
          this._deltaX = aEvent.screenX - screenRect.left;
          this._deltaY = aEvent.screenY - screenRect.top;
        }
        else {
          this._deltaX = aEvent.screenX - this._window.screenX;
          this._deltaY = aEvent.screenY - this._window.screenY;
        }
        this._draggingWindow = true;
        this._window.addEventListener("mousemove", this, false);
        this._window.addEventListener("mouseup", this, false);
//@line 94 "e:\hg38\comm-esr38\mozilla\toolkit\modules\WindowDraggingUtils.jsm"
        break;
      case "mousemove":
        if (this._draggingWindow) {
          let toDrag = this.isPanel() ? this._elem : this._window;
          toDrag.moveTo(aEvent.screenX - this._deltaX, aEvent.screenY - this._deltaY);
        }
        break;
      case "mouseup":
        if (this._draggingWindow) {
          this._draggingWindow = false;
          this._window.removeEventListener("mousemove", this, false);
          this._window.removeEventListener("mouseup", this, false);
        }
        break;
    }
  }
}

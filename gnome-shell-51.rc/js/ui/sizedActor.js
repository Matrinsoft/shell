// LingmoOS: a widget whose reported size does not depend on a parent layout
// manager. Used by the desktop dock and the window previews, which are placed
// manually.

import GObject from 'gi://GObject';
import St from 'gi://St';

export const SizedActor = GObject.registerClass(
class SizedActor extends St.Widget {
    _init(params = {}) {
        super._init(params);
        this._sizedWidth = 0;
        this._sizedHeight = 0;
    }

    setSizedSize(width, height) {
        if (this._sizedWidth === width && this._sizedHeight === height)
            return;

        this._sizedWidth = width;
        this._sizedHeight = height;
        this.queue_relayout();
    }

    vfunc_get_preferred_width() {
        return [this._sizedWidth, this._sizedWidth];
    }

    vfunc_get_preferred_height() {
        return [this._sizedHeight, this._sizedHeight];
    }
});

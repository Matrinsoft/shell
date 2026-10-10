// LingmoOS: persistent dash (dock) on the desktop.
//
// GNOME Shell only shows its dash inside the overview. This module reuses the
// very same Dash widget to draw a dock that stays available on the desktop,
// and it honours the org.gnome.shell.dash settings that the Appearance panel
// of gnome-control-center edits.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Dash from './dash.js';
import * as Main from './main.js';

const DASH_SETTINGS_SCHEMA = 'org.gnome.shell.dash';

// St widgets are sized by their parent layout manager; the actors below are
// placed manually, so they report the size we give them.
const SizedActor = GObject.registerClass(
class SizedActor extends St.Widget {
    _init(params = {}) {
        super._init(params);
        this._sizedWidth = 0;
        this._sizedHeight = 0;
    }

    setSizedSize(width, height) {
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

const ANIMATION_TIME = 200;
const AUTOHIDE_HIDE_TIMEOUT = 600;
const AUTOHIDE_TRIGGER_SIZE = 2;
const DOCK_MARGIN = 6;

export const DesktopDash = GObject.registerClass(
class DesktopDash extends St.Widget {
    _init() {
        super._init({
            name: 'desktop-dash',
            style_class: 'desktop-dash',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            visible: false,
        });

        this._settings = new Gio.Settings({schema_id: DASH_SETTINGS_SCHEMA});
        this._dash = null;
        this._autohide = false;
        this._autohideRevealed = false;
        this._hideTimeoutId = 0;
        this._updateLaterId = 0;

        // Invisible actor which tells the window manager how much of the work
        // area the dock occupies. It is kept degenerate whenever the dock is
        // hidden, auto-hiding or not supposed to reserve space.
        this._strut = new SizedActor({name: 'desktop-dash-strut'});

        // Thin strip along the screen edge that reveals an auto-hidden dock.
        this._trigger = new SizedActor({
            name: 'desktop-dash-trigger',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._trigger.connect('notify::hover', () => {
            if (this._trigger.hover)
                this._showDock();
        });

        this.connect('notify::hover', () => {
            if (this.hover)
                this._cancelHide();
            else
                this._queueHide();
        });

        Main.layoutManager.addChrome(this, {
            affectsStruts: false,
            affectsInputRegion: true,
            trackFullscreen: false,
        });
        Main.layoutManager.addChrome(this._strut, {
            affectsStruts: true,
            affectsInputRegion: false,
            trackFullscreen: false,
        });
        Main.layoutManager.addChrome(this._trigger, {
            affectsStruts: false,
            affectsInputRegion: true,
            trackFullscreen: false,
        });

        this._settings.connectObject('changed',
            (_settings, key) => this._onSettingsChanged(key), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueUpdate(), this);
        Main.overview.connectObject(
            'showing', () => this._sync(),
            'hiding', () => this._sync(),
            this);
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        global.window_group.connectObject('notify::visible',
            () => this._sync(), this);

        this._rebuild();
        this._sync();
    }

    vfunc_get_preferred_width() {
        if (!this._dash)
            return [0, 0];

        return this._dash.get_preferred_width(-1);
    }

    vfunc_get_preferred_height(forWidth) {
        if (!this._dash)
            return [0, 0];

        return this._dash.get_preferred_height(forWidth);
    }

    get _vertical() {
        const position = this._settings.get_string('dock-position');
        return position === 'left' || position === 'right';
    }

    // The dash lays its icons out horizontally for the bottom edge, and
    // vertically for the left/right edges, so the widget is rebuilt whenever
    // the dock changes edge.
    _rebuild() {
        if (this._dash) {
            this._dash.destroy();
            this._dash = null;
        }

        this._dash = new Dash.Dash({
            desktop: true,
            vertical: this._vertical,
        });
        this.add_child(this._dash);

        this._dash.connectObject(
            'icon-size-changed', () => this._queueUpdate(),
            'contents-changed', () => this._queueUpdate(),
            this);
    }

    _onSettingsChanged(key) {
        if (key === 'dock-position')
            this._rebuild();

        if (key === 'dock-autohide')
            this._autohideRevealed = false;

        this._sync();
    }

    // Defer the update to after the layout manager recomputed its own state,
    // so that our visibility decision always wins.
    _queueUpdate() {
        if (this._updateLaterId)
            return;

        const laters = global.compositor.get_laters();
        this._updateLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._updateLaterId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const monitor = Main.layoutManager.primaryMonitor;
        const enabled = this._settings.get_boolean('dock-enabled');
        const locked = Main.sessionMode.currentMode === 'unlock-dialog';

        this._autohide = this._settings.get_boolean('dock-autohide');

        const usable = enabled && monitor !== null &&
            !Main.sessionMode.isGreeter && !locked &&
            !Main.overview.visible && !monitor.inFullscreen;

        if (!usable)
            this._autohideRevealed = false;

        this.visible = usable;
        this._usable = usable;

        this._updateGeometry();
        this._updateAutohideOffset(false);
        this._updateTriggerVisibility();
    }

    _updateGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const position = this._settings.get_string('dock-position');
        const vertical = this._vertical;
        const alignment = this._settings.get_string('dash-alignment');
        const iconSize = this._settings.get_int('icon-size');

        // Tell the dash how much room it has, then take its natural size.
        if (vertical)
            this._dash.setMaxSize(iconSize + 40, monitor.height - 2 * DOCK_MARGIN);
        else
            this._dash.setMaxSize(monitor.width - 2 * DOCK_MARGIN, iconSize + 40);

        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);

        let x, y;
        if (position === 'left') {
            x = monitor.x + DOCK_MARGIN;
            y = this._aligned(monitor.y, monitor.height, height, alignment);
        } else if (position === 'right') {
            x = monitor.x + monitor.width - width - DOCK_MARGIN;
            y = this._aligned(monitor.y, monitor.height, height, alignment);
        } else {
            x = this._aligned(monitor.x, monitor.width, width, alignment);
            y = monitor.y + monitor.height - height - DOCK_MARGIN;
        }

        x = Math.round(x);
        y = Math.round(y);
        this.set_position(x, y);

        // Reserve work area, unless the dock is auto-hiding or invisible.
        // Note that the strut rectangle has to touch the screen edge, or the
        // window manager will ignore it.
        const reserve = this._settings.get_boolean('dock-reserve-space') &&
            !this._autohide && this.visible;

        let strutX = monitor.x;
        let strutY = monitor.y;
        let strutWidth = 0;
        let strutHeight = 0;

        if (reserve) {
            if (position === 'left') {
                strutX = monitor.x;
                strutY = y;
                strutWidth = width + DOCK_MARGIN;
                strutHeight = height;
            } else if (position === 'right') {
                strutX = x;
                strutY = y;
                strutWidth = width + DOCK_MARGIN;
                strutHeight = height;
            } else {
                strutX = x;
                strutY = y;
                strutWidth = width;
                strutHeight = height + DOCK_MARGIN;
            }
        }

        this._strut.set_position(strutX, strutY);
        this._strut.setSizedSize(strutWidth, strutHeight);

        // Keep the reveal strip on the same edge, aligned with the dock.
        const triggerWidth = vertical ? AUTOHIDE_TRIGGER_SIZE : width;
        const triggerHeight = vertical ? height : AUTOHIDE_TRIGGER_SIZE;
        this._trigger.setSizedSize(triggerWidth, triggerHeight);

        if (position === 'left') {
            this._trigger.set_position(monitor.x, y);
        } else if (position === 'right') {
            this._trigger.set_position(
                monitor.x + monitor.width - AUTOHIDE_TRIGGER_SIZE, y);
        } else {
            this._trigger.set_position(
                x, monitor.y + monitor.height - AUTOHIDE_TRIGGER_SIZE);
        }
    }

    _aligned(start, extent, size, alignment) {
        switch (alignment) {
        case 'start':
            return start + DOCK_MARGIN;
        case 'end':
            return start + extent - size - DOCK_MARGIN;
        default:
            return start + Math.round((extent - size) / 2);
        }
    }

    _updateTriggerVisibility() {
        this._trigger.visible = this._usable &&
            this._autohide && !this._autohideRevealed;
    }

    _updateAutohideOffset(animate) {
        let hiddenX = 0;
        let hiddenY = 0;

        if (this._autohide && !this._autohideRevealed) {
            const position = this._settings.get_string('dock-position');

            if (position === 'left')
                hiddenX = -(this.width + DOCK_MARGIN);
            else if (position === 'right')
                hiddenX = this.width + DOCK_MARGIN;
            else
                hiddenY = this.height + DOCK_MARGIN;
        }

        if (this.translation_x === hiddenX && this.translation_y === hiddenY)
            return;

        if (!animate) {
            this.translation_x = hiddenX;
            this.translation_y = hiddenY;
            return;
        }

        const hiding = hiddenX !== 0 || hiddenY !== 0;

        this.ease({
            translation_x: hiddenX,
            translation_y: hiddenY,
            duration: ANIMATION_TIME,
            mode: hiding
                ? Clutter.AnimationMode.EASE_IN_QUAD
                : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _showDock() {
        if (!this._autohide || this._autohideRevealed || !this.visible)
            return;

        this._autohideRevealed = true;
        this._cancelHide();
        this._updateAutohideOffset(true);
        this._updateTriggerVisibility();
    }

    _queueHide() {
        if (!this._autohide || !this._autohideRevealed)
            return;

        this._cancelHide();
        this._hideTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            AUTOHIDE_HIDE_TIMEOUT, () => {
                this._hideTimeoutId = 0;
                this._autohideRevealed = false;
                this._updateAutohideOffset(true);
                this._updateTriggerVisibility();
                return GLib.SOURCE_REMOVE;
            });
        GLib.Source.set_name_by_id(this._hideTimeoutId,
            '[gnome-shell] desktop dash autohide');
    }

    _cancelHide() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
    }
});

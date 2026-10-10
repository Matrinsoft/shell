// LingmoOS: window previews for dash/dock icons.
//
// Hovering an application icon in the desktop dock shows a small popup with a
// live thumbnail per window of that application. The popup is a plain chrome
// actor, so it does not take a modal grab and the icon keeps its hover state.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from './main.js';
import {SizedActor} from './sizedActor.js';

const THUMBNAIL_WIDTH = 180;
const THUMBNAIL_HEIGHT = 120;
const POPUP_MARGIN = 8;

export const WindowThumbnail = GObject.registerClass({
    Signals: {'activated': {}},
}, class WindowThumbnail extends St.Widget {
    _init(metaWindow, params = {}) {
        super._init({
            style_class: 'dash-window-thumbnail',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._window = metaWindow;
        this._app = params.app ?? null;
        this._clone = null;

        // The thumbnail area has a fixed size, independent of the parent
        // layout, so that the popup does not resize while windows change.
        this._content = new SizedActor({
            style_class: 'dash-window-thumbnail-content',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this._content.setSizedSize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

        this._icon = new St.Icon({
            style_class: 'dash-window-thumbnail-icon',
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._icon);

        this._cloneBox = new SizedActor({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_child(this._cloneBox);

        this._title = new St.Label({
            style_class: 'dash-window-thumbnail-title',
            x_expand: true,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'dash-window-thumbnail-box',
        });
        box.add_child(this._content);
        box.add_child(this._title);
        this.add_child(box);

        const closeButton = new St.Button({
            style_class: 'dash-window-thumbnail-close',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 12,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            can_focus: false,
        });
        closeButton.connect('clicked', () => this._closeWindow());
        this.add_child(closeButton);

        this.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            this._activate();
            return Clutter.EVENT_STOP;
        });

        this._window.connectObject(
            'size-changed', () => this._sync(),
            'notify::minimized', () => this._sync(),
            'notify::title', () => this._sync(),
            this);

        const windowActor = this._window.get_compositor_private();
        windowActor?.connectObject('destroy', () => this._sync(), this);

        this._sync();
    }

    _sync() {
        const window = this._window;

        if (!window || window.is_skip_taskbar()) {
            this.destroy();
            return;
        }

        this._title.text = window.get_title() ?? '';

        if (this._app)
            this._icon.gicon = this._app.get_icon();

        const windowActor = window.get_compositor_private();
        const hasClone = windowActor !== null && !window.minimized;

        if (hasClone) {
            if (!this._clone) {
                this._clone = new Clutter.Clone();
                this._cloneBox.add_child(this._clone);
            }

            this._clone.source = windowActor;
            this._updateCloneSize();
        } else if (this._clone) {
            this._clone.destroy();
            this._clone = null;
            this._cloneBox.setSizedSize(0, 0);
        }

        this._cloneBox.visible = hasClone;
        this._icon.visible = !hasClone;

        if (global.display.focus_window === window)
            this.add_style_class_name('focused');
        else
            this.remove_style_class_name('focused');
    }

    _updateCloneSize() {
        const rect = this._window.get_frame_rect();

        if (rect.width < 1 || rect.height < 1)
            return;

        const scale = Math.min(THUMBNAIL_WIDTH / rect.width,
            THUMBNAIL_HEIGHT / rect.height, 1);

        this._cloneBox.setSizedSize(Math.round(rect.width * scale),
            Math.round(rect.height * scale));
    }

    _activate() {
        Main.activateWindow(this._window, global.get_current_time());
        this.emit('activated');
    }

    _closeWindow() {
        this._window.delete(global.get_current_time());
    }
});

export const WindowPreviewPopup = GObject.registerClass(
class WindowPreviewPopup extends St.Widget {
    _init() {
        super._init({
            style_class: 'dash-window-preview-popup',
            layout_manager: new St.BoxLayout({
                style_class: 'dash-window-preview-list',
            }),
            reactive: true,
            track_hover: true,
            visible: false,
        });

        this._onEnter = null;
        this._onLeave = null;

        this.connect('notify::hover', () => {
            if (this.hover)
                this._onEnter?.();
            else
                this._onLeave?.();
        });

        Main.layoutManager.addChrome(this, {
            affectsStruts: false,
            trackFullscreen: false,
        });
    }

    setCallbacks(onEnter, onLeave) {
        this._onEnter = onEnter;
        this._onLeave = onLeave;
    }

    openFor(actor, placement, windows) {
        this.remove_all_children();

        for (const window of windows) {
            const thumbnail = new WindowThumbnail(window, {
                app: Shell.WindowTracker.get_default().get_window_app(window),
            });
            thumbnail.connect('activated', () => this.close());
            thumbnail.connect('destroy', () => {
                if (this.visible && this.get_n_children() === 0)
                    this.close();
            });
            this.add_child(thumbnail);
        }

        if (this.get_n_children() === 0) {
            this.close();
            return;
        }

        this.show();
        this._position(actor, placement);
    }

    _position(actor, placement) {
        const [actorX, actorY] = actor.get_transformed_position();
        const [actorWidth, actorHeight] = actor.get_transformed_size();

        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);

        const monitor = Main.layoutManager.findMonitorForActor(actor) ??
            Main.layoutManager.primaryMonitor;

        let x, y;
        if (placement === 'right') {
            x = actorX + actorWidth + POPUP_MARGIN;
            y = actorY + actorHeight / 2 - height / 2;
        } else if (placement === 'left') {
            x = actorX - width - POPUP_MARGIN;
            y = actorY + actorHeight / 2 - height / 2;
        } else {
            x = actorX + actorWidth / 2 - width / 2;
            y = actorY - height - POPUP_MARGIN;
        }

        x = Math.round(Math.clamp(x,
            monitor.x + POPUP_MARGIN,
            monitor.x + monitor.width - width - POPUP_MARGIN));
        y = Math.round(Math.clamp(y,
            monitor.y + POPUP_MARGIN,
            monitor.y + monitor.height - height - POPUP_MARGIN));

        this.set_position(x, y);
    }

    close() {
        this.hide();
        this.remove_all_children();
    }
});

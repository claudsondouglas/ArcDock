import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

/* GNOME 49+ moved the cursor enum out of Meta and into Clutter
 * (Meta.Cursor -> Clutter.CursorType, POINTING_HAND -> POINTER) and
 * dropped global.display.set_cursor() in favour of Clutter's
 * set_cursor_type() on the stage. We probe at runtime and use whichever
 * exists, so the same code works across versions. */
function setCursor(clutterName, metaName) {
    if (Clutter.CursorType && global.stage?.set_cursor_type) {
        global.stage.set_cursor_type(Clutter.CursorType[clutterName]);
        return;
    }
    if (Meta.Cursor && global.display?.set_cursor)
        global.display.set_cursor(Meta.Cursor[metaName]);
}

export function setPointer() {
    setCursor('POINTER', 'POINTING_HAND');
}

export function setDefault() {
    setCursor('DEFAULT', 'DEFAULT');
}

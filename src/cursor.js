import Meta from 'gi://Meta';

export function setPointer() {
    global.display.set_cursor(Meta.Cursor.POINTING_HAND);
}

export function setDefault() {
    global.display.set_cursor(Meta.Cursor.DEFAULT);
}

/**
 * A floor product's photo sinking by less than this (mm) because of where its anchor sits is put on
 * the floor; a deeper one is taken to be what the anchor was set to (a photo from above whose anchor
 * is the middle of the footprint). One floating is always put down: nothing holds a floor product up.
 * The 3D room (fixtures.ts) and the 2D projection (room-fixtures.ts) share it.
 */
export const FLOOR_SNAP_MM = 20;
export const FLOOR_SNAP_SHARE = 0.05;

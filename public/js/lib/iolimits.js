/**
 * Adafruit IO datum size ceilings, in bytes of the published value. We assume feed
 * history is OFF (the 512 KB ceiling) as the default setup; the 1 KB history-on tier is
 * recorded here for reference and for refusing a history-on feed for a picture.
 *
 * Here rather than in core/api.js because lib/ code (the feed-image parser, which the
 * server renderer runs too) needs them and may not import from the page. api.js
 * re-exports both, so editor code imports them from where it always did.
 */
export const IO_MAX_HISTORY = 1024;
export const IO_MAX_NO_HISTORY = 512 * 1024;

/**
 * @typedef {[string, ...string[]]} NostrTag
 *
 * @typedef {Object} NostrEvent
 * @property {string} id
 * @property {string} pubkey
 * @property {number} created_at
 * @property {number} kind
 * @property {NostrTag[]} tags
 * @property {string} content
 * @property {string} sig
 *
 * @typedef {Object} BlossomBlob
 * @property {string} sha256
 * @property {string} imgbedId
 * @property {number} size
 * @property {string} type
 * @property {number} uploaded
 */

export const BLOSSOM_EVENT_KIND = 24242;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

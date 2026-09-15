import { getEventHash, verifyEvent } from 'nostr-tools';
import { BlossomError } from './errors.js';
import { BLOSSOM_EVENT_KIND } from './types.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

function isValidTag(tag) {
    return Array.isArray(tag)
        && tag.length >= 2
        && tag.every(value => typeof value === 'string');
}

export function assertEventShape(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new BlossomError(401, 'Malformed Nostr authorization event');
    }
    if (!HEX_64.test(event.id || '') || !HEX_64.test(event.pubkey || '') || !HEX_128.test(event.sig || '')) {
        throw new BlossomError(401, 'Malformed Nostr event id, pubkey, or signature');
    }
    if (!Number.isSafeInteger(event.created_at) || !Number.isSafeInteger(event.kind)) {
        throw new BlossomError(401, 'Malformed Nostr event timestamp or kind');
    }
    if (typeof event.content !== 'string' || !event.content.trim()) {
        throw new BlossomError(401, 'Nostr authorization content must describe the intended action');
    }
    if (!Array.isArray(event.tags) || !event.tags.every(isValidTag)) {
        throw new BlossomError(401, 'Malformed Nostr event tags');
    }
}

export function verifyNostrEvent(event) {
    assertEventShape(event);

    let calculatedId;
    try {
        calculatedId = getEventHash(event);
    } catch {
        throw new BlossomError(401, 'Unable to calculate Nostr event id');
    }
    if (calculatedId !== event.id) {
        throw new BlossomError(401, 'Nostr event id does not match its serialized content');
    }

    try {
        if (!verifyEvent(event)) {
            throw new BlossomError(401, 'Invalid Nostr Schnorr signature');
        }
    } catch (error) {
        if (error instanceof BlossomError) throw error;
        throw new BlossomError(401, 'Invalid Nostr Schnorr signature');
    }

    return event;
}

export function verifyAuthorizationEvent(event) {
    verifyNostrEvent(event);
    if (event.kind !== BLOSSOM_EVENT_KIND) {
        throw new BlossomError(401, `Nostr authorization kind must be ${BLOSSOM_EVENT_KIND}`);
    }
    return event;
}

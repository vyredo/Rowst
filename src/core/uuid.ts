/**
 * Generates RFC4122-compliant v4 UUIDs using cryptographically secure random numbers
 * Zero dependencies - works in Node.js and browser environments
 */

 // Detect environment and get crypto
const getCrypto = (() => {
	let cached: Crypto | null = null;

	return (): Crypto => {
		if (cached) return cached;

		if (typeof globalThis !== "undefined") {
			const candidate = (globalThis as typeof globalThis & { crypto?: Crypto; webcrypto?: Crypto }).crypto ??
				(globalThis as typeof globalThis & { crypto?: Crypto; webcrypto?: Crypto }).webcrypto;

			if (candidate && typeof candidate.getRandomValues === "function") {
				cached = candidate;
				return cached;
			}
		}

		throw new Error("No crypto implementation available");
	};
})();

export function generateUUID(): string {
	const bytes = new Uint8Array(16);
	getCrypto().getRandomValues(bytes);

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	return [
		hex.substring(0, 8),
		hex.substring(8, 12),
		hex.substring(12, 16),
		hex.substring(16, 20),
		hex.substring(20, 32),
	].join("-");
}

export function isValidUUID(uuid: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		uuid,
	);
}

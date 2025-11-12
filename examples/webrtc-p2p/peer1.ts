import {
	AsyncResolver,
	ConsoleTransport,
	Logger,
	LogLevel,
	WebRTCTransport,
} from "../../dist/index.js";

const logger = new Logger({
	level: LogLevel.INFO,
	transports: [new ConsoleTransport()],
	prefix: "Peer1",
});

async function run(): Promise<void> {
	const peer = new RTCPeerConnection({
		iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
	});

	const channel = peer.createDataChannel("rowst-demo", {
		ordered: true,
	});

	const transport = new WebRTCTransport(channel, { logger });
	const resolver = new AsyncResolver(transport, {
		defaultTimeout: 5000,
		logger,
	});

	channel.addEventListener("open", async () => {
		logger.info("Data channel open, sending request");

		const response = await resolver.request<{ pong: string }>({
			action: "ping",
			payload: "hello from peer1",
		});

		logger.info("Peer2 responded", { response });
	});

	peer.onicecandidate = (event) => {
		if (event.candidate) {
			logger.debug("ICE candidate", { candidate: event.candidate.candidate });
		}
	};

	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);

	const encodedOffer = btoa(JSON.stringify(offer));
	logger.info("Share this offer with Peer2 (base64)", { encodedOffer });

	const encodedAnswer = prompt("Paste base64-encoded answer from Peer2:");
	if (!encodedAnswer) {
		throw new Error("No answer provided");
	}

	const answer = JSON.parse(atob(encodedAnswer));
	await peer.setRemoteDescription(answer);
	logger.info("Remote description applied, waiting for channel open");
}

run().catch((error) => {
	logger.error("Peer1 error", {
		error: error instanceof Error ? error.message : error,
	});
});

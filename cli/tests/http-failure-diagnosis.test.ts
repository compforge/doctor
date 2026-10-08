import { expect, test } from "bun:test";
import { diagnoseHttpFailure } from "../src/collect/shared/http/diagnosis";
import type { HttpAttemptObservation, HttpRequestPlan } from "../src/collect/shared/http/model";

const request: HttpRequestPlan = { requestId: "test", entrypointId: "primary", method: "GET", headers: {},
  url: "https://agent.test:8080/chat", expect: { status: [200] }, followRedirects: false, timeoutMs: 1000, maxResponseBytes: 4096 };
function observed(exitCode: number, error: string, statusCode?: number): HttpAttemptObservation {
  return { response: { captureComplete: exitCode === 0, statusCode, error, transport: { engine: "curl", exitCode, error, timings: {} } } } as HttpAttemptObservation;
}

test("DNS failure and TCP reachability failure are distinct; NetworkPolicy is not inferred", () => {
  expect(diagnoseHttpFailure(request, observed(6, "Could not resolve host: agent.test"))?.kind).toBe("dns");
  expect(diagnoseHttpFailure(request, observed(5, "Could not resolve proxy"))?.kind).toBe("proxy-dns");
  expect(diagnoseHttpFailure(request, observed(7, "Failed to connect"))?.kind).toBe("connect");
  expect(diagnoseHttpFailure(request, observed(28, "Operation timed out"))?.kind).toBe("timeout");
});

test("HTTP configured as HTTPS is suspected only with relevant TLS evidence; certificate failure remains separate", () => {
  expect(diagnoseHttpFailure(request, observed(35, "SSL routines:wrong version number"))).toMatchObject({ kind: "scheme-mismatch", certainty: "suspected" });
  expect(diagnoseHttpFailure(request, observed(35, "SSL connect error"))).toMatchObject({ kind: "tls-handshake", certainty: "observed" });
  expect(diagnoseHttpFailure(request, observed(60, "SSL certificate problem: self-signed certificate"))).toMatchObject({ kind: "tls-certificate", certainty: "observed" });
});

test("explicit HTTP-to-HTTPS rejection and ordinary HTTP errors retain their evidence boundary", () => {
  expect(diagnoseHttpFailure({ ...request, url: "http://agent.test" }, observed(0, "", 400), "The plain HTTP request was sent to HTTPS port"))
    .toMatchObject({ kind: "scheme-mismatch", certainty: "observed" });
  expect(diagnoseHttpFailure(request, observed(0, "", 403))?.kind).toBe("http-status");
  expect(diagnoseHttpFailure(request, observed(0, "", 200))).toBeUndefined();
  expect(diagnoseHttpFailure(request, observed(99, "unknown failure"))?.kind).toBe("unknown");
});

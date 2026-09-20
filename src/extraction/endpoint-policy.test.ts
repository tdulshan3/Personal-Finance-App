import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  AddressClass,
  assertEndpointAllowed,
  assertResolvedAddressAllowed,
  classifyHostname,
  createEndpointPolicy,
  DEFAULT_MAX_RESPONSE_BYTES,
  EndpointRejection,
  joinPath,
  redactUrl,
  rejectionReasonOf,
  requestJson,
  type EndpointPolicy,
  type EndpointPolicyInput,
  type FetchLike,
} from "./endpoint-policy.ts";

/** The owner's real deployment shape: a LAN host, explicitly approved, over plain HTTP. */
const APPROVED_LAN: EndpointPolicyInput = {
  baseUrl: "http://192.168.1.118:8081/v1",
  allowedPaths: ["/v1/models", "/v1/chat/completions", "/health", "/props"],
  allowPlaintextHttp: true,
  allowPrivateNetwork: true,
  configLabel: "development-lan",
};

function lanPolicy(): EndpointPolicy {
  return createEndpointPolicy(APPROVED_LAN);
}

function expectRejection(reason: string, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.equal(
      rejectionReasonOf(error),
      reason,
      `expected ${reason}, got ${String(rejectionReasonOf(error))}: ${String(error)}`,
    );
    return;
  }
  assert.fail(`expected the endpoint policy to reject with ${reason}, but nothing was thrown`);
}

async function expectRejectionAsync(reason: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.equal(
      rejectionReasonOf(error),
      reason,
      `expected ${reason}, got ${String(rejectionReasonOf(error))}: ${String(error)}`,
    );
    return;
  }
  assert.fail(`expected the transport to reject with ${reason}, but nothing was thrown`);
}

describe("host classification", () => {
  test("recognises the private, loopback and link-local ranges", () => {
    assert.equal(classifyHostname("192.168.1.118").addressClass, AddressClass.PRIVATE);
    assert.equal(classifyHostname("10.0.0.5").addressClass, AddressClass.PRIVATE);
    assert.equal(classifyHostname("172.16.4.9").addressClass, AddressClass.PRIVATE);
    assert.equal(classifyHostname("172.32.4.9").addressClass, AddressClass.PUBLIC);
    assert.equal(classifyHostname("127.0.0.1").addressClass, AddressClass.LOOPBACK);
    assert.equal(classifyHostname("169.254.10.1").addressClass, AddressClass.LINK_LOCAL);
    assert.equal(classifyHostname("100.64.0.1").addressClass, AddressClass.SHARED_CGNAT);
    assert.equal(classifyHostname("93.184.216.34").addressClass, AddressClass.PUBLIC);
  });

  test("flags every known instance-metadata target", () => {
    assert.equal(classifyHostname("169.254.169.254").isMetadata, true);
    assert.equal(classifyHostname("169.254.170.2").isMetadata, true);
    assert.equal(classifyHostname("100.100.100.200").isMetadata, true);
    assert.equal(classifyHostname("metadata.google.internal").isMetadata, true);
  });

  test("classifies IPv6 literals, including the IPv4-mapped form", () => {
    assert.equal(classifyHostname("[::1]").addressClass, AddressClass.LOOPBACK);
    assert.equal(classifyHostname("[fe80::1]").addressClass, AddressClass.LINK_LOCAL);
    assert.equal(classifyHostname("[fd00::1]").addressClass, AddressClass.UNIQUE_LOCAL);
    assert.equal(classifyHostname("[2606:4700::1111]").addressClass, AddressClass.PUBLIC);

    // ::ffff:169.254.169.254 reaches the metadata service despite looking like a v6 address.
    const mapped = classifyHostname("[::ffff:a9fe:a9fe]");
    assert.equal(mapped.canonical, "169.254.169.254");
    assert.equal(mapped.addressClass, AddressClass.LINK_LOCAL);
    assert.equal(mapped.isMetadata, true);
  });
});

describe("policy construction", () => {
  test("accepts the owner's explicitly approved LAN host over plain HTTP", () => {
    const policy = lanPolicy();
    assert.equal(policy.origin, "http://192.168.1.118:8081");
    assert.equal(policy.scheme, "http");
    assert.equal(policy.host, "192.168.1.118");
    assert.equal(policy.port, 8081);
    assert.equal(policy.basePath, "/v1");
    assert.equal(policy.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  });

  test("refuses the same LAN host when the owner has not approved private networking", () => {
    expectRejection(EndpointRejection.PRIVATE_NETWORK_NOT_APPROVED, () =>
      createEndpointPolicy({ ...APPROVED_LAN, allowPrivateNetwork: false }),
    );
  });

  test("refuses loopback until it is explicitly approved", () => {
    expectRejection(EndpointRejection.LOOPBACK_NOT_APPROVED, () =>
      createEndpointPolicy({
        ...APPROVED_LAN,
        baseUrl: "http://127.0.0.1:11434",
        allowPrivateNetwork: false,
      }),
    );
  });

  test("refuses plain HTTP towards a public host even when plaintext is enabled", () => {
    // buildspec.md §18: plain HTTP is only ever for an approved local/private host.
    expectRejection(EndpointRejection.PLAINTEXT_NOT_APPROVED, () =>
      createEndpointPolicy({ ...APPROVED_LAN, baseUrl: "http://extractor.example.com/v1" }),
    );
  });

  test("refuses plain HTTP to a private host when plaintext is not labelled as approved", () => {
    expectRejection(EndpointRejection.PLAINTEXT_NOT_APPROVED, () =>
      createEndpointPolicy({ ...APPROVED_LAN, allowPlaintextHttp: false }),
    );
  });

  test("allows HTTPS to a public host with no extra approvals", () => {
    const policy = createEndpointPolicy({
      baseUrl: "https://extractor.home.example/v1",
      allowedPaths: ["/v1/models"],
    });
    assert.equal(policy.scheme, "https");
    assert.equal(policy.port, 443);
  });

  test("refuses metadata and link-local hosts no matter what the owner configured", () => {
    for (const baseUrl of [
      "http://169.254.169.254/v1",
      "http://[fd00:ec2::254]/v1",
      "http://metadata.google.internal/v1",
    ]) {
      try {
        createEndpointPolicy({ ...APPROVED_LAN, baseUrl });
        assert.fail(`${baseUrl} should never be configurable`);
      } catch (error) {
        const reason = rejectionReasonOf(error);
        assert.ok(
          reason === EndpointRejection.METADATA_TARGET || reason === EndpointRejection.LINK_LOCAL_TARGET,
          `${baseUrl} was rejected for the wrong reason: ${String(reason)}`,
        );
      }
    }
  });

  test("refuses link-local addresses that are not the metadata one", () => {
    expectRejection(EndpointRejection.LINK_LOCAL_TARGET, () =>
      createEndpointPolicy({ ...APPROVED_LAN, baseUrl: "http://169.254.7.7:8081/v1" }),
    );
  });

  test("refuses credentials embedded in the configured URL", () => {
    expectRejection(EndpointRejection.CREDENTIALS_IN_URL, () =>
      createEndpointPolicy({ ...APPROVED_LAN, baseUrl: "http://user:secret@192.168.1.118:8081/v1" }),
    );
  });

  test("refuses a non-http scheme", () => {
    expectRejection(EndpointRejection.SCHEME_NOT_ALLOWED, () =>
      createEndpointPolicy({ ...APPROVED_LAN, baseUrl: "file:///etc/passwd" }),
    );
  });

  test("refuses a policy that allows nothing", () => {
    expectRejection(EndpointRejection.PATH_NOT_ALLOWED, () =>
      createEndpointPolicy({ ...APPROVED_LAN, allowedPaths: [] }),
    );
  });
});

describe("assertEndpointAllowed", () => {
  test("passes the configured API paths", () => {
    const policy = lanPolicy();
    for (const path of policy.allowedPaths) {
      const url = assertEndpointAllowed(`${policy.origin}${path}`, policy);
      assert.equal(url.pathname, path);
    }
  });

  test("refuses another host on the same LAN", () => {
    const policy = lanPolicy();
    expectRejection(EndpointRejection.HOST_NOT_ALLOWED, () =>
      assertEndpointAllowed("http://192.168.1.119:8081/v1/models", policy),
    );
  });

  test("refuses another port on the configured host", () => {
    const policy = lanPolicy();
    expectRejection(EndpointRejection.PORT_NOT_ALLOWED, () =>
      assertEndpointAllowed("http://192.168.1.118:9999/v1/models", policy),
    );
  });

  test("refuses the metadata service even from an approved private-network policy", () => {
    const policy = lanPolicy();
    expectRejection(EndpointRejection.METADATA_TARGET, () =>
      assertEndpointAllowed("http://169.254.169.254/latest/meta-data/iam/security-credentials/", policy),
    );
  });

  test("refuses an unlisted path on the approved host", () => {
    const policy = lanPolicy();
    for (const path of ["/v1/completions", "/slots", "/api/tags", "/"]) {
      expectRejection(EndpointRejection.PATH_NOT_ALLOWED, () =>
        assertEndpointAllowed(`${policy.origin}${path}`, policy),
      );
    }
  });

  test("refuses traversal, encoded traversal and fragments", () => {
    const policy = lanPolicy();
    expectRejection(EndpointRejection.PATH_TRAVERSAL, () =>
      assertEndpointAllowed("http://192.168.1.118:8081/v1/%2e%2e/%2e%2e/etc/passwd", policy),
    );
    expectRejection(EndpointRejection.PATH_TRAVERSAL, () =>
      assertEndpointAllowed("http://192.168.1.118:8081/v1/../admin", policy),
    );
    expectRejection(EndpointRejection.FRAGMENT_NOT_ALLOWED, () =>
      assertEndpointAllowed("http://192.168.1.118:8081/v1/models#x", policy),
    );
  });

  test("refuses a scheme downgrade or upgrade away from the configured one", () => {
    const httpsPolicy = createEndpointPolicy({
      baseUrl: "https://extractor.home.example/v1",
      allowedPaths: ["/v1/models"],
    });
    expectRejection(EndpointRejection.PLAINTEXT_NOT_APPROVED, () =>
      assertEndpointAllowed("http://extractor.home.example/v1/models", httpsPolicy),
    );
    expectRejection(EndpointRejection.SCHEME_NOT_ALLOWED, () =>
      assertEndpointAllowed("https://192.168.1.118:8081/v1/models", lanPolicy()),
    );
  });

  test("normalises exotic IPv4 spellings before comparing them", () => {
    const loopback = createEndpointPolicy({
      baseUrl: "http://127.0.0.1:8081/v1",
      allowedPaths: ["/v1/models"],
      allowPlaintextHttp: true,
      allowPrivateNetwork: true,
    });
    // 2130706433 and 0x7f000001 are both 127.0.0.1; the parser must not treat them as new hosts.
    assert.equal(assertEndpointAllowed("http://2130706433:8081/v1/models", loopback).hostname, "127.0.0.1");
    assert.equal(assertEndpointAllowed("http://0x7f000001:8081/v1/models", loopback).hostname, "127.0.0.1");
  });

  test("refuses a URL that is not absolute", () => {
    expectRejection(EndpointRejection.MALFORMED_URL, () =>
      assertEndpointAllowed("/v1/models", lanPolicy()),
    );
  });

  test("refuses an oversized query string", () => {
    const policy = lanPolicy();
    expectRejection(EndpointRejection.QUERY_NOT_ALLOWED, () =>
      assertEndpointAllowed(`${policy.origin}/v1/models?q=${"a".repeat(400)}`, policy),
    );
  });
});

describe("assertResolvedAddressAllowed", () => {
  test("rejects a name that resolves into the metadata service", () => {
    const policy = createEndpointPolicy({
      baseUrl: "https://extractor.home.example/v1",
      allowedPaths: ["/v1/models"],
    });
    expectRejection(EndpointRejection.METADATA_TARGET, () =>
      assertResolvedAddressAllowed("169.254.169.254", policy),
    );
    expectRejection(EndpointRejection.PRIVATE_NETWORK_NOT_APPROVED, () =>
      assertResolvedAddressAllowed("10.1.2.3", policy),
    );
  });

  test("accepts a LAN resolution when the owner approved private networking", () => {
    assertResolvedAddressAllowed("192.168.1.118", lanPolicy());
  });
});

describe("transport controls", () => {
  const okBody = JSON.stringify({ data: [] });

  function fakeFetch(handler: (input: string, init: RequestInit) => Response): FetchLike {
    return async (input, init) => handler(input, init);
  }

  test("sends the request without following redirects", async () => {
    let seenRedirectMode: RequestRedirect | undefined;
    const policy = lanPolicy();
    await requestJson(policy, {
      path: "/v1/models",
      fetchImpl: fakeFetch((_input, init) => {
        seenRedirectMode = init.redirect;
        return new Response(okBody, { status: 200, headers: { "content-type": "application/json" } });
      }),
    });
    assert.equal(seenRedirectMode, "error");
  });

  test("refuses a 3xx answer instead of chasing the Location header", async () => {
    const policy = lanPolicy();
    await expectRejectionAsync(EndpointRejection.REDIRECT_REFUSED, () =>
      requestJson(policy, {
        path: "/v1/models",
        fetchImpl: fakeFetch(
          () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }),
        ),
      }),
    );
  });

  test("refuses a body that declares a size over the cap", async () => {
    const policy = createEndpointPolicy({ ...APPROVED_LAN, maxResponseBytes: 512 });
    await expectRejectionAsync(EndpointRejection.RESPONSE_TOO_LARGE, () =>
      requestJson(policy, {
        path: "/v1/models",
        fetchImpl: fakeFetch(
          () => new Response(okBody, { status: 200, headers: { "content-length": "99999" } }),
        ),
      }),
    );
  });

  test("aborts a streamed body once it passes the cap", async () => {
    const policy = createEndpointPolicy({ ...APPROVED_LAN, maxResponseBytes: 1024 });
    await expectRejectionAsync(EndpointRejection.RESPONSE_TOO_LARGE, () =>
      requestJson(policy, {
        path: "/v1/models",
        fetchImpl: fakeFetch(() => {
          // No content-length: the cap has to be enforced while reading.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(256));
              controller.close();
            },
          });
          return new Response(stream, { status: 200 });
        }),
      }),
    );
  });

  test("accepts a body that stays under the cap", async () => {
    const policy = createEndpointPolicy({ ...APPROVED_LAN, maxResponseBytes: 4096 });
    const response = await requestJson(policy, {
      path: "/v1/models",
      fetchImpl: fakeFetch(() => new Response(okBody, { status: 200 })),
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.json, { data: [] });
    assert.equal(response.bytes, Buffer.byteLength(okBody));
  });

  test("gives up when the host never answers", async () => {
    const policy = lanPolicy();
    await expectRejectionAsync(EndpointRejection.TIMEOUT, () =>
      requestJson(policy, {
        path: "/v1/models",
        timeoutMs: 30,
        fetchImpl: (_input, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    );
  });

  test("never requests a path outside the allowlist, even with a crafted path argument", async () => {
    const policy = lanPolicy();
    let called = false;
    await expectRejectionAsync(EndpointRejection.PATH_TRAVERSAL, () =>
      requestJson(policy, {
        path: "/../../etc/passwd",
        fetchImpl: fakeFetch(() => {
          called = true;
          return new Response(okBody, { status: 200 });
        }),
      }),
    );
    assert.equal(called, false, "the transport must refuse before any network call happens");
  });

  test("attaches the bearer token as a header rather than a query parameter", async () => {
    const policy = lanPolicy();
    let seenUrl = "";
    let seenAuth: string | null = null;
    await requestJson(policy, {
      path: "/v1/models",
      headers: { authorization: "Bearer token-abc" },
      fetchImpl: fakeFetch((input, init) => {
        seenUrl = input;
        seenAuth = new Headers(init.headers).get("authorization");
        return new Response(okBody, { status: 200 });
      }),
    });
    assert.equal(seenUrl, "http://192.168.1.118:8081/v1/models");
    assert.equal(seenAuth, "Bearer token-abc");
    assert.ok(!seenUrl.includes("token-abc"));
  });
});

describe("helpers", () => {
  test("joinPath collapses duplicate separators and forces an absolute path", () => {
    assert.equal(joinPath("/v1", "/models"), "/v1/models");
    assert.equal(joinPath("/v1/", "models"), "/v1/models");
    assert.equal(joinPath("", "/health"), "/health");
    assert.equal(joinPath("", "health"), "/health");
  });

  test("redactUrl removes credentials and query strings before logging", () => {
    assert.equal(redactUrl("http://u:p@192.168.1.118:8081/v1/models?key=abc"), "http://192.168.1.118:8081/v1/models");
    assert.equal(redactUrl("not a url"), "<unparseable-url>");
  });
});
